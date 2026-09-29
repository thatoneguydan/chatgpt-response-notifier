import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('extension/response-stream-terminal-durable-fallback-background.js', root), 'utf8');

function buildContext({ watchdogStartedAt = 123456, watchdogPromptKey = 'conversation-1|user-1' } = {}) {
  const queued = [];
  const reserved = [];
  const diagnostics = [];
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
    crypto: { randomUUID: () => 'notification-bridge-1' },
    ChatGPTNotifierStatusCode: { isStatusCode: (code) => code === 'BLOCKED_HUMAN' },
    ChatGPTNotifierContinuationPolicy: { isDefinitiveStopStatusCode: (code) => code === 'BLOCKED_HUMAN' },
    __chatgptNotifierMonitorBackground: {
      chatTargetFromTab(tab) {
        return tab?.id === 7 ? { id: 'conversation-1', url: 'https://chatgpt.com/c/conversation-1', tab } : null;
      },
      getEnrollment: async () => ({ enabled: true, userPaused: false }),
      readCodeWatchdog: async () => ({
        conversationId: 'conversation-1',
        ownerTabId: 7,
        stopped: true,
        stopReason: 'status:BLOCKED_HUMAN',
        deadlineAt: 0,
        lastRequestStartedAt: watchdogStartedAt,
        lastPromptKey: watchdogPromptKey
      }),
      latestRunForConversation: async () => null
    },
    __chatgptNotifierDeliveryReliability: {
      record(status, fields) { diagnostics.push({ status, fields }); }
    },
    __chatgptNotifierDeliveryDedupeHook: {
      async reserveRequestDelivery(identity, owner) {
        reserved.push({ identity, owner });
        return { reserved: true, deliveryKey: 'request|conversation-1|chrome-doc-1|request-bridge-1' };
      },
      async commitRequestDelivery() { return true; },
      async releaseRequestDelivery() { return true; }
    },
    __chatgptNotifierCoordinator: {
      async queueNotification(turnKey, notification, fingerprint) {
        queued.push({ turnKey, notification, fingerprint });
        return { notificationId: notification.id };
      }
    },
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      tabs: {
        async sendMessage() {
          // Reproduce the live boundary: a later page query no longer has an exact
          // request identity, so only the terminal bridge snapshot can recover it.
          return { ok: true, snapshot: { conversationId: 'conversation-1', promptKey: '', requestId: '', requestStartedAt: 0 } };
        }
      }
    }
  });
  context.globalThis = context;
  return { context, queued, reserved, diagnostics };
}

const sender = {
  tab: { id: 7, url: 'https://chatgpt.com/c/conversation-1', title: 'Project chat' },
  documentId: 'chrome-doc-1'
};

function terminalMessage(snapshotOverrides = {}) {
  return {
    type: 'CHATGPT_RESPONSE_STREAM_TERMINAL_STATUS',
    statusCode: 'BLOCKED_HUMAN',
    snapshot: {
      conversationId: 'conversation-1',
      documentId: 'monitor-runtime-1',
      promptKey: 'conversation-1|user-1',
      requestId: 'request-bridge-1',
      requestPhase: 'completed',
      requestStartedAt: 123456,
      ...snapshotOverrides
    }
  };
}

test('live regression: terminal bridge request identity queues after exact stopped-watchdog match without assistant DOM identity', async () => {
  const harness = buildContext();
  vm.runInContext(source, harness.context);
  const runtime = harness.context.__chatgptNotifierStreamTerminalDurableFallback;
  assert.equal(runtime.version, 3);

  const result = await runtime.handleTerminalStatus(terminalMessage(), sender);

  assert.equal(result, 'notification-bridge-1');
  assert.equal(harness.reserved.length, 1);
  assert.equal(harness.reserved[0].identity.identitySource, 'terminal-bridge-snapshot');
  assert.equal(harness.reserved[0].identity.promptKey, 'conversation-1|user-1');
  assert.equal(harness.reserved[0].identity.requestId, 'request-bridge-1');
  assert.equal(harness.reserved[0].identity.requestStartedAt, 123456);
  assert.equal(harness.reserved[0].owner.documentId, 'chrome-doc-1');
  assert.equal(harness.queued.length, 1);
  assert.equal(harness.queued[0].notification.statusCode, 'BLOCKED_HUMAN');
  assert.match(harness.diagnostics.at(-1).fields.reason, /identity=terminal-bridge-snapshot/);
});

test('bridged identity fails closed when prompt key does not match stopped watchdog', async () => {
  const harness = buildContext();
  vm.runInContext(source, harness.context);

  const result = await harness.context.__chatgptNotifierStreamTerminalDurableFallback.handleTerminalStatus(
    terminalMessage({ promptKey: 'conversation-1|other-user' }),
    sender
  );

  assert.equal(result, null);
  assert.equal(harness.reserved.length, 0);
  assert.equal(harness.queued.length, 0);
});

test('bridged identity fails closed when request timestamp does not match stopped watchdog', async () => {
  const harness = buildContext();
  vm.runInContext(source, harness.context);

  const result = await harness.context.__chatgptNotifierStreamTerminalDurableFallback.handleTerminalStatus(
    terminalMessage({ requestStartedAt: 123457 }),
    sender
  );

  assert.equal(result, null);
  assert.equal(harness.reserved.length, 0);
  assert.equal(harness.queued.length, 0);
});

test('bridged identity recovery adds no ChatGPT traffic or foreground authority', () => {
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|backend-api/);
  assert.doesNotMatch(source, /tabs\.update\([^)]*active:\s*true/);
  assert.doesNotMatch(source, /windows\.update\([^)]*focused:\s*true/);
  assert.match(source, /terminal-bridge-snapshot/);
  assert.match(source, /bridgedSnapshot/);
});
