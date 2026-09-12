import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');

function loadModel() {
  const context = vm.createContext({ Date, Number, String, Set, Object, Math });
  vm.runInContext(readText('extension/status-policy.js'), context);
  vm.runInContext(readText('extension/recovery-model.js'), context);
  return {
    policy: context.ChatGPTNotifierContinuationPolicy,
    model: context.ChatGPTNotifierRecoveryModel
  };
}

function baseObservation(overrides = {}) {
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
  return {
    breakerOpen: false,
    activeLease: null,
    nextProfileActionAt: 0,
    ...overrides
  };
}

test('recovery is separately opt-in while normal INCOMPLETE_LIMIT continuation remains independently admissible', () => {
  const { model } = loadModel();
  const recovery = model.admissionDecision('reload', humanRun(), incident(), profile(), baseObservation(), { now: 1_000, recoveryEnabled: false });
  assert.deepEqual({ allowed: recovery.allowed, reason: recovery.reason }, { allowed: false, reason: 'recovery-not-enabled' });

  const normal = model.admissionDecision('normal-continue', humanRun(), null, profile(), baseObservation(), { now: 1_000, recoveryEnabled: false });
  assert.equal(normal.allowed, true);
});

test('draft, upload, manual stop, auth, approval, rate limit, offline, frozen/unobservable and active generation all fail closed', () => {
  const { model } = loadModel();
  const vetoes = [
    ['hasDraft', 'draft-present'],
    ['hasUpload', 'upload-present'],
    ['manualStopped', 'manual-stop'],
    ['authRequired', 'auth-required'],
    ['approvalRequired', 'approval-required'],
    ['rateLimited', 'rate-limited'],
    ['online', 'offline', false],
    ['observable', 'page-unobservable', false],
    ['stopGenerating', 'generation-active'],
    ['toolActivity', 'tool-activity']
  ];
  for (const [field, reason, value = true] of vetoes) {
    const decision = model.admissionDecision('format-repair', humanRun(), incident({ reason: 'status-missing' }), profile(), baseObservation({ [field]: value }), { now: 1_000, recoveryEnabled: true });
    assert.equal(decision.allowed, false, field);
    assert.equal(decision.reason, reason, field);
  }
});

test('profile-wide lease and action spacing serialize duplicate tabs and concurrent conversations', () => {
  const { model } = loadModel();
  const first = model.claimAction('normal-continue', humanRun(), null, profile(), baseObservation(), { now: 1_000, leaseId: 'lease-a', recoveryEnabled: false });
  assert.equal(first.allowed, true);
  assert.equal(first.profile.activeLease.leaseId, 'lease-a');
  assert.equal(first.profile.nextProfileActionAt, 31_000);

  const duplicate = model.admissionDecision('normal-continue', humanRun({ humanRunId: 'human-2' }), null, first.profile, baseObservation(), { now: 1_001, recoveryEnabled: false });
  assert.deepEqual({ allowed: duplicate.allowed, reason: duplicate.reason }, { allowed: false, reason: 'profile-action-in-flight' });

  const finished = model.finishAction(first.humanRun, null, first.profile, { leaseId: 'lease-a', state: 'observing' }, { now: 2_000 });
  const tooSoon = model.admissionDecision('normal-continue', finished.humanRun, null, finished.profile, baseObservation(), { now: 30_999, recoveryEnabled: false });
  assert.equal(tooSoon.reason, 'profile-action-spacing');
  assert.equal(model.admissionDecision('normal-continue', finished.humanRun, null, finished.profile, baseObservation(), { now: 31_000, recoveryEnabled: false }).allowed, true);
});

test('whole human-started run fuse allows exactly twelve generation-producing actions across 100 attempted transitions', () => {
  const { model } = loadModel();
  let run = humanRun();
  let shared = profile();
  let accepted = 0;
  let now = 1_000;

  for (let transition = 0; transition < 100; transition += 1) {
    const claim = model.claimAction('normal-continue', run, null, shared, baseObservation(), {
      now,
      leaseId: `lease-${transition}`,
      recoveryEnabled: false
    });
    if (!claim.allowed) {
      assert.equal(claim.reason, 'run-action-cap-reached');
      continue;
    }
    accepted += 1;
    const finished = model.finishAction(claim.humanRun, null, claim.profile, { leaseId: claim.leaseId, state: 'observing' }, { now: now + 1 });
    run = finished.humanRun;
    shared = finished.profile;
    now = shared.nextProfileActionAt;
  }

  assert.equal(accepted, 12);
  assert.equal(run.generationActions, 12);
  assert.equal(model.admissionDecision('normal-continue', run, null, shared, baseObservation(), { now: now + 1_000_000, recoveryEnabled: false }).reason, 'run-action-cap-reached');
});

test('incident budget permits at most one reload, one recovery continuation, one repair, and two automatic messages', () => {
  const { model } = loadModel();
  let run = humanRun();
  let shared = profile();
  let currentIncident = incident({ reason: 'silent-stop-confirmed' });
  let now = 1_000;

  const reload = model.claimAction('reload', run, currentIncident, shared, baseObservation(), { now, leaseId: 'r', recoveryEnabled: true });
  assert.equal(reload.allowed, true);
  ({ humanRun: run, incident: currentIncident, profile: shared } = model.finishAction(reload.humanRun, reload.incident, reload.profile, { leaseId: 'r', state: 'scheduled' }, { now: now + 1 }));
  now = shared.nextProfileActionAt;
  assert.equal(model.admissionDecision('reload', run, currentIncident, shared, baseObservation(), { now, recoveryEnabled: true }).reason, 'incident-reload-cap-reached');

  currentIncident.reason = 'post-reload-silent-stop';
  const continuation = model.claimAction('continue', run, currentIncident, shared, baseObservation(), { now, leaseId: 'c', recoveryEnabled: true });
  assert.equal(continuation.allowed, true);
  ({ humanRun: run, incident: currentIncident, profile: shared } = model.finishAction(continuation.humanRun, continuation.incident, continuation.profile, { leaseId: 'c', state: 'scheduled' }, { now: now + 1 }));
  now = shared.nextProfileActionAt;
  assert.equal(model.admissionDecision('continue', run, currentIncident, shared, baseObservation(), { now, recoveryEnabled: true }).reason, 'incident-continuation-cap-reached');

  currentIncident.reason = 'status-missing';
  const repair = model.claimAction('format-repair', run, currentIncident, shared, baseObservation({ assistantKey: 'assistant-1', silentIdleConfirmations: 0 }), { now, leaseId: 'f', recoveryEnabled: true });
  assert.equal(repair.allowed, true);
  ({ humanRun: run, incident: currentIncident, profile: shared } = model.finishAction(repair.humanRun, repair.incident, repair.profile, { leaseId: 'f', state: 'scheduled' }, { now: now + 1 }));
  now = shared.nextProfileActionAt;
  assert.equal(model.admissionDecision('format-repair', run, currentIncident, shared, baseObservation({ assistantKey: 'assistant-1', silentIdleConfirmations: 0 }), { now, recoveryEnabled: true }).reason, 'incident-format-repair-cap-reached');
  assert.equal(currentIncident.budget.automaticMessages, 2);
});

test('post-reload state machine never guesses: identity changes and same document require attention', () => {
  const { model } = loadModel();
  const expected = { conversationId: 'conversation-1', promptKey: 'conversation-1|user-1', documentId: 'doc-old' };
  const base = {
    ...baseObservation(),
    conversationId: 'conversation-1',
    promptKey: 'conversation-1|user-1',
    documentId: 'doc-new',
    statusCode: '',
    stableTerminal: false
  };

  assert.equal(model.postReloadDecision({ ...base, conversationId: 'conversation-2' }, expected).reason, 'conversation-changed-after-reload');
  assert.equal(model.postReloadDecision({ ...base, promptKey: 'conversation-1|user-2' }, expected).reason, 'prompt-identity-changed-after-reload');
  assert.equal(model.postReloadDecision({ ...base, documentId: 'doc-old' }, expected).reason, 'document-did-not-change-after-reload');
  assert.deepEqual({ ...model.postReloadDecision({ ...base, statusCode: 'INCOMPLETE_LIMIT' }, expected) }, { kind: '', state: 'resolved', reason: 'coded:INCOMPLETE_LIMIT' });
  assert.deepEqual({ ...model.postReloadDecision({ ...base, assistantKey: 'assistant-1', stableTerminal: true, silentIdleConfirmations: 0 }, expected) }, { kind: 'format-repair', state: 'scheduled', reason: 'status-missing' });
  assert.deepEqual({ ...model.postReloadDecision({ ...base, assistantKey: '', silentIdleConfirmations: 2 }, expected) }, { kind: 'continue', state: 'scheduled', reason: 'post-reload-silent-stop' });
  assert.equal(model.recoveryCandidate({ state: 'attention', reason: 'post-reload-silent-stop' }, base, incident({ reason: 'post-reload-silent-stop', budget: { reloads: 1 } })).kind, 'continue');
});

test('restart never replays an in-flight side effect and uncertainty remains sticky', () => {
  const { model } = loadModel();
  const interrupted = model.restartDisposition(profile({ activeLease: { leaseId: 'x', kind: 'continue' } }), incident({ inFlight: { leaseId: 'x', kind: 'continue' } }));
  assert.deepEqual({ ...interrupted }, { replayAllowed: false, state: 'attention', reason: 'action-interrupted-uncertain' });

  const claimed = model.claimAction('format-repair', humanRun(), incident({ reason: 'status-missing' }), profile(), baseObservation({ assistantKey: 'assistant-1', silentIdleConfirmations: 0 }), { now: 1_000, leaseId: 'uncertain', recoveryEnabled: true });
  const finished = model.finishAction(claimed.humanRun, claimed.incident, claimed.profile, { leaseId: 'uncertain', uncertain: true }, { now: 1_001 });
  assert.equal(finished.incident.budget.uncertainAction, true);
  assert.equal(finished.incident.state, 'attention');
});

test('earliest deadline selects exactly one incident and preserves overdue count without authorizing a burst', () => {
  const { model } = loadModel();
  const selected = model.selectEarliestDeadline([
    incident({ incidentId: 'later', nextEligibleAt: 3_000, createdAt: 2 }),
    incident({ incidentId: 'first', nextEligibleAt: 1_000, createdAt: 1 }),
    incident({ incidentId: 'second-overdue', nextEligibleAt: 2_000, createdAt: 3 })
  ], 5_000);
  assert.deepEqual({ ...selected }, { incidentId: 'first', when: 1_000, due: true, overdueCount: 3 });
});

test('incident timing enforces 30 second first backoff and 120 second later backoff where immediate evidence does not apply', () => {
  const { model } = loadModel();
  assert.equal(model.firstEligibleAt('connection-interrupted', 10_000, 1), 40_000);
  assert.equal(model.firstEligibleAt('connection-interrupted', 10_000, 2), 130_000);
  assert.equal(model.firstEligibleAt('status-missing', 10_000, 1), 10_000);
  assert.equal(model.firstEligibleAt('silent-stop-confirmed', 10_000, 3), 10_000);
});

test('format-repair and continuation commands are exact contract strings and no original-prompt/regenerate path exists', () => {
  const contract = JSON.parse(readText('extension/github-work-status-contract.v1.json'));
  const page = readText('extension/bounded-recovery-script.js');
  assert.ok(page.includes(contract.formatRepairPrompt));
  assert.ok(page.includes("const AUTO_CONTINUE_TEXT = 'continue until you finish or need something from me'"));
  assert.doesNotMatch(page, /\bregenerate\b/i);
  assert.doesNotMatch(page, /originalPrompt|original-prompt|resendPrompt/i);
});
