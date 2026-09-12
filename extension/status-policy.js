'use strict';

(() => {
  const RUNTIME_VERSION = 2;
  if (globalThis.ChatGPTNotifierContinuationPolicy?.runtimeVersion === RUNTIME_VERSION) return;

  const MONITOR_POLICY_VERSION = 2;
  const MISSING_FOOTER_GRACE_MS = 30_000;
  const SILENT_IDLE_FIRST_MS = 90_000;
  const SILENT_IDLE_CONFIRM_MS = 30_000;
  const LONG_THINKING_DIAGNOSTIC_MS = 15 * 60_000;
  const RUN_GENERATION_ACTION_CAP = 12;
  const PROFILE_ACTION_SPACING_MS = 30_000;

  function identityMatches(current, expected) {
    return Boolean(
      current && expected &&
      current.statusCode === 'INCOMPLETE_LIMIT' &&
      current.conversationId === expected.conversationId &&
      current.documentId === expected.documentId &&
      current.promptKey === expected.promptKey &&
      current.assistantKey === expected.assistantKey &&
      current.revision === expected.revision
    );
  }

  function userInteractionBlockReason({
    composerText = '',
    documentFocused = false,
    documentVisible = false,
    lastTrustedInteractionAt = 0,
    now = Date.now(),
    guardMs = 3000
  } = {}) {
    if (String(composerText || '').trim()) return 'composer-not-empty';
    if (!documentFocused || !documentVisible) return '';
    const interactedAt = Number(lastTrustedInteractionAt || 0);
    if (interactedAt > 0 && Number(now) - interactedAt <= Number(guardMs)) return 'active-user-interaction';
    return '';
  }

  function continuationOutcome({ pageTurnConfirmed = false, requestAccepted = false, sameConversation = false } = {}) {
    if (!sameConversation) return { accepted: false, reason: 'conversation-changed-after-action' };
    if (!pageTurnConfirmed) return { accepted: false, reason: 'continuation-user-turn-not-confirmed' };
    if (!requestAccepted) return { accepted: false, reason: 'request-unconfirmed' };
    return { accepted: true, reason: 'continuation-confirmed' };
  }

  function classifyObservation(observation = {}) {
    const validStatus = Boolean(observation.statusCode && globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(observation.statusCode));
    if (observation.observable === false) return { state: 'attention', reason: 'page-unobservable', automaticActionAllowed: false };
    if (observation.online === false) return { state: 'waiting', reason: 'offline', automaticActionAllowed: false };
    if (observation.manualStopped === true) return { state: 'paused', reason: 'manual-stop', automaticActionAllowed: false };
    if (observation.authRequired === true) return { state: 'attention', reason: 'auth-required', automaticActionAllowed: false };
    if (observation.approvalRequired === true) return { state: 'attention', reason: 'approval-required', automaticActionAllowed: false };
    if (observation.rateLimited === true) return { state: 'attention', reason: 'rate-limited', automaticActionAllowed: false, openProfileBreaker: true };
    if (observation.hasDraft === true) return { state: 'paused', reason: 'draft-present', automaticActionAllowed: false };
    if (observation.hasUpload === true) return { state: 'paused', reason: 'upload-present', automaticActionAllowed: false };
    if (observation.stopGenerating === true || observation.toolActivity === true) {
      return { state: 'working', reason: observation.toolActivity ? 'tool-activity' : 'generation-active', automaticActionAllowed: false };
    }
    if (validStatus) return { state: 'coded-terminal', reason: String(observation.statusCode), automaticActionAllowed: observation.statusCode === 'INCOMPLETE_LIMIT' };
    if (observation.explicitInterruption === true) return { state: 'attention', reason: String(observation.interruptionKind || 'explicit-interruption'), automaticActionAllowed: false, recoveryCandidate: true };
    if (observation.assistantKey && observation.stableTerminal === true) {
      return { state: 'attention', reason: 'status-missing', automaticActionAllowed: false, formatRepairCandidate: true };
    }
    if (!observation.assistantKey && Number(observation.silentIdleConfirmations || 0) >= 2) {
      return { state: 'attention', reason: 'silent-stop-confirmed', automaticActionAllowed: false, recoveryCandidate: true };
    }
    if (Number(observation.workingDurationMs || 0) >= LONG_THINKING_DIAGNOSTIC_MS) {
      return { state: 'waiting', reason: 'long-thinking-diagnostic', automaticActionAllowed: false };
    }
    return { state: 'waiting', reason: 'awaiting-visible-outcome', automaticActionAllowed: false };
  }

  function normalizeBudget(value = {}) {
    return {
      runGenerationActions: Math.max(0, Number(value.runGenerationActions || 0)),
      reloads: Math.max(0, Number(value.reloads || 0)),
      continuations: Math.max(0, Number(value.continuations || 0)),
      formatRepairs: Math.max(0, Number(value.formatRepairs || 0)),
      automaticMessages: Math.max(0, Number(value.automaticMessages || 0)),
      uncertainAction: value.uncertainAction === true,
      breakerOpen: value.breakerOpen === true,
      nextProfileActionAt: Math.max(0, Number(value.nextProfileActionAt || 0))
    };
  }

  function recoveryActionDecision(kind, budgetValue = {}, options = {}) {
    const budget = normalizeBudget(budgetValue);
    const now = Number(options.now || Date.now());
    if (budget.uncertainAction) return { allowed: false, reason: 'prior-action-uncertain', budget };
    if (budget.breakerOpen) return { allowed: false, reason: 'profile-breaker-open', budget };
    if (budget.runGenerationActions >= RUN_GENERATION_ACTION_CAP) return { allowed: false, reason: 'run-action-cap-reached', budget };
    if (now < budget.nextProfileActionAt) return { allowed: false, reason: 'profile-action-spacing', budget };
    if (kind === 'reload' && budget.reloads >= 1) return { allowed: false, reason: 'incident-reload-cap-reached', budget };
    if (kind === 'continue' && budget.continuations >= 1) return { allowed: false, reason: 'incident-continuation-cap-reached', budget };
    if (kind === 'format-repair' && budget.formatRepairs >= 1) return { allowed: false, reason: 'incident-format-repair-cap-reached', budget };
    if ((kind === 'continue' || kind === 'format-repair') && budget.automaticMessages >= 2) {
      return { allowed: false, reason: 'incident-message-cap-reached', budget };
    }
    if (!['reload', 'continue', 'format-repair'].includes(kind)) return { allowed: false, reason: 'unknown-recovery-action', budget };
    return { allowed: true, reason: 'allowed', budget };
  }

  function beginRecoveryAction(kind, budgetValue = {}, options = {}) {
    const decision = recoveryActionDecision(kind, budgetValue, options);
    if (!decision.allowed) return decision;
    const now = Number(options.now || Date.now());
    const next = { ...decision.budget, nextProfileActionAt: now + PROFILE_ACTION_SPACING_MS };
    if (kind === 'reload') next.reloads += 1;
    if (kind === 'continue') {
      next.continuations += 1;
      next.automaticMessages += 1;
      next.runGenerationActions += 1;
    }
    if (kind === 'format-repair') {
      next.formatRepairs += 1;
      next.automaticMessages += 1;
      next.runGenerationActions += 1;
    }
    return { allowed: true, reason: 'action-started', budget: next };
  }

  globalThis.ChatGPTNotifierContinuationPolicy = Object.freeze({
    runtimeVersion: RUNTIME_VERSION,
    monitorPolicyVersion: MONITOR_POLICY_VERSION,
    thresholds: Object.freeze({
      missingFooterGraceMs: MISSING_FOOTER_GRACE_MS,
      silentIdleFirstMs: SILENT_IDLE_FIRST_MS,
      silentIdleConfirmMs: SILENT_IDLE_CONFIRM_MS,
      longThinkingDiagnosticMs: LONG_THINKING_DIAGNOSTIC_MS,
      runGenerationActionCap: RUN_GENERATION_ACTION_CAP,
      profileActionSpacingMs: PROFILE_ACTION_SPACING_MS
    }),
    identityMatches,
    userInteractionBlockReason,
    continuationOutcome,
    classifyObservation,
    normalizeBudget,
    recoveryActionDecision,
    beginRecoveryAction
  });
})();