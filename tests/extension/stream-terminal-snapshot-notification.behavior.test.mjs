import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root), 'utf8');
const source = read('extension/stream-terminal-snapshot-notification-background.js');
const bridge = read('extension/response-stream-status-bridge.js');
const bootstrap = read('extension/diagnostics-bootstrap.js');

function buildContext({ watchdogStartedAt = 123456, watchdogPromptKey = 'conversation-1|user-1' } = {}) {
  const listeners = [];
  const queued = [];
  const diagnostics = [];
  const watchdog = {
    conversationId: 'conversation-1',
    ownerTabId: 7,
    stopped: true,
    stopReason: 'status:BLOCKED_HUMAN',
    deadlineAt: 0,
    lastRequestStartedAt: watchdogStartedAt,
    lastPromptKey: watchdogPromptKey
  };

  const context = vm.createContext({
    console,
    globalThis: null,
    String,
    Number,
    Math,
    Promise,
    Map,
    Object,
    Array,
    setTimeout(fn) { fn(); return 1; },
    ChatGPTNotifierStatusCode: {
      isStatusCode: (code) => code === 'BLOCKED_HUMAN'
    },
    ChatGPTNotifierContinuationPolicy: {
      isDefinitiveStopStatusCode: (code) => code === 'BLOCKED_HUMAN'
    },
    __chatgptNotifierMonitorBackground: {
      chatTargetFromTab(tab) {
        return tab?.id === 7 ? { id: 'conversation-1', url: 'https://chatgpt.com/c/conversation-1', tab } : null;
      },
      getEnrollment: async () => ({ enabled: true, userPaused: false }),
      readCodeWatchdog: async () => watchdog
    },
    __chatgptNotifierTerminalWatchdogAuthority: {
      async queueRenderedNotification(message, sender, target, statusCode, sourceName) {
        queued.push({ message, sender, target, statusCode, sourceName });
        return true;
      }
    },
    __chatgptNotifierDeliveryReliability: {
      record(status, fields) { diagnostics.push({ status, fields }); }
    },
    chrome: {
      runtime: {
        onMessage: { addListener(listener) { listeners.push(listener); } }
      }
    }
  });
  context.globalThis = context;
  return { context, listeners, queued, diagnostics };
}

function terminalMessage(overrides = {}) {
  return {
    type: 'CHATGPT_RESPONSE_STREAM_TERMINAL_STATUS',
    statusCode: 'BLOCKED_HUMAN',
    transport: 'fetch',
    snapshot: {
      conversationId: 'conversation-1',
      documentId: 'monitor-runtime-1',
      promptKey: 'conversation-1|user-1',
      promptRevision: 'prompt-revision-1',
      assistantKey: 'assistant-1',
      assistantRevision: 'assistant-revision-1',
      requestId: 'request-1',
      requestPhase: 'completed',
      requestStartedAt: 123456,
      monitorRuntimeVersion: 12,
      ...(overrides.snapshot || {})
    },
    ...overrides,
    snapshot: {
      conversationId: 'conversation-1',
      documentId: 'monitor-runtime-1',
      promptKey: 'conversation-1|user-1',
      promptRevision: 'prompt-revision-1',
      assistantKey: 'assistant-1',
      assistantRevision: 'assistant-revision-1',
      requestId: 'request-1',
      requestPhase: 'completed',
      requestStartedAt: 123456,
      monitorRuntimeVersion: 12,
      ...(overrides.snapshot || {})
    }
  };
}

const sender = {
  tab: { id: 7, url: 'https://chatgpt.com/c/conversation-1', title: 'Project chat' },
  documentId: 'chrome-doc-1'
};

test('stream bridge forwards bounded monitor identity with a terminal status', () => {
  assert.match(bridge, /__chatgptNotifierMonitorRuntime\?\.snapshot\?\.\(\)/);
  assert.match(bridge, /requestStartedAt:\s*Math\.max/);
  assert.match(bridge, /assistantRevision/);
  assert.match(bridge, /if \(snapshot\) message\.snapshot = snapshot;/);
});

test('exact stream snapshot notification authority loads after watchdog authority and before fallback', () => {
  const watchdogAt = bootstrap.indexOf("importScripts('terminal-watchdog-authority-background.js')");
  const snapshotAt = bootstrap.indexOf("importScripts('stream-terminal-snapshot-notification-background.js')");
  const fallbackAt = bootstrap.indexOf("importScripts('response-stream-terminal-durable-fallback-background.js')");
  assert.ok(watchdogAt >= 0 && snapshotAt > watchdogAt && fallbackAt > snapshotAt);
  assert.doesNotThrow(() => new vm.Script(source));
});

test('queues one notification only after exact stopped watchdog and bridged request identity match', async () => {
  const harness = buildContext();
  vm.runInContext(source, harness.context);
  const runtime = harness.context.__chatgptNotifierStreamTerminalSnapshotNotification;
  assert.equal(runtime.version, 1);

  const result = await runtime.queueExactSnapshotNotification(terminalMessage(), sender);
  assert.equal(result, true);
  assert.equal(harness.queued.length, 1);
  assert.equal(harness.queued[0].statusCode, 'BLOCKED_HUMAN');
  assert.equal(harness.queued[0].sourceName, 'stream-terminal-snapshot-authority');
  assert.equal(harness.queued[0].message.snapshot.requestId, 'request-1');
  assert.equal(harness.queued[0].message.snapshot.requestStartedAt, 123456);
  assert.equal(harness.diagnostics.at(-1).status, 'stream-terminal-snapshot-notification-queued');
  assert.match(harness.diagnostics.at(-1).fields.reason, /watchdog=exact-stopped-request/);
});

test('fails closed when stopped watchdog timestamp does not match the bridged request', async () => {
  const harness = buildContext({ watchdogStartedAt: 123455 });
  vm.runInContext(source, harness.context);

  const result = await harness.context.__chatgptNotifierStreamTerminalSnapshotNotification.queueExactSnapshotNotification(
    terminalMessage(),
    sender
  );
  assert.equal(result, false);
  assert.equal(harness.queued.length, 0);
  assert.equal(harness.diagnostics.at(-1).status, 'stream-terminal-snapshot-notification-unroutable');
});

test('fails closed when exact request identity is absent from the bridged snapshot', async () => {
  const harness = buildContext();
  vm.runInContext(source, harness.context);

  const result = await harness.context.__chatgptNotifierStreamTerminalSnapshotNotification.queueExactSnapshotNotification(
    terminalMessage({ snapshot: { requestId: '' } }),
    sender
  );
  assert.equal(result, false);
  assert.equal(harness.queued.length, 0);
  assert.equal(harness.diagnostics.at(-1).status, 'stream-terminal-snapshot-invalid');
});

test('snapshot notification authority has no ChatGPT traffic or foreground authority', () => {
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|backend-api/);
  assert.doesNotMatch(source, /tabs\.update\([^)]*active:\s*true/);
  assert.doesNotMatch(source, /windows\.update\([^)]*focused:\s*true/);
  assert.match(source, /lastRequestStartedAt/);
  assert.match(source, /lastPromptKey/);
  assert.match(source, /queueRenderedNotification/);
});
