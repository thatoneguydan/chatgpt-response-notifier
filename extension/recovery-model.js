'use strict';

(() => {
  if (globalThis.ChatGPTNotifierRecoveryModel?.version === 4) return;

  const VERSION = 4;
  const ACTION_KINDS = Object.freeze(['reload', 'continue', 'normal-continue']);
  const ACTION_KIND_SET = new Set(ACTION_KINDS);
  const FIRST_INCIDENT_BACKOFF_MS = 30_000;
  const LATER_INCIDENT_BACKOFF_MS = 120_000;
  const PROFILE_ACTION_SPACING_MS = 30_000;
  const RUN_GENERATION_ACTION_CAP = 12;
  const SILENT_STOP_RELOAD_CAP = 3;
  const EXPLICIT_INTERRUPTION_RELOAD_CAP = 5;
  const EXPLICIT_INTERRUPTION_RETRY_MS = 5 * 60_000;
  const EXPLICIT_RELOAD_REASONS = new Set([
    'connection-interrupted', 'request-error', 'request-rejected', 'timed-out', 'timeout',
    'connection-lost', 'systems-taking-longer', 'generation-error'
  ]);
  const POST_RELOAD_EXPLICIT_REASON = 'post-reload-explicit-interruption';

  const number = (value) => Math.max(0, Number(value || 0));
  const policyThreshold = (name, fallback) => Math.max(0, Number(globalThis.ChatGPTNotifierContinuationPolicy?.thresholds?.[name] ?? fallback));

  function normalizeHumanRun(value = {}) {
    return {
      humanRunId: String(value.humanRunId || ''),
      conversationId: String(value.conversationId || ''),
      originPromptKey: String(value.originPromptKey || ''),
      originPromptRevision: String(value.originPromptRevision || ''),
      generationActions: number(value.generationActions),
      resumeCount: number(value.resumeCount),
      state: String(value.state || 'active'),
      createdAt: number(value.createdAt),
      updatedAt: number(value.updatedAt)
    };
  }

  function normalizeIncident(value = {}) {
    const policy = globalThis.ChatGPTNotifierContinuationPolicy;
    return {
      incidentId: String(value.incidentId || ''),
      humanRunId: String(value.humanRunId || ''),
      generationKey: String(value.generationKey || ''),
      reason: String(value.reason || ''),
      ordinal: Math.max(1, Number(value.ordinal || 1)),
      state: String(value.state || 'scheduled'),
      budget: policy?.normalizeBudget?.(value.budget || {}) || { ...(value.budget || {}) },
      nextEligibleAt: number(value.nextEligibleAt),
      inFlight: value.inFlight && typeof value.inFlight === 'object' ? { ...value.inFlight } : null,
      createdAt: number(value.createdAt),
      updatedAt: number(value.updatedAt)
    };
  }

  function normalizeProfile(value = {}) {
    return {
      breakerOpen: value.breakerOpen === true,
      breakerReason: String(value.breakerReason || ''),
      activeLease: value.activeLease && typeof value.activeLease === 'object' ? { ...value.activeLease } : null,
      nextProfileActionAt: number(value.nextProfileActionAt),
      updatedAt: number(value.updatedAt)
    };
  }

  function observationVeto(observation = {}) {
    if (observation.observable === false) return 'page-unobservable';
    if (observation.online === false) return 'offline';
    if (observation.manualStopped === true) return 'manual-stop';
    if (observation.authRequired === true) return 'auth-required';
    if (observation.approvalRequired === true) return 'approval-required';
    if (observation.rateLimited === true) return 'rate-limited';
    if (observation.hasDraft === true) return 'draft-present';
    if (observation.hasUpload === true) return 'upload-present';
    const verifiedInterruption = globalThis.ChatGPTNotifierContinuationPolicy?.isCurrentExplicitInterruption?.(observation) === true;
    if (!verifiedInterruption && observation.stopGenerating === true) return 'generation-active';
    if (!verifiedInterruption && observation.toolActivity === true) return 'tool-activity';
    return '';
  }

  function recoveryCandidate(classification = {}, observation = {}, incidentValue = {}) {
    const incident = normalizeIncident(incidentValue);
    const veto = observationVeto(observation);
    if (veto) return { kind: '', reason: veto };
    if (classification.state === 'coded-terminal') return { kind: '', reason: 'coded-terminal' };

    const reason = String(classification.reason || incident.reason || '');
    const silentReloadCap = Math.max(1, policyThreshold('silentStopReloadCap', SILENT_STOP_RELOAD_CAP));
    const explicitReloadCap = Math.max(1, policyThreshold('explicitInterruptionReloadCap', EXPLICIT_INTERRUPTION_RELOAD_CAP));
    if (reason === 'status-missing' || reason === 'status-missing-passive') {
      return { kind: '', reason: 'status-missing-passive' };
    }
    if (reason === POST_RELOAD_EXPLICIT_REASON) {
      if (incident.budget.reloads < explicitReloadCap) return { kind: 'reload', reason };
      return incident.budget.continuations >= 1
        ? { kind: '', reason: 'continuation-spent' }
        : { kind: 'continue', reason };
    }
    if (reason === 'post-reload-silent-stop') {
      if (incident.budget.reloads < silentReloadCap) return { kind: 'reload', reason };
      return incident.budget.continuations >= 1
        ? { kind: '', reason: 'continuation-spent' }
        : { kind: 'continue', reason };
    }

    if (EXPLICIT_RELOAD_REASONS.has(reason)) {
      if (incident.budget.reloads < explicitReloadCap) return { kind: 'reload', reason };
      return incident.budget.continuations >= 1
        ? { kind: '', reason: 'continuation-spent' }
        : { kind: 'continue', reason: POST_RELOAD_EXPLICIT_REASON };
    }

    if (reason === 'silent-stop-confirmed') {
      if (incident.budget.reloads < silentReloadCap) return { kind: 'reload', reason };
      if (!observation.assistantKey && Number(observation.silentIdleConfirmations || 0) >= 2) {
        return incident.budget.continuations >= 1
          ? { kind: '', reason: 'continuation-spent' }
          : { kind: 'continue', reason: 'post-reload-silent-stop' };
      }
      return { kind: '', reason: 'post-reload-outcome-ambiguous' };
    }
    return { kind: '', reason: reason || 'no-recovery-candidate' };
  }

  function firstEligibleAt(reason, now, ordinal = 1) {
    const base = number(now);
    if (reason === 'silent-stop-confirmed' || EXPLICIT_RELOAD_REASONS.has(String(reason || ''))) return base;
    return base + (Number(ordinal || 1) <= 1 ? FIRST_INCIDENT_BACKOFF_MS : LATER_INCIDENT_BACKOFF_MS);
  }

  function postReloadScheduleDelay(reason, incidentValue = {}) {
    const incident = normalizeIncident(incidentValue);
    const explicitReloadCap = Math.max(1, policyThreshold('explicitInterruptionReloadCap', EXPLICIT_INTERRUPTION_RELOAD_CAP));
    if (String(reason || '') === POST_RELOAD_EXPLICIT_REASON && incident.budget.reloads < explicitReloadCap) {
      return policyThreshold('explicitInterruptionRetryMs', EXPLICIT_INTERRUPTION_RETRY_MS);
    }
    return policyThreshold('profileActionSpacingMs', PROFILE_ACTION_SPACING_MS);
  }

  function recoveryActionSpacingMs(kind, incidentValue = {}) {
    const incident = normalizeIncident(incidentValue);
    const reason = String(incident.reason || '');
    const explicitReloadCap = Math.max(1, policyThreshold('explicitInterruptionReloadCap', EXPLICIT_INTERRUPTION_RELOAD_CAP));
    const explicitReload = kind === 'reload' && (EXPLICIT_RELOAD_REASONS.has(reason) || reason === POST_RELOAD_EXPLICIT_REASON);
    if (explicitReload && Number(incident.budget.reloads || 0) < explicitReloadCap) {
      return policyThreshold('explicitInterruptionRetryMs', EXPLICIT_INTERRUPTION_RETRY_MS);
    }
    return policyThreshold('profileActionSpacingMs', PROFILE_ACTION_SPACING_MS);
  }

  function selectEarliestDeadline(incidents = [], now = Date.now()) {
    const active = incidents
      .map(normalizeIncident)
      .filter((item) => item.state === 'scheduled' && item.nextEligibleAt > 0)
      .sort((left, right) => left.nextEligibleAt - right.nextEligibleAt || left.createdAt - right.createdAt);
    if (!active.length) return null;
    const first = active[0];
    return {
      incidentId: first.incidentId,
      when: first.nextEligibleAt,
      due: first.nextEligibleAt <= Number(now),
      overdueCount: active.filter((item) => item.nextEligibleAt <= Number(now)).length
    };
  }

  function admissionDecision(kind, humanRunValue, incidentValue, profileValue, observation = {}, options = {}) {
    if (kind === 'format-repair') return { allowed: false, reason: 'format-repair-retired' };
    if (!ACTION_KIND_SET.has(String(kind || ''))) return { allowed: false, reason: 'unknown-recovery-action' };
    if (options.recoveryEnabled !== true && kind !== 'normal-continue') return { allowed: false, reason: 'recovery-not-enabled' };
    const veto = observationVeto(observation);
    if (veto) return { allowed: false, reason: veto };

    const humanRun = normalizeHumanRun(humanRunValue);
    const profile = normalizeProfile(profileValue);
    const now = Number(options.now ?? Date.now());
    if (profile.breakerOpen) return { allowed: false, reason: 'profile-breaker-open' };
    if (profile.activeLease) return { allowed: false, reason: 'profile-action-in-flight' };
    if (profile.nextProfileActionAt > now) return { allowed: false, reason: 'profile-action-spacing' };
    if (humanRun.generationActions >= RUN_GENERATION_ACTION_CAP && kind !== 'reload') return { allowed: false, reason: 'run-action-cap-reached' };

    if (kind === 'normal-continue') return { allowed: true, reason: 'normal-continuation-admitted' };

    const incident = normalizeIncident(incidentValue);
    const policy = globalThis.ChatGPTNotifierContinuationPolicy;
    const budget = {
      ...incident.budget,
      runGenerationActions: humanRun.generationActions,
      breakerOpen: profile.breakerOpen,
      nextProfileActionAt: profile.nextProfileActionAt
    };
    return policy?.recoveryActionDecision?.(kind, budget, { now }) || { allowed: false, reason: 'recovery-policy-unavailable' };
  }

  function claimAction(kind, humanRunValue, incidentValue, profileValue, observation = {}, options = {}) {
    const decision = admissionDecision(kind, humanRunValue, incidentValue, profileValue, observation, options);
    if (!decision.allowed) return { ...decision };

    const humanRun = normalizeHumanRun(humanRunValue);
    const incident = kind === 'normal-continue' ? normalizeIncident(incidentValue || {}) : normalizeIncident(incidentValue);
    const profile = normalizeProfile(profileValue);
    const now = Number(options.now ?? Date.now());
    const leaseId = String(options.leaseId || '');
    if (!leaseId) return { allowed: false, reason: 'missing-lease-id' };

    if (kind === 'normal-continue') {
      humanRun.generationActions += 1;
    } else {
      const started = globalThis.ChatGPTNotifierContinuationPolicy?.beginRecoveryAction?.(kind, {
        ...incident.budget,
        runGenerationActions: humanRun.generationActions,
        breakerOpen: profile.breakerOpen,
        nextProfileActionAt: profile.nextProfileActionAt
      }, { now });
      if (!started?.allowed) return { allowed: false, reason: started?.reason || 'recovery-policy-refused' };
      incident.budget = started.budget;
      humanRun.generationActions = Number(started.budget.runGenerationActions || humanRun.generationActions);
      incident.state = 'action-started';
      incident.inFlight = { leaseId, kind, startedAt: now };
      incident.updatedAt = now;
    }

    humanRun.updatedAt = now;
    profile.activeLease = { leaseId, kind, humanRunId: humanRun.humanRunId, incidentId: incident.incidentId || '', claimedAt: now };
    profile.nextProfileActionAt = now + recoveryActionSpacingMs(kind, incident);
    profile.updatedAt = now;
    return { allowed: true, reason: decision.reason, leaseId, humanRun, incident, profile };
  }

  function finishAction(humanRunValue, incidentValue, profileValue, result = {}, options = {}) {
    const humanRun = normalizeHumanRun(humanRunValue);
    const incident = normalizeIncident(incidentValue || {});
    const profile = normalizeProfile(profileValue);
    const now = Number(options.now ?? Date.now());
    const leaseId = String(result.leaseId || '');
    const uncertain = result.uncertain === true;

    if (profile.activeLease && (!leaseId || profile.activeLease.leaseId === leaseId)) profile.activeLease = null;
    profile.updatedAt = now;
    humanRun.updatedAt = now;
    if (incident.incidentId) {
      incident.inFlight = null;
      incident.budget = { ...incident.budget, uncertainAction: uncertain || incident.budget.uncertainAction === true };
      incident.state = uncertain ? 'attention' : String(result.state || 'observing');
      incident.updatedAt = now;
    }
    return { humanRun, incident, profile };
  }

  function restartDisposition(profileValue, incidentValue) {
    const profile = normalizeProfile(profileValue);
    const incident = normalizeIncident(incidentValue || {});
    if (profile.activeLease || incident.inFlight) {
      return { replayAllowed: false, state: 'attention', reason: 'action-interrupted-uncertain' };
    }
    return { replayAllowed: false, state: incident.state || 'observing', reason: 'fresh-inspection-required' };
  }

  function postReloadDecision(observation = {}, expected = {}) {
    if (!observation.conversationId || observation.conversationId !== expected.conversationId) return { kind: '', state: 'attention', reason: 'conversation-changed-after-reload' };
    if (!observation.promptKey || observation.promptKey !== expected.promptKey) return { kind: '', state: 'attention', reason: 'prompt-identity-changed-after-reload' };
    if (expected.documentId && observation.documentId === expected.documentId) return { kind: '', state: 'attention', reason: 'document-did-not-change-after-reload' };
    if (observation.statusCode) return { kind: '', state: 'resolved', reason: `coded:${observation.statusCode}` };
    const verifiedInterruption = globalThis.ChatGPTNotifierContinuationPolicy?.isCurrentExplicitInterruption?.(observation) === true;
    if (!verifiedInterruption && (observation.stopGenerating === true || observation.toolActivity === true)) {
      return { kind: '', state: 'observing', reason: 'work-resumed-after-reload' };
    }
    const veto = observationVeto(observation);
    if (veto) return { kind: '', state: 'paused', reason: veto };
    const classification = globalThis.ChatGPTNotifierContinuationPolicy?.classifyObservation?.(observation) || {};
    if (EXPLICIT_RELOAD_REASONS.has(String(classification.reason || ''))) {
      return { kind: 'reload', state: 'scheduled', reason: POST_RELOAD_EXPLICIT_REASON };
    }
    if (observation.assistantKey && observation.stableTerminal) return { kind: '', state: 'resolved', reason: 'status-missing-passive' };
    if (!observation.assistantKey && Number(observation.silentIdleConfirmations || 0) >= 2) return { kind: 'continue', state: 'scheduled', reason: 'post-reload-silent-stop' };
    return { kind: '', state: 'attention', reason: 'post-reload-outcome-ambiguous' };
  }

  globalThis.ChatGPTNotifierRecoveryModel = Object.freeze({
    version: VERSION,
    actionKinds: ACTION_KINDS,
    explicitReloadReasons: Object.freeze(Array.from(EXPLICIT_RELOAD_REASONS)),
    postReloadExplicitReason: POST_RELOAD_EXPLICIT_REASON,
    thresholds: Object.freeze({
      firstIncidentBackoffMs: FIRST_INCIDENT_BACKOFF_MS,
      laterIncidentBackoffMs: LATER_INCIDENT_BACKOFF_MS,
      profileActionSpacingMs: PROFILE_ACTION_SPACING_MS,
      runGenerationActionCap: RUN_GENERATION_ACTION_CAP,
      silentStopReloadCap: SILENT_STOP_RELOAD_CAP,
      explicitInterruptionReloadCap: EXPLICIT_INTERRUPTION_RELOAD_CAP,
      explicitInterruptionRetryMs: EXPLICIT_INTERRUPTION_RETRY_MS
    }),
    normalizeHumanRun,
    normalizeIncident,
    normalizeProfile,
    observationVeto,
    recoveryCandidate,
    firstEligibleAt,
    postReloadScheduleDelay,
    recoveryActionSpacingMs,
    selectEarliestDeadline,
    admissionDecision,
    claimAction,
    finishAction,
    restartDisposition,
    postReloadDecision
  });
})();
