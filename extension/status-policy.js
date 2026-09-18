'use strict';

(() => {
  const RUNTIME_VERSION = 10;
  if (globalThis.ChatGPTNotifierContinuationPolicy?.runtimeVersion === RUNTIME_VERSION) return;

  const MONITOR_POLICY_VERSION = 7;
  const MISSING_FOOTER_GRACE_MS = 30_000;
  const SILENT_IDLE_FIRST_MS = 90_000;
  const SILENT_IDLE_CONFIRM_MS = 30_000;
  const LONG_THINKING_DIAGNOSTIC_MS = 15 * 60_000;
  const RUN_GENERATION_ACTION_CAP = 12;
  const PROFILE_ACTION_SPACING_MS = 30_000;
  const INCIDENT_RELOAD_HARD_CAP = 5;
  const SILENT_STOP_RELOAD_CAP = 3;
  const EXPLICIT_INTERRUPTION_RELOAD_CAP = 5;
  const EXPLICIT_INTERRUPTION_RETRY_MS = 5 * 60_000;
  const AUTO_CONTINUE_STATUS_CODES = Object.freeze([
    'INCOMPLETE_LIMIT',
    'INCOMPLETE_TOOL_FAILURE',
    'INCOMPLETE_CONTINUE',
    'INCOMPLETE_HANDOFF'
  ]);
  const AUTO_CONTINUE_STATUS_CODE_SET = new Set(AUTO_CONTINUE_STATUS_CODES);
  const EXPLICIT_INTERRUPTION_KINDS = new Set([
    'connection-interrupted', 'request-error', 'request-rejected', 'timed-out', 'timeout',
    'connection-lost', 'systems-taking-longer', 'generation-error'
  ]);
  const CURRENT_INTERRUPTION_ATTRIBUTIONS = new Set(['current-turn', 'current-request-global']);
  const EXPLICIT_INTERRUPTION_STICKY_MS = 5 * 60_000;
  const explicitInterruptionMemory = new Map();
  const APPLICATION_INTERRUPTION_PATTERNS = Object.freeze([
    ['connection-interrupted', /connection interrupted|stream interrupted|response interrupted|network error|connection lost|disconnected|failed to connect/],
    ['systems-taking-longer', /our systems? (?:are )?(?:taking longer|busy|experiencing|under (?:heavy )?load|at capacity|temporarily unavailable)|systems? (?:are )?taking longer|taking longer than expected|high demand|service temporarily unavailable/],
    ['timed-out', /(?:message|response|request|generation)?\s*(?:delivery\s*)?(?:timed out|timeout)|took too long|taking too long/],
    ['generation-error', /response failed|failed to (?:generate|respond|complete)|error (?:generating|while generating|during generation)|something went wrong|there was an error|unable to generate|could(?: not|n't) generate/]
  ]);

  function normalizeApplicationText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function classifyApplicationText(value) {
    const text = normalizeApplicationText(value);
    if (!text) {
      return Object.freeze({
        rateLimited: false,
        authRequired: false,
        approvalRequired: false,
        explicitInterruption: false,
        interruptionKind: ''
      });
    }
    const interruption = APPLICATION_INTERRUPTION_PATTERNS.find(([, pattern]) => pattern.test(text)) || null;
    return Object.freeze({
      rateLimited: /too many requests|rate limit|try again later/.test(text),
      authRequired: /session expired|please log in|please sign in|authentication required/.test(text),
      approvalRequired: /approval required|requires approval|approve this action/.test(text),
      explicitInterruption: Boolean(interruption),
      interruptionKind: interruption?.[0] || ''
    });
  }

  function isAutoContinueStatusCode(value) {
    return AUTO_CONTINUE_STATUS_CODE_SET.has(String(value || ''));
  }

  function isCurrentExplicitInterruption(observation = {}) {
    if (observation.explicitInterruption !== true) return false;
    if (observation.applicationStateIdentityMatched === false) return false;
    const kind = String(observation.interruptionKind || '');
    const attribution = String(observation.interruptionAttribution || '');
    return EXPLICIT_INTERRUPTION_KINDS.has(kind) && CURRENT_INTERRUPTION_ATTRIBUTIONS.has(attribution);
  }

  function identityMatches(current, expected) {
    return Boolean(
      current && expected &&
      isAutoContinueStatusCode(current.statusCode) &&
      (!expected.statusCode || current.statusCode === expected.statusCode) &&
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

  function observationIdentityKey(observation = {}) {
    const conversationId = String(observation.conversationId || '');
    const promptKey = String(observation.promptKey || '');
    return conversationId && promptKey ? `${conversationId}|${promptKey}` : '';
  }

  function withStickyExplicitInterruption(observation = {}) {
    const key = observationIdentityKey(observation);
    if (!key) return observation;
    const now = Date.now();
    const validStatus = Boolean(observation.statusCode && globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(observation.statusCode));
    if (validStatus || observation.manualStopped === true) {
      explicitInterruptionMemory.delete(key);
      return observation;
    }
    if (isCurrentExplicitInterruption(observation)) {
      explicitInterruptionMemory.set(key, {
        interruptionKind: String(observation.interruptionKind || ''),
        interruptionAttribution: String(observation.interruptionAttribution || ''),
        applicationStateIdentityMatched: true,
        documentId: String(observation.documentId || ''),
        observedAt: now
      });
      return observation;
    }
    if (observation.stopGenerating === true || observation.toolActivity === true) {
      explicitInterruptionMemory.delete(key);
      return observation;
    }
    if (observation.explicitInterruption === true) {
      explicitInterruptionMemory.set(key, {
        interruptionKind: String(observation.interruptionKind || 'explicit-interruption'),
        interruptionAttribution: String(observation.interruptionAttribution || ''),
        applicationStateIdentityMatched: observation.applicationStateIdentityMatched,
        documentId: String(observation.documentId || ''),
        observedAt: now
      });
      return observation;
    }
    const prior = explicitInterruptionMemory.get(key);
    if (!prior) return observation;
    if (now - Number(prior.observedAt || 0) > EXPLICIT_INTERRUPTION_STICKY_MS ||
        (prior.documentId && observation.documentId && String(observation.documentId) !== prior.documentId)) {
      explicitInterruptionMemory.delete(key);
      return observation;
    }
    return {
      ...observation,
      explicitInterruption: true,
      interruptionKind: prior.interruptionKind,
      interruptionAttribution: prior.interruptionAttribution,
      applicationStateIdentityMatched: prior.applicationStateIdentityMatched
    };
  }

  function classifyObservation(observationValue = {}) {
    const observation = withStickyExplicitInterruption(observationValue);
    const validStatus = Boolean(observation.statusCode && globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(observation.statusCode));
    if (observation.observable === false) return { state: 'attention', reason: 'page-unobservable', automaticActionAllowed: false };
    if (observation.online === false) return { state: 'waiting', reason: 'offline', automaticActionAllowed: false };
    if (observation.manualStopped === true) return { state: 'paused', reason: 'manual-stop', automaticActionAllowed: false };
    if (observation.authRequired === true) return { state: 'attention', reason: 'auth-required', automaticActionAllowed: false };
    if (observation.approvalRequired === true) return { state: 'attention', reason: 'approval-required', automaticActionAllowed: false };
    if (observation.rateLimited === true) return { state: 'attention', reason: 'rate-limited', automaticActionAllowed: false, openProfileBreaker: true };
    if (observation.hasDraft === true) return { state: 'paused', reason: 'draft-present', automaticActionAllowed: false };
    if (observation.hasUpload === true) return { state: 'paused', reason: 'upload-present', automaticActionAllowed: false };
    if (validStatus) return { state: 'coded-terminal', reason: String(observation.statusCode), automaticActionAllowed: isAutoContinueStatusCode(observation.statusCode) };
    if (isCurrentExplicitInterruption(observation)) {
      return { state: 'attention', reason: String(observation.interruptionKind), automaticActionAllowed: false, recoveryCandidate: true };
    }
    if (observation.stopGenerating === true || observation.toolActivity === true) {
      return { state: 'working', reason: observation.toolActivity ? 'tool-activity' : 'generation-active', automaticActionAllowed: false };
    }
    if (observation.explicitInterruption === true) {
      return { state: 'attention', reason: String(observation.interruptionKind || 'explicit-interruption'), automaticActionAllowed: false, recoveryCandidate: true };
    }
    if (observation.assistantKey && observation.stableTerminal === true) {
      if (String(observation.requestPhase || '') === 'started') {
        return { state: 'waiting', reason: 'awaiting-request-settlement', automaticActionAllowed: false };
      }
      return { state: 'waiting', reason: 'status-missing-passive', automaticActionAllowed: false, formatRepairCandidate: false };
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
    if (kind === 'format-repair') return { allowed: false, reason: 'format-repair-retired', budget };
    if (budget.uncertainAction) return { allowed: false, reason: 'prior-action-uncertain', budget };
    if (budget.breakerOpen) return { allowed: false, reason: 'profile-breaker-open', budget };
    if (budget.runGenerationActions >= RUN_GENERATION_ACTION_CAP) return { allowed: false, reason: 'run-action-cap-reached', budget };
    if (now < budget.nextProfileActionAt) return { allowed: false, reason: 'profile-action-spacing', budget };
    if (kind === 'reload' && budget.reloads >= INCIDENT_RELOAD_HARD_CAP) return { allowed: false, reason: 'incident-reload-cap-reached', budget };
    if (kind === 'continue' && budget.continuations >= 1) return { allowed: false, reason: 'incident-continuation-cap-reached', budget };
    if (kind === 'continue' && budget.automaticMessages >= 2) return { allowed: false, reason: 'incident-message-cap-reached', budget };
    if (!['reload', 'continue'].includes(kind)) return { allowed: false, reason: 'unknown-recovery-action', budget };
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
    return { allowed: true, reason: 'action-started', budget: next };
  }

  globalThis.ChatGPTNotifierContinuationPolicy = Object.freeze({
    runtimeVersion: RUNTIME_VERSION,
    monitorPolicyVersion: MONITOR_POLICY_VERSION,
    autoContinueStatusCodes: AUTO_CONTINUE_STATUS_CODES,
    classifyApplicationText,
    isAutoContinueStatusCode,
    isCurrentExplicitInterruption,
    withStickyExplicitInterruption,
    thresholds: Object.freeze({
      missingFooterGraceMs: MISSING_FOOTER_GRACE_MS,
      silentIdleFirstMs: SILENT_IDLE_FIRST_MS,
      silentIdleConfirmMs: SILENT_IDLE_CONFIRM_MS,
      longThinkingDiagnosticMs: LONG_THINKING_DIAGNOSTIC_MS,
      runGenerationActionCap: RUN_GENERATION_ACTION_CAP,
      profileActionSpacingMs: PROFILE_ACTION_SPACING_MS,
      incidentReloadCap: INCIDENT_RELOAD_HARD_CAP,
      silentStopReloadCap: SILENT_STOP_RELOAD_CAP,
      explicitInterruptionReloadCap: EXPLICIT_INTERRUPTION_RELOAD_CAP,
      explicitInterruptionRetryMs: EXPLICIT_INTERRUPTION_RETRY_MS
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