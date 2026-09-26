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
  return { policy: context.ChatGPTNotifierContinuationPolicy, model: context.ChatGPTNotifierRecoveryModel };
}

function baseObservation(overrides = {}) {
  return {
    observable: true, online: true, manualStopped: false, authRequired: false,
    approvalRequired: false, rateLimited: false, hasDraft: false, hasUpload: false,
    stopGenerating: false, toolActivity: false, assistantKey: '', silentIdleConfirmations: 2,
    ...overrides
  };
}

function humanRun(overrides = {}) {
  return { humanRunId: 'human-1', conversationId: 'conversation-1', originPromptKey: 'conversation-1|user-1', generationActions: 0, state: 'active', ...overrides };
}

function incident(overrides = {}) {
  return { incidentId: 'incident-1', humanRunId: 'human-1', generationKey: 'conversation-1|conversation-1|user-1', reason: 'silent-stop-confirmed', ordinal: 1, state: 'scheduled', budget: {}, ...overrides };
}

function profile(overrides = {}) {
  return { breakerOpen: false, activeLease: null, nextProfileActionAt: 0, ...overrides };
}

test('recovery remains separately opt-in while normal coded continuation remains independently admissible', () => {
  const { model } = loadModel();
  const recovery = model.admissionDecision('reload', humanRun(), incident(), profile(), baseObservation(), { now: 1_000, recoveryEnabled: false });
  assert.deepEqual({ allowed: recovery.allowed, reason: recovery.reason }, { allowed: false, reason: 'recovery-not-enabled' });
  assert.equal(model.admissionDecision('normal-continue', humanRun(), null, profile(), baseObservation(), { now: 1_000, recoveryEnabled: false }).allowed, true);
});

test('all recovery vetoes fail closed before reload', () => {
  const { model } = loadModel();
  const vetoes = [
    ['hasDraft', 'draft-present'], ['hasUpload', 'upload-present'], ['manualStopped', 'manual-stop'],
    ['authRequired', 'auth-required'], ['approvalRequired', 'approval-required'], ['rateLimited', 'rate-limited'],
    ['online', 'offline', false], ['observable', 'page-unobservable', false],
    ['stopGenerating', 'generation-active'], ['toolActivity', 'tool-activity']
  ];
  for (const [field, reason, value = true] of vetoes) {
    const decision = model.admissionDecision('reload', humanRun(), incident(), profile(), baseObservation({ [field]: value }), { now: 1_000, recoveryEnabled: true });
    assert.equal(decision.allowed, false, field);
    assert.equal(decision.reason, reason, field);
  }
});

test('format repair is retired at every primary recovery admission boundary', () => {
  const { policy, model } = loadModel();
  assert.equal(Array.from(model.actionKinds).includes('format-repair'), false);
  assert.equal(model.admissionDecision('format-repair', humanRun(), incident(), profile(), baseObservation(), { now: 1_000, recoveryEnabled: true }).reason, 'format-repair-retired');
  assert.equal(model.claimAction('format-repair', humanRun(), incident(), profile(), baseObservation(), { now: 1_000, leaseId: 'retired', recoveryEnabled: true }).reason, 'format-repair-retired');
  assert.equal(policy.recoveryActionDecision('format-repair', {}, { now: 1_000 }).reason, 'format-repair-retired');
  assert.equal(policy.beginRecoveryAction('format-repair', {}, { now: 1_000 }).reason, 'format-repair-retired');
});

test('profile-wide lease, spacing and whole-run fuse serialize automatic generation actions', () => {
  const { model } = loadModel();
  const first = model.claimAction('normal-continue', humanRun(), null, profile(), baseObservation(), { now: 1_000, leaseId: 'lease-a', recoveryEnabled: false });
  assert.equal(first.allowed, true);
  assert.equal(first.profile.activeLease.leaseId, 'lease-a');
  assert.equal(first.profile.nextProfileActionAt, 31_000);
  assert.equal(model.admissionDecision('normal-continue', humanRun({ humanRunId: 'human-2' }), null, first.profile, baseObservation(), { now: 1_001, recoveryEnabled: false }).reason, 'profile-action-in-flight');
  const finished = model.finishAction(first.humanRun, null, first.profile, { leaseId: 'lease-a', state: 'observing' }, { now: 2_000 });
  assert.equal(model.admissionDecision('normal-continue', finished.humanRun, null, finished.profile, baseObservation(), { now: 30_999, recoveryEnabled: false }).reason, 'profile-action-spacing');

  let run = humanRun();
  let shared = profile();
  let accepted = 0;
  let now = 1_000;
  for (let transition = 0; transition < 100; transition += 1) {
    const claim = model.claimAction('normal-continue', run, null, shared, baseObservation(), { now, leaseId: `lease-${transition}`, recoveryEnabled: false });
    if (!claim.allowed) { assert.equal(claim.reason, 'run-action-cap-reached'); continue; }
    accepted += 1;
    const done = model.finishAction(claim.humanRun, null, claim.profile, { leaseId: claim.leaseId, state: 'observing' }, { now: now + 1 });
    run = done.humanRun;
    shared = done.profile;
    now = shared.nextProfileActionAt;
  }
  assert.equal(accepted, 12);
  assert.equal(run.generationActions, 12);
});

test('silent stop gets one hard-refresh candidate and never a recovery continuation', () => {
  const { model } = loadModel();
  const broken = baseObservation({ assistantKey: '', silentIdleConfirmations: 2 });
  assert.equal(model.thresholds.silentStopReloadCap, 1);
  assert.equal(model.recoveryCandidate({ state: 'attention', reason: 'silent-stop-confirmed' }, broken, incident({ budget: { reloads: 0 } })).kind, 'reload');
  const afterRefresh = model.recoveryCandidate(
    { state: 'attention', reason: 'post-reload-silent-stop' },
    broken,
    incident({ reason: 'post-reload-silent-stop', budget: { reloads: 1, continuations: 0 } })
  );
  assert.deepEqual({ kind: afterRefresh.kind, reason: afterRefresh.reason }, { kind: '', reason: model.watchdogWaitReason });
  assert.equal(Array.from(model.actionKinds).includes('continue'), false);
  assert.equal(model.admissionDecision('continue', humanRun(), incident(), profile(), broken, { now: 1_000, recoveryEnabled: true }).reason, 'unknown-recovery-action');
});

test('explicit interruption gets one hard refresh then yields to the existing watchdog', () => {
  const { policy, model } = loadModel();
  const broken = baseObservation({
    assistantKey: 'assistant-1', silentIdleConfirmations: 0, explicitInterruption: true,
    interruptionKind: 'timed-out', interruptionAttribution: 'current-request-global',
    applicationStateIdentityMatched: true
  });
  const classification = { state: 'attention', reason: 'timed-out' };
  assert.equal(model.firstEligibleAt('timed-out', 10_000, 1), 10_000);
  assert.equal(model.thresholds.explicitInterruptionReloadCap, 1);

  let run = humanRun();
  let shared = profile();
  let currentIncident = incident({ reason: 'timed-out', budget: {} });
  const now = 10_000;
  assert.equal(model.recoveryCandidate(classification, broken, currentIncident).kind, 'reload');
  const reload = model.claimAction('reload', run, currentIncident, shared, broken, { now, leaseId: 'explicit-r-1', recoveryEnabled: true });
  assert.equal(reload.allowed, true);
  assert.equal(reload.incident.budget.reloads, 1);
  ({ humanRun: run, incident: currentIncident, profile: shared } = model.finishAction(reload.humanRun, reload.incident, reload.profile, { leaseId: 'explicit-r-1', state: 'scheduled' }, { now: now + 1 }));
  currentIncident.reason = model.postReloadExplicitReason;

  const afterRefresh = model.recoveryCandidate({ state: 'attention', reason: model.postReloadExplicitReason }, broken, currentIncident);
  assert.deepEqual({ kind: afterRefresh.kind, reason: afterRefresh.reason }, { kind: '', reason: model.watchdogWaitReason });
  assert.equal(currentIncident.budget.reloads, 1);
  assert.equal(Number(currentIncident.budget.continuations || 0), 0);
  assert.equal(policy.recoveryActionDecision('format-repair', {}, { now }).reason, 'format-repair-retired');
});

test('post-reload stale state waits for watchdog while stable or resumed work resolves safely', () => {
  const { model } = loadModel();
  const expected = { conversationId: 'conversation-1', promptKey: 'conversation-1|user-1', documentId: 'doc-old' };
  const base = { ...baseObservation(), conversationId: 'conversation-1', promptKey: 'conversation-1|user-1', documentId: 'doc-new', statusCode: '', stableTerminal: false };
  assert.equal(model.postReloadDecision({ ...base, conversationId: 'conversation-2' }, expected).reason, 'conversation-changed-after-reload');
  assert.equal(model.postReloadDecision({ ...base, promptKey: 'conversation-1|user-2' }, expected).reason, 'prompt-identity-changed-after-reload');
  assert.equal(model.postReloadDecision({ ...base, documentId: 'doc-old' }, expected).reason, 'document-did-not-change-after-reload');
  assert.deepEqual({ ...model.postReloadDecision({ ...base, statusCode: 'INCOMPLETE_LIMIT' }, expected) }, { kind: '', state: 'resolved', reason: 'coded:INCOMPLETE_LIMIT' });
  assert.deepEqual({ ...model.postReloadDecision({ ...base, assistantKey: 'assistant-1', stableTerminal: true, silentIdleConfirmations: 0 }, expected) }, { kind: '', state: 'resolved', reason: 'status-missing-passive' });
  assert.deepEqual({ ...model.postReloadDecision({ ...base, assistantKey: 'assistant-1', stableTerminal: false, silentIdleConfirmations: 0 }, expected) }, { kind: '', state: 'observing', reason: 'response-present-after-reload' });
  assert.deepEqual({ ...model.postReloadDecision({ ...base, assistantKey: '', silentIdleConfirmations: 0 }, expected) }, { kind: '', state: 'attention', reason: 'post-reload-outcome-ambiguous' });
  assert.deepEqual({ ...model.postReloadDecision({ ...base, assistantKey: '', silentIdleConfirmations: 2 }, expected) }, { kind: '', state: 'waiting', reason: model.watchdogWaitReason });
  assert.deepEqual({ ...model.postReloadDecision({
    ...base, assistantKey: 'assistant-1', explicitInterruption: true,
    interruptionKind: 'systems-taking-longer', interruptionAttribution: 'current-request-global', applicationStateIdentityMatched: true
  }, expected) }, { kind: '', state: 'waiting', reason: model.watchdogWaitReason });
  assert.deepEqual({ ...model.postReloadDecision({ ...base, stopGenerating: true, silentIdleConfirmations: 0 }, expected) }, { kind: '', state: 'observing', reason: 'work-resumed-after-reload' });
});

test('restart never replays an in-flight side effect and uncertainty remains sticky', () => {
  const { model } = loadModel();
  const interrupted = model.restartDisposition(profile({ activeLease: { leaseId: 'x', kind: 'reload' } }), incident({ inFlight: { leaseId: 'x', kind: 'reload' } }));
  assert.deepEqual({ ...interrupted }, { replayAllowed: false, state: 'attention', reason: 'action-interrupted-uncertain' });
  const claimed = model.claimAction('reload', humanRun(), incident({ reason: 'silent-stop-confirmed' }), profile(), baseObservation(), { now: 1_000, leaseId: 'uncertain', recoveryEnabled: true });
  assert.equal(claimed.allowed, true);
  const done = model.finishAction(claimed.humanRun, claimed.incident, claimed.profile, { leaseId: 'uncertain', uncertain: true }, { now: 1_001 });
  assert.equal(done.incident.budget.uncertainAction, true);
  assert.equal(done.incident.state, 'attention');
});

test('incident timing keeps passive backoff but begins confirmed recovery immediately', () => {
  const { model } = loadModel();
  assert.equal(model.firstEligibleAt('connection-interrupted', 10_000, 1), 10_000);
  assert.equal(model.firstEligibleAt('timed-out', 10_000, 2), 10_000);
  assert.equal(model.firstEligibleAt('status-missing-passive', 10_000, 1), 40_000);
  assert.equal(model.firstEligibleAt('silent-stop-confirmed', 10_000, 3), 10_000);
});

test('legacy page recovery command remains isolated and is not a bounded-recovery authority', () => {
  const page = readText('extension/bounded-recovery-script.js');
  const attachment = readText('extension/bounded-recovery-attachment-background.js');
  const background = readText('extension/bounded-recovery-background.js');
  assert.match(page, /const RUNTIME_VERSION = 3/);
  assert.match(page, /kind !== 'continue'/);
  assert.match(page, /format-repair-retired/);
  assert.match(attachment, /CHATGPT_BOUNDED_RECOVERY_PING/);
  assert.match(attachment, /ensureRecoveryPageRuntime/);
  assert.doesNotMatch(background, /CHATGPT_BOUNDED_RECOVERY_COMMAND/);
  assert.doesNotMatch(background, /performMessageAction/);
  assert.doesNotMatch(page, /FORMAT_REPAIR_TEXT/);
  assert.doesNotMatch(page, /formatRepairText:/);
  assert.doesNotMatch(page, /\bregenerate\b/i);
});

test('post-refresh interruption fallback persists exact stalled response identity across reloads', () => {
  const content = readText('extension/recovery-live-fix-content.js');
  const background = readText('extension/recovery-live-fix-background.js');
  assert.match(content, /const RUNTIME_VERSION = 5/);
  assert.match(content, /sessionStorage/);
  assert.match(content, /STALLED_RESPONSE_KEY/);
  assert.match(content, /stalledResponseAfterReload/);
  assert.match(content, /post-reload-response-unchanged/);
  assert.match(content, /assistantRevision/);
  assert.match(content, /prior\.documentId/);
  assert.match(background, /const RUNTIME_VERSION = 5/);
});

test('normal coded continuation uses the same timestamp shape instead of plain post-refresh text', () => {
  const status = readText('extension/status-script.js');
  assert.match(status, /const RUNTIME_VERSION = 17/);
  assert.match(status, /const AUTO_CONTINUE_PROMPT = 'Continue until you finish or need something from me\.'/);
  assert.match(status, /function timestampedContinueText/);
  assert.match(status, /month: 'short'/);
  assert.match(status, /day: 'numeric'/);
  assert.match(status, /hour: 'numeric'/);
  assert.match(status, /minute: '2-digit'/);
  assert.match(status, /matchingContinuationUserTurn\(previousKey, expectedText\)/);
  assert.doesNotMatch(status, /const AUTO_CONTINUE_TEXT = 'continue until you finish or need something from me'/);
});

test('coded notification delivery remains persistent and targeted', () => {
  const hook = readText('extension/normal-continuation-budget-hook.js');
  assert.match(hook, /async function observeCodedCompletion/);
  assert.match(hook, /resumePendingObservations\(tabId\)/);
  assert.match(hook, /sender\?\.documentId/);
  assert.match(hook, /enqueueObservation/);
  assert.match(hook, /ChatGPTNotifierStatusCode\?\.isStatusCode/);
  assert.match(hook, /state\.claimTurn\(status, owner\)/);
  assert.match(hook, /queueDurableNotification\(claimedRecord, 'coded-completion-status-observer'\)/);
  assert.match(hook, /chrome\.webRequest\.onCompleted\.addListener/);
  assert.doesNotMatch(hook, /statusBoundToCompletion/);
});
