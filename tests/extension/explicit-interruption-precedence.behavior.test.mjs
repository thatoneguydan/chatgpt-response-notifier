import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');

function loadModel() {
  const context = vm.createContext({ Date, Number, String, Set, Map, Object, Math });
  vm.runInContext(readText('extension/status-policy.js'), context);
  vm.runInContext(readText('extension/recovery-model.js'), context);
  return { policy: context.ChatGPTNotifierContinuationPolicy, model: context.ChatGPTNotifierRecoveryModel };
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
    conversationId: 'conversation-1',
    documentId: 'document-1',
    promptKey: 'conversation-1|user-1',
    explicitInterruption: false,
    interruptionKind: '',
    interruptionAttribution: '',
    applicationStateIdentityMatched: true,
    ...overrides
  };
}

function humanRun() {
  return { humanRunId: 'run-1', conversationId: 'conversation-1', originPromptKey: 'conversation-1|user-1', generationActions: 0, state: 'active' };
}

function incident(overrides = {}) {
  return {
    incidentId: 'incident-1',
    humanRunId: 'run-1',
    generationKey: 'conversation-1|conversation-1|user-1',
    reason: 'connection-interrupted',
    ordinal: 1,
    state: 'scheduled',
    budget: {},
    ...overrides
  };
}

function profile() {
  return { breakerOpen: false, activeLease: null, nextProfileActionAt: 0 };
}

test('verified current-request interruption outranks a stale stop-generating affordance', () => {
  const { policy, model } = loadModel();
  const current = observation({
    stopGenerating: true,
    explicitInterruption: true,
    interruptionKind: 'connection-interrupted',
    interruptionAttribution: 'current-turn'
  });

  assert.equal(policy.isCurrentExplicitInterruption(current), true);
  assert.deepEqual(
    { ...policy.classifyObservation(current) },
    { state: 'attention', reason: 'connection-interrupted', automaticActionAllowed: false, recoveryCandidate: true }
  );
  assert.equal(model.observationVeto(current), '');
  assert.deepEqual(
    { ...model.recoveryCandidate(policy.classifyObservation(current), current, incident()) },
    { kind: 'reload', reason: 'connection-interrupted' }
  );
  assert.equal(
    model.admissionDecision('reload', humanRun(), incident(), profile(), current, { now: 1_000, recoveryEnabled: true }).allowed,
    true
  );
});

test('verified current-request timeout also outranks stale tool activity', () => {
  const { policy, model } = loadModel();
  const current = observation({
    toolActivity: true,
    explicitInterruption: true,
    interruptionKind: 'timed-out',
    interruptionAttribution: 'current-request-global'
  });

  assert.equal(policy.classifyObservation(current).reason, 'timed-out');
  assert.equal(model.observationVeto(current), '');
  assert.equal(model.recoveryCandidate(policy.classifyObservation(current), current, incident({ reason: 'timed-out' })).kind, 'reload');
});

test('unverified or historical interruption never overrides active generation', () => {
  const { policy, model } = loadModel();
  for (const current of [
    observation({ stopGenerating: true, explicitInterruption: true, interruptionKind: 'connection-interrupted', interruptionAttribution: 'page-global' }),
    observation({ stopGenerating: true, explicitInterruption: true, interruptionKind: 'connection-interrupted', interruptionAttribution: 'current-turn', applicationStateIdentityMatched: false }),
    observation({ stopGenerating: true, explicitInterruption: true, interruptionKind: 'unknown-error', interruptionAttribution: 'current-turn' })
  ]) {
    assert.equal(policy.isCurrentExplicitInterruption(current), false);
    assert.equal(policy.classifyObservation(current).reason, 'generation-active');
    assert.equal(model.observationVeto(current), 'generation-active');
  }
});

test('higher-priority human and safety vetoes still block verified interruption recovery', () => {
  const { policy, model } = loadModel();
  const base = {
    stopGenerating: true,
    explicitInterruption: true,
    interruptionKind: 'connection-interrupted',
    interruptionAttribution: 'current-turn'
  };
  const vetoes = [
    ['manualStopped', 'manual-stop'],
    ['authRequired', 'auth-required'],
    ['approvalRequired', 'approval-required'],
    ['rateLimited', 'rate-limited'],
    ['hasDraft', 'draft-present'],
    ['hasUpload', 'upload-present']
  ];

  for (const [field, reason] of vetoes) {
    const current = observation({ ...base, [field]: true });
    assert.equal(policy.classifyObservation(current).reason, reason, field);
    assert.equal(model.observationVeto(current), reason, field);
    assert.equal(
      model.admissionDecision('reload', humanRun(), incident(), profile(), current, { now: 1_000, recoveryEnabled: true }).allowed,
      false,
      field
    );
  }
});

test('stale interruption memory does not override genuine resumed generation once the banner disappears', () => {
  const { policy, model } = loadModel();
  const interrupted = observation({
    stopGenerating: true,
    explicitInterruption: true,
    interruptionKind: 'connection-interrupted',
    interruptionAttribution: 'current-turn'
  });
  assert.equal(policy.classifyObservation(interrupted).reason, 'connection-interrupted');

  const resumed = observation({ stopGenerating: true, explicitInterruption: false, interruptionKind: '', interruptionAttribution: '' });
  assert.equal(policy.classifyObservation(resumed).reason, 'generation-active');
  assert.equal(model.observationVeto(resumed), 'generation-active');
});
