import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');

function loadPolicies() {
  const context = vm.createContext({ Date, Number, String, Set, Object, Math });
  vm.runInContext(readText('extension/status-policy.js'), context);
  vm.runInContext(readText('extension/recovery-model.js'), context);
  vm.runInContext(readText('extension/interrupted-run-evidence-policy.js'), context);
  return {
    continuation: context.ChatGPTNotifierContinuationPolicy,
    recovery: context.ChatGPTNotifierRecoveryModel,
    evidence: context.ChatGPTNotifierInterruptedEvidencePolicy
  };
}

function failedObservation(overrides = {}) {
  return {
    conversationId: 'conversation-1',
    documentId: 'document-1',
    promptKey: 'conversation-1|user-1',
    promptRevision: 'prompt-revision-1',
    assistantKey: 'assistant-1',
    assistantRevision: 'assistant-revision-1',
    statusCode: '',
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
    explicitInterruption: true,
    interruptionKind: 'timed-out',
    interruptionAttribution: 'current-request-global',
    applicationStateIdentityMatched: true,
    requestPhase: 'error',
    requestStartedAt: 5_000,
    requestSettledAt: 9_000,
    silentIdleConfirmations: 0,
    stableTerminal: false,
    ...overrides
  };
}

function humanRun(overrides = {}) {
  return { humanRunId: 'human-1', conversationId: 'conversation-1', originPromptKey: 'conversation-1|user-1', generationActions: 0, state: 'active', ...overrides };
}

function incident(overrides = {}) {
  return { incidentId: 'incident-1', humanRunId: 'human-1', generationKey: 'conversation-1|conversation-1|user-1', reason: 'timed-out', ordinal: 1, state: 'scheduled', budget: {}, ...overrides };
}

function profile(overrides = {}) {
  return { breakerOpen: false, activeLease: null, nextProfileActionAt: 0, ...overrides };
}

test('durable evidence stores only bounded failed-run identity and classification metadata', () => {
  const { continuation, evidence } = loadPolicies();
  const failed = failedObservation({ responseText: 'sensitive response text', promptText: 'sensitive prompt text' });
  const classification = continuation.classifyObservation(failed);
  const captured = evidence.fromObservation(failed, classification, 10_000);
  assert.ok(captured);
  assert.equal(captured.generationKey, 'conversation-1|conversation-1|user-1');
  assert.equal(captured.failureReason, 'timed-out');
  assert.equal(captured.interruptionKind, 'timed-out');
  assert.equal(captured.promptRevision, 'prompt-revision-1');
  assert.equal(captured.assistantKey, 'assistant-1');
  assert.equal(captured.assistantRevision, 'assistant-revision-1');
  assert.equal(captured.requestPhase, 'error');
  assert.equal(captured.requestSettledAt, 9_000);
  assert.equal('responseText' in captured, false);
  assert.equal('promptText' in captured, false);
});

test('same failed assistant remains an explicit interruption after document replacement even when the banner disappears', () => {
  const { continuation, evidence } = loadPolicies();
  const failed = failedObservation();
  const captured = evidence.fromObservation(failed, continuation.classifyObservation(failed), 10_000);
  const afterReload = failedObservation({
    documentId: 'document-2',
    explicitInterruption: false,
    interruptionKind: '',
    interruptionAttribution: '',
    requestPhase: 'unknown',
    requestStartedAt: 0,
    requestSettledAt: 0
  });
  const decision = evidence.evaluate(afterReload, captured, 20_000);
  assert.equal(decision.action, 'patch');
  assert.equal(decision.reason, 'durable-interrupted-run-evidence');
  const patched = { ...afterReload, ...decision.patch };
  const classification = continuation.classifyObservation(patched);
  assert.equal(classification.state, 'attention');
  assert.equal(classification.reason, 'timed-out');
  assert.equal(patched.interruptionAttribution, 'durable-interrupted-run');
});

test('durable evidence clears on response, prompt, terminal-code, or newer-request identity change', () => {
  const { continuation, evidence } = loadPolicies();
  const failed = failedObservation();
  const captured = evidence.fromObservation(failed, continuation.classifyObservation(failed), 10_000);
  const reloaded = failedObservation({ documentId: 'document-2', explicitInterruption: false, interruptionKind: '', requestPhase: 'unknown', requestStartedAt: 0, requestSettledAt: 0 });

  assert.equal(evidence.evaluate({ ...reloaded, assistantRevision: 'assistant-revision-2' }, captured, 20_000).reason, 'assistant-response-changed');
  assert.equal(evidence.evaluate({ ...reloaded, promptRevision: 'prompt-revision-2' }, captured, 20_000).reason, 'prompt-revision-changed');
  assert.equal(evidence.evaluate({ ...reloaded, statusCode: 'COMPLETE_APPLIED' }, captured, 20_000).reason, 'coded-terminal');
  assert.equal(evidence.evaluate({ ...reloaded, requestStartedAt: 10_001 }, captured, 20_000).reason, 'new-request-started');
  assert.equal(evidence.evaluate({ ...reloaded, stopGenerating: true }, captured, 20_000).reason, 'work-resumed');
});

test('current safety vetoes retain evidence but never reassert an interruption into the inspected snapshot', () => {
  const { continuation, evidence } = loadPolicies();
  const failed = failedObservation();
  const captured = evidence.fromObservation(failed, continuation.classifyObservation(failed), 10_000);
  const reloaded = failedObservation({ documentId: 'document-2', explicitInterruption: false, interruptionKind: '', requestPhase: 'unknown', requestStartedAt: 0, requestSettledAt: 0 });
  for (const [field, value, reason] of [
    ['rateLimited', true, 'rate-limited'],
    ['authRequired', true, 'auth-required'],
    ['approvalRequired', true, 'approval-required'],
    ['manualStopped', true, 'manual-stop'],
    ['hasDraft', true, 'draft-present'],
    ['hasUpload', true, 'upload-present'],
    ['online', false, 'offline'],
    ['observable', false, 'page-unobservable']
  ]) {
    const decision = evidence.evaluate({ ...reloaded, [field]: value }, captured, 20_000);
    assert.equal(decision.action, 'retain', field);
    assert.equal(decision.reason, reason, field);
    assert.equal(decision.patch, null, field);
  }
});

test('durable explicit failure survives the bounded five-reload sequence and permits only one recovery Continue', () => {
  const { continuation, recovery, evidence } = loadPolicies();
  const failed = failedObservation();
  const captured = evidence.fromObservation(failed, continuation.classifyObservation(failed), 10_000);
  let run = humanRun();
  let currentIncident = incident();
  let shared = profile();
  let now = 10_000;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const afterReload = failedObservation({
      documentId: `document-${attempt + 1}`,
      explicitInterruption: false,
      interruptionKind: '',
      interruptionAttribution: '',
      requestPhase: 'unknown',
      requestStartedAt: 0,
      requestSettledAt: 0
    });
    const durable = evidence.evaluate(afterReload, captured, now);
    assert.equal(durable.action, 'patch', `durable patch ${attempt}`);
    const inspected = { ...afterReload, ...durable.patch };
    const classification = continuation.classifyObservation(inspected);
    assert.equal(classification.reason, 'timed-out', `classification ${attempt}`);
    assert.equal(recovery.recoveryCandidate(classification, inspected, currentIncident).kind, 'reload', `reload candidate ${attempt}`);
    const claim = recovery.claimAction('reload', run, currentIncident, shared, inspected, {
      now,
      leaseId: `reload-${attempt}`,
      recoveryEnabled: true
    });
    assert.equal(claim.allowed, true, `reload claim ${attempt}`);
    assert.equal(claim.incident.budget.reloads, attempt, `reload budget ${attempt}`);
    const finished = recovery.finishAction(claim.humanRun, claim.incident, claim.profile, {
      leaseId: claim.leaseId,
      state: 'scheduled'
    }, { now: now + 1 });
    run = finished.humanRun;
    currentIncident = { ...finished.incident, reason: recovery.postReloadExplicitReason };
    shared = finished.profile;
    now = shared.nextProfileActionAt;
  }

  const finalReload = failedObservation({ documentId: 'document-final', explicitInterruption: false, interruptionKind: '', requestPhase: 'unknown', requestStartedAt: 0, requestSettledAt: 0 });
  const durable = evidence.evaluate(finalReload, captured, now);
  const inspected = { ...finalReload, ...durable.patch };
  const classification = continuation.classifyObservation(inspected);
  assert.equal(recovery.recoveryCandidate(classification, inspected, currentIncident).kind, 'continue');
  const continuationClaim = recovery.claimAction('continue', run, currentIncident, shared, inspected, {
    now,
    leaseId: 'continue-1',
    recoveryEnabled: true
  });
  assert.equal(continuationClaim.allowed, true);
  const finished = recovery.finishAction(continuationClaim.humanRun, continuationClaim.incident, continuationClaim.profile, {
    leaseId: continuationClaim.leaseId,
    state: 'resolved'
  }, { now: now + 1 });
  assert.equal(finished.incident.budget.continuations, 1);
  assert.equal(recovery.recoveryCandidate(classification, inspected, finished.incident).kind, '');
});

test('production background loads durable evidence before bounded recovery and persists it outside page session state', () => {
  const background = readText('extension/background.js');
  const worker = readText('extension/interrupted-run-evidence-background.js');
  const policyIndex = background.indexOf("'interrupted-run-evidence-policy.js'");
  const evidenceIndex = background.indexOf("'interrupted-run-evidence-background.js'");
  const boundedIndex = background.indexOf("'bounded-recovery-background.js'");
  assert.ok(policyIndex >= 0);
  assert.ok(evidenceIndex > policyIndex);
  assert.ok(boundedIndex > evidenceIndex);
  assert.match(worker, /indexedDB\.open\(DB_NAME, DB_VERSION\)/);
  assert.match(worker, /transaction\.objectStore\(STORE_NAME\)\.put\(evidence\)/);
  assert.match(worker, /transaction\.objectStore\(STORE_NAME\)\.get\(normalizedKey\)/);
  assert.match(worker, /message\?\.type !== 'CHATGPT_MONITOR_QUERY'/);
  assert.match(worker, /message\?\.type !== 'CHATGPT_MONITOR_STATE'/);
  assert.doesNotMatch(worker, /responseText|promptText|responseBody/);
});
