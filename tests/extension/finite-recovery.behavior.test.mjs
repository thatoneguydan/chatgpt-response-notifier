import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');

function loadRecovery() {
  const context = vm.createContext({ Date, Number, String, Set, Object, Math });
  vm.runInContext(readText('extension/status-policy.js'), context);
  vm.runInContext(readText('extension/recovery-model.js'), context);
  return { policy: context.ChatGPTNotifierContinuationPolicy, model: context.ChatGPTNotifierRecoveryModel };
}

function loadTrafficPolicy() {
  const context = vm.createContext({ Date, Number, String, Set, Map, Object, Math, Promise, crypto: { randomUUID: () => 'runtime-1' } });
  vm.runInContext(readText('extension/traffic-safety-background.js'), context);
  return context.ChatGPTNotifierTrafficSafetyPolicy;
}

function loadStatusSummary() {
  const context = vm.createContext({ Date, Number, String, Object, Math });
  vm.runInContext(readText('extension/recovery-status-summary.js'), context);
  return context.ChatGPTNotifierRecoveryStatusSummary;
}

function observation(overrides = {}) {
  return {
    observable: true,
    online: true,
    manualStopped: false,
    authRequired: false,
    approvalRequired: false,
    rateLimited: false,
    hasDraft: false,
    hasUpload: false,
    stopGenerating: false,
    toolActivity: false,
    assistantKey: '',
    silentIdleConfirmations: 2,
    ...overrides
  };
}

function humanRun(overrides = {}) {
  return {
    humanRunId: 'human-1',
    conversationId: 'conversation-1',
    originPromptKey: 'conversation-1|user-1',
    generationActions: 0,
    state: 'active',
    ...overrides
  };
}

function incident(overrides = {}) {
  return {
    incidentId: 'incident-1',
    humanRunId: 'human-1',
    generationKey: 'conversation-1|conversation-1|user-1',
    reason: 'silent-stop-confirmed',
    ordinal: 1,
    state: 'scheduled',
    budget: {},
    ...overrides
  };
}

function profile(overrides = {}) {
  return { breakerOpen: false, breakerReason: '', activeLease: null, nextProfileActionAt: 0, ...overrides };
}

test('explicit interruption always terminates after five reloads and at most one recovery Continue', () => {
  const { model } = loadRecovery();
  const broken = observation({
    assistantKey: 'assistant-1',
    silentIdleConfirmations: 0,
    explicitInterruption: true,
    interruptionKind: 'timed-out',
    interruptionAttribution: 'current-request-global',
    applicationStateIdentityMatched: true
  });
  let run = humanRun();
  let shared = profile();
  let current = incident({ reason: 'timed-out' });
  let now = 10_000;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const classification = { state: 'attention', reason: current.reason };
    const candidate = model.recoveryCandidate(classification, broken, current);
    assert.equal(candidate.kind, 'reload', `attempt ${attempt} must be a reload`);
    const claimed = model.claimAction('reload', run, current, shared, broken, {
      now,
      leaseId: `explicit-reload-${attempt}`,
      recoveryEnabled: true
    });
    assert.equal(claimed.allowed, true);
    assert.equal(claimed.incident.budget.reloads, attempt);
    ({ humanRun: run, incident: current, profile: shared } = model.finishAction(
      claimed.humanRun,
      claimed.incident,
      claimed.profile,
      { leaseId: claimed.leaseId, state: 'scheduled' },
      { now: now + 1 }
    ));
    current.reason = model.postReloadExplicitReason;
    now = shared.nextProfileActionAt;
  }

  const continuationCandidate = model.recoveryCandidate({ state: 'attention', reason: current.reason }, broken, current);
  assert.equal(continuationCandidate.kind, 'continue');
  const continuation = model.claimAction('continue', run, current, shared, broken, {
    now,
    leaseId: 'explicit-continue',
    recoveryEnabled: true
  });
  assert.equal(continuation.allowed, true);
  ({ humanRun: run, incident: current, profile: shared } = model.finishAction(
    continuation.humanRun,
    continuation.incident,
    continuation.profile,
    { leaseId: continuation.leaseId, state: 'resolved' },
    { now: now + 1 }
  ));

  const terminal = model.recoveryCandidate({ state: 'attention', reason: current.reason }, broken, current);
  assert.deepEqual({ kind: terminal.kind, reason: terminal.reason }, { kind: '', reason: 'continuation-spent' });
  assert.equal(current.budget.reloads, 5);
  assert.equal(current.budget.continuations, 1);
  assert.equal(current.budget.automaticMessages, 1);
});

test('silent stop always terminates after three reloads and at most one recovery Continue', () => {
  const { model } = loadRecovery();
  const silent = observation({ assistantKey: '', silentIdleConfirmations: 2 });
  let run = humanRun();
  let shared = profile();
  let current = incident({ reason: 'silent-stop-confirmed' });
  let now = 20_000;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const candidate = model.recoveryCandidate({ state: 'attention', reason: current.reason }, silent, current);
    assert.equal(candidate.kind, 'reload', `silent attempt ${attempt} must be a reload`);
    const claimed = model.claimAction('reload', run, current, shared, silent, {
      now,
      leaseId: `silent-reload-${attempt}`,
      recoveryEnabled: true
    });
    assert.equal(claimed.allowed, true);
    ({ humanRun: run, incident: current, profile: shared } = model.finishAction(
      claimed.humanRun,
      claimed.incident,
      claimed.profile,
      { leaseId: claimed.leaseId, state: 'scheduled' },
      { now: now + 1 }
    ));
    current.reason = 'post-reload-silent-stop';
    now = shared.nextProfileActionAt;
  }

  assert.equal(model.recoveryCandidate({ state: 'attention', reason: current.reason }, silent, current).kind, 'continue');
  const continuation = model.claimAction('continue', run, current, shared, silent, {
    now,
    leaseId: 'silent-continue',
    recoveryEnabled: true
  });
  assert.equal(continuation.allowed, true);
  ({ humanRun: run, incident: current, profile: shared } = model.finishAction(
    continuation.humanRun,
    continuation.incident,
    continuation.profile,
    { leaseId: continuation.leaseId, state: 'resolved' },
    { now: now + 1 }
  ));

  const terminal = model.recoveryCandidate({ state: 'attention', reason: current.reason }, silent, current);
  assert.deepEqual({ kind: terminal.kind, reason: terminal.reason }, { kind: '', reason: 'continuation-spent' });
  assert.equal(current.budget.reloads, 3);
  assert.equal(current.budget.continuations, 1);
});

test('post-reload coded terminal and resumed work end recovery without another action', () => {
  const { model } = loadRecovery();
  const expected = { conversationId: 'conversation-1', promptKey: 'conversation-1|user-1', documentId: 'document-old' };
  const base = {
    ...observation(),
    conversationId: 'conversation-1',
    promptKey: 'conversation-1|user-1',
    documentId: 'document-new',
    assistantKey: 'assistant-1',
    stableTerminal: false,
    silentIdleConfirmations: 0,
    statusCode: ''
  };
  assert.deepEqual({ ...model.postReloadDecision({ ...base, statusCode: 'COMPLETE_APPLIED' }, expected) }, {
    kind: '', state: 'resolved', reason: 'coded:COMPLETE_APPLIED'
  });
  assert.deepEqual({ ...model.postReloadDecision({ ...base, stopGenerating: true }, expected) }, {
    kind: '', state: 'observing', reason: 'work-resumed-after-reload'
  });
});

test('every current safety boundary produces a named stop reason before admission', () => {
  const { model } = loadRecovery();
  const cases = [
    ['observable', false, 'page-unobservable'],
    ['online', false, 'offline'],
    ['manualStopped', true, 'manual-stop'],
    ['authRequired', true, 'auth-required'],
    ['approvalRequired', true, 'approval-required'],
    ['rateLimited', true, 'rate-limited'],
    ['hasDraft', true, 'draft-present'],
    ['hasUpload', true, 'upload-present'],
    ['stopGenerating', true, 'generation-active'],
    ['toolActivity', true, 'tool-activity']
  ];
  for (const [field, value, reason] of cases) {
    const result = model.admissionDecision('reload', humanRun(), incident(), profile(), observation({ [field]: value }), {
      now: 1_000,
      recoveryEnabled: true
    });
    assert.deepEqual({ allowed: result.allowed, reason: result.reason }, { allowed: false, reason }, field);
  }
});

test('restart never replays an uncertain side effect and uncertainty remains a named terminal hold', () => {
  const { model } = loadRecovery();
  const restart = model.restartDisposition(
    profile({ activeLease: { leaseId: 'lease-x', kind: 'continue' } }),
    incident({ inFlight: { leaseId: 'lease-x', kind: 'continue' } })
  );
  assert.deepEqual({ ...restart }, { replayAllowed: false, state: 'attention', reason: 'action-interrupted-uncertain' });

  const claim = model.claimAction('continue', humanRun(), incident({ reason: 'post-reload-silent-stop' }), profile(), observation(), {
    now: 1_000,
    leaseId: 'uncertain-continue',
    recoveryEnabled: true
  });
  assert.equal(claim.allowed, true);
  const finished = model.finishAction(claim.humanRun, claim.incident, claim.profile, {
    leaseId: claim.leaseId,
    uncertain: true,
    state: 'attention'
  }, { now: 1_001 });
  assert.equal(finished.incident.state, 'attention');
  assert.equal(finished.incident.budget.uncertainAction, true);
  assert.equal(model.admissionDecision('continue', finished.humanRun, finished.incident, finished.profile, observation(), {
    now: finished.profile.nextProfileActionAt,
    recoveryEnabled: true
  }).reason, 'prior-action-uncertain');
});

test('recovery Continue counts only after page turn plus matching accepted request evidence', () => {
  const { policy } = loadRecovery();
  assert.deepEqual({ ...policy.continuationOutcome({ pageTurnConfirmed: true, requestAccepted: true, sameConversation: true }) }, {
    accepted: true,
    reason: 'continuation-confirmed'
  });
  assert.deepEqual({ ...policy.continuationOutcome({ pageTurnConfirmed: false, requestAccepted: true, sameConversation: true }) }, {
    accepted: false,
    reason: 'continuation-user-turn-not-confirmed'
  });
  assert.deepEqual({ ...policy.continuationOutcome({ pageTurnConfirmed: true, requestAccepted: false, sameConversation: true }) }, {
    accepted: false,
    reason: 'request-unconfirmed'
  });
  assert.deepEqual({ ...policy.continuationOutcome({ pageTurnConfirmed: true, requestAccepted: true, sameConversation: false }) }, {
    accepted: false,
    reason: 'conversation-changed-after-action'
  });
});

test('profile traffic safety has finite named holds and a surviving five-minute floor', () => {
  const traffic = loadTrafficPolicy();
  const ready = { stateReady: true, hardBreakerOpen: false, humanRunAuthorized: true, originAuthorized: false, lastAutomaticActionAt: 0 };
  assert.equal(traffic.trafficDecision({ ...ready, stateReady: false }, {}, 1_000), 'traffic-safety-state-loading');
  assert.equal(traffic.trafficDecision({ ...ready, hardBreakerOpen: true }, {}, 1_000), 'traffic-breaker-open');
  assert.equal(traffic.trafficDecision(ready, { rateLimited: true }, 1_000), 'rate-limited');
  assert.equal(traffic.trafficDecision({ ...ready, humanRunAuthorized: false }, {}, 1_000), 'runtime-safety-hold');
  assert.equal(traffic.trafficDecision({ ...ready, lastAutomaticActionAt: 1_000 }, {}, 300_999), 'traffic-profile-spacing');
  assert.equal(traffic.trafficDecision({ ...ready, lastAutomaticActionAt: 1_000 }, {}, 301_000), '');
  assert.equal(traffic.profileFloor(1_000), 301_000);
});

test('whole-run fuse remains finite at twelve generation-producing actions', () => {
  const { model } = loadRecovery();
  const result = model.admissionDecision('normal-continue', humanRun({ generationActions: 12 }), null, profile(), observation(), {
    now: 1_000,
    recoveryEnabled: false
  });
  assert.deepEqual({ allowed: result.allowed, reason: result.reason }, { allowed: false, reason: 'run-action-cap-reached' });
});

test('timers only trigger local observation; page-affecting recovery still requires fresh inspection', () => {
  const scheduler = readText('extension/observation-scheduler-background.js');
  const bounded = readText('extension/bounded-recovery-background.js');
  assert.doesNotMatch(scheduler, /chrome\.tabs\.reload|CHATGPT_BOUNDED_RECOVERY_COMMAND/);
  assert.match(scheduler, /CHATGPT_MONITOR_QUERY/);
  assert.match(bounded, /const inspected = await queryTabSnapshot\(generation\.ownerTabId\)[\s\S]*recoveryCandidate\(classification, inspected\.snapshot, incident\)[\s\S]*claimAction\(candidate\.kind/);
});

test('build status projection exposes attempts, next due, governor and blocker without response content', () => {
  const summary = loadStatusSummary();
  const now = 100_000;
  const overview = {
    recovery: {
      humanRun: { generationActions: 4 },
      incident: {
        state: 'scheduled',
        reason: 'post-reload-explicit-interruption',
        nextEligibleAt: 120_000,
        budget: { reloads: 2, continuations: 0, uncertainAction: false }
      },
      profile: { breakerOpen: false, breakerReason: '', nextProfileActionAt: 160_000 }
    }
  };
  const projected = summary.summarize(overview, now);
  assert.deepEqual({
    active: projected.active,
    reloads: projected.reloads,
    continuations: projected.continuations,
    attempts: projected.attempts,
    nextDueAt: projected.nextDueAt,
    nextDuePending: projected.nextDuePending,
    governorAt: projected.governorAt,
    governorHeld: projected.governorHeld,
    blockedReason: projected.blockedReason
  }, {
    active: true,
    reloads: 2,
    continuations: 0,
    attempts: 2,
    nextDueAt: 120_000,
    nextDuePending: true,
    governorAt: 160_000,
    governorHeld: true,
    blockedReason: ''
  });

  const breaker = summary.summarize({ recovery: {
    humanRun: { generationActions: 4 },
    incident: { state: 'attention', reason: 'timed-out', budget: { reloads: 5, continuations: 1, uncertainAction: true } },
    profile: { breakerOpen: true, breakerReason: 'rate-limited', nextProfileActionAt: 0 }
  } }, now);
  assert.equal(breaker.blockedReason, 'rate-limited');
  assert.equal(breaker.uncertain, true);

  const source = readText('extension/recovery-status-summary.js');
  const popup = readText('extension/popup.js');
  const html = readText('extension/popup.html');
  assert.doesNotMatch(source, /promptText|assistantText|responseText|responseBody/);
  assert.match(html, /id="recoveryDetail"/);
  assert.match(html, /recovery-status-summary\.js[\s\S]*popup\.js/);
  assert.match(popup, /ChatGPTNotifierRecoveryStatusSummary\?\.summarize/);
  assert.match(popup, /governor until/);
  assert.match(popup, /blocked —/);
});
