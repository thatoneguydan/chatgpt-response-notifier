import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const worker = readFileSync(new URL('../../extension/service-worker.js', import.meta.url), 'utf8');
const readText = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

function loadVersionSync(currentVersion) {
  const start = worker.indexOf('function parseVersion(value)');
  const end = worker.indexOf('function conversationFromUrl(rawUrl)', start);
  assert.ok(start >= 0 && end > start, 'version-sync functions were not found in service-worker.js');

  const timers = [];
  let reloads = 0;
  const context = vm.createContext({
    chrome: {
      runtime: {
        getManifest: () => ({ version: currentVersion }),
        reload: () => { reloads += 1; }
      }
    },
    setTimeout: (fn, delay) => {
      timers.push({ fn, delay });
      return timers.length;
    }
  });
  vm.runInContext(worker.slice(start, end), context);
  return {
    maybeReload: context.maybeReloadForInstalledVersion,
    timers,
    reloads: () => reloads
  };
}

function loadRecoveryPolicyAndModel() {
  const context = vm.createContext({ console });
  vm.runInContext(readText('extension/status-code.js'), context);
  vm.runInContext(readText('extension/status-policy.js'), context);
  vm.runInContext(readText('extension/recovery-model.js'), context);
  return context;
}

function recoveryObservation(overrides = {}) {
  return {
    conversationId: 'conversation-1',
    promptKey: 'conversation-1|user-1',
    documentId: 'document-1',
    assistantKey: 'assistant-1',
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
    stableTerminal: true,
    requestPhase: 'completed',
    silentIdleConfirmations: 0,
    explicitInterruption: false,
    interruptionKind: '',
    ...overrides
  };
}

test('installed extension version mismatch self-activates both upgrades and rollbacks', () => {
  for (const installedVersion of ['1.0.0', '0.9.7']) {
    const runtime = loadVersionSync('0.9.9');
    assert.equal(runtime.maybeReload(installedVersion), true);
    assert.equal(runtime.timers.length, 1);
    assert.equal(runtime.timers[0].delay, 250);
    assert.equal(runtime.reloads(), 0);
    runtime.timers[0].fn();
    assert.equal(runtime.reloads(), 1);
  }
});

test('same or invalid installed version does not reload the extension runtime', () => {
  for (const installedVersion of ['0.9.9', 'invalid']) {
    const runtime = loadVersionSync('0.9.9');
    assert.equal(runtime.maybeReload(installedVersion), false);
    assert.equal(runtime.timers.length, 0);
    assert.equal(runtime.reloads(), 0);
  }
});

test('both incomplete limit and tool failure are recoverable continuation codes', () => {
  const context = loadRecoveryPolicyAndModel();
  const policy = context.ChatGPTNotifierContinuationPolicy;
  assert.equal(policy.isAutoContinueStatusCode('INCOMPLETE_LIMIT'), true);
  assert.equal(policy.isAutoContinueStatusCode('INCOMPLETE_TOOL_FAILURE'), true);
  assert.equal(policy.isAutoContinueStatusCode('BLOCKED_HUMAN'), false);

  const expected = {
    statusCode: 'INCOMPLETE_TOOL_FAILURE',
    conversationId: 'conversation-1',
    documentId: 'document-1',
    promptKey: 'conversation-1|user-1',
    assistantKey: 'assistant-1',
    revision: 'rev-1'
  };
  assert.equal(policy.identityMatches({ ...expected }, expected), true);
  assert.equal(policy.identityMatches({ ...expected, statusCode: 'INCOMPLETE_LIMIT' }, expected), false);
});

test('explicit interruption outranks missing-footer classification on the same document', () => {
  const context = loadRecoveryPolicyAndModel();
  const policy = context.ChatGPTNotifierContinuationPolicy;
  assert.equal(policy.classifyObservation(recoveryObservation({ explicitInterruption: true, interruptionKind: 'timed-out' })).reason, 'timed-out');
  assert.equal(policy.classifyObservation(recoveryObservation()).reason, 'timed-out');
  assert.equal(policy.classifyObservation(recoveryObservation({ documentId: 'document-2' })).reason, 'status-missing');
});

test('missing-footer repair waits for the ChatGPT request to settle', () => {
  const context = loadRecoveryPolicyAndModel();
  const policy = context.ChatGPTNotifierContinuationPolicy;
  const active = policy.classifyObservation(recoveryObservation({ requestPhase: 'started' }));
  assert.equal(active.state, 'waiting');
  assert.equal(active.reason, 'awaiting-request-settlement');
  const done = policy.classifyObservation(recoveryObservation({ requestPhase: 'completed' }));
  assert.equal(done.reason, 'status-missing');
});

test('explicit transport failures reload once, then continue once if the same failure survives reload', () => {
  const context = loadRecoveryPolicyAndModel();
  const model = context.ChatGPTNotifierRecoveryModel;
  const classification = { state: 'attention', reason: 'timed-out' };
  const broken = recoveryObservation({ explicitInterruption: true, interruptionKind: 'timed-out' });

  assert.equal(model.recoveryCandidate(classification, broken, { budget: { reloads: 0, continuations: 0 } }).kind, 'reload');
  assert.equal(model.firstEligibleAt('timed-out', 1234, 1), 31_234);
  assert.equal(model.recoveryCandidate(classification, broken, { budget: { reloads: 1, continuations: 0 } }).kind, 'continue');
  assert.equal(model.recoveryCandidate(classification, broken, { budget: { reloads: 1, continuations: 1 } }).kind, '');

  const postReload = model.postReloadDecision(
    recoveryObservation({ documentId: 'document-2', explicitInterruption: true, interruptionKind: 'timed-out' }),
    { conversationId: 'conversation-1', promptKey: 'conversation-1|user-1', documentId: 'document-1' }
  );
  assert.equal(postReload.state, 'scheduled');
  assert.equal(postReload.kind, 'continue');
  assert.equal(postReload.reason, 'post-reload-explicit-interruption');
});

test('tool failure coded completion is routed through the existing continuation handler instead of notification', async () => {
  const source = readText('extension/recovery-live-fix-background.js');
  const runtimeListeners = [];
  const tabUpdateListeners = [];
  const queued = [];
  const continued = [];
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    chrome: {
      tabs: {
        sendMessage: async () => ({ ok: false }),
        query: async () => [],
        onUpdated: { addListener: (listener) => tabUpdateListeners.push(listener) }
      },
      scripting: { executeScript: async () => {} },
      runtime: { onMessage: { addListener: (listener) => runtimeListeners.push(listener) } }
    },
    ChatGPTNotifierContinuationPolicy: {
      isAutoContinueStatusCode: (code) => ['INCOMPLETE_LIMIT', 'INCOMPLETE_TOOL_FAILURE'].includes(String(code || ''))
    },
    queueDurableNotification: async (record, reason) => { queued.push({ record, reason }); return 'queued'; },
    handleContinuationClaim: async (record, status, tabId, documentId) => {
      continued.push({ record, status, tabId, documentId });
      return null;
    }
  });
  vm.runInContext(source, context);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const record = {
    statusCode: 'INCOMPLETE_TOOL_FAILURE',
    conversationId: 'conversation-1',
    conversationUrl: 'https://chatgpt.com/c/conversation-1',
    documentId: 'document-1',
    promptKey: 'conversation-1|user-1',
    assistantKey: 'assistant-1',
    revision: 'rev-1',
    ownerTabId: 7,
    ownerDocumentId: 'chrome-document-1'
  };
  await context.queueDurableNotification(record, 'coded-completion');
  assert.equal(continued.length, 1);
  assert.equal(continued[0].status.statusCode, 'INCOMPLETE_TOOL_FAILURE');
  assert.equal(queued.length, 0);

  await context.queueDurableNotification({ ...record, statusCode: 'BLOCKED_HUMAN' }, 'coded-completion');
  assert.equal(queued.length, 1);
});

test('live repair recognizes semantic timeout UI and replays activation state into recovery', () => {
  const background = readText('extension/recovery-live-fix-background.js');
  const content = readText('extension/recovery-live-fix-content.js');
  const control = readText('extension/recovery-control-background.js');

  assert.doesNotThrow(() => new vm.Script(background));
  assert.doesNotThrow(() => new vm.Script(content));

  assert.match(background, /SET_BUILD_AUTOMATION_STATE/);
  assert.match(background, /CHATGPT_RECOVERY_LIVE_REPUBLISH/);
  assert.match(background, /isAutoContinueStatusCode/);
  assert.match(background, /coded-completion-status-observer/);
  assert.match(content, /\[role="alert"\]/);
  assert.match(content, /message delivery timed out/);
  assert.match(content, /connection interrupted/);
  assert.match(content, /CHATGPT_MONITOR_STATE/);
  assert.match(control, /recovery-live-fix-background\.js/);
});
