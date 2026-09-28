import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root), 'utf8');
const source = read('extension/response-stream-terminal-durable-fallback-background.js');
const bootstrap = read('extension/diagnostics-bootstrap.js');

function buildContext({ watchdogStartedAt = 123456, snapshotStartedAt = 123456, stopped = true } = {}) {
  const listeners = [];
  const queued = [];
  const reserved = [];
  const committed = [];
  const released = [];
  const diagnostics = [];
  const snapshot = {
    conversationId: 'conversation-1',
    conversationUrl: 'https://chatgpt.com/c/conversation-1',
    documentId: 'monitor-runtime-1',
    promptKey: '',
    requestId: 'request-1',
    requestPhase: 'completed',
    requestStartedAt: snapshotStartedAt
  };
  const watchdog = {
    conversationId: 'conversation-1',
    stopped,
    stopReason: stopped ? 'status:BLOCKED_HUMAN' : '',
    deadlineAt: stopped ? 0 : Date.now() + 10_000,
    lastRequestStartedAt: watchdogStartedAt,
    lastPromptKey: 'conversation-1|user-1'
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
    crypto: { randomUUID: () => 'notification-1' },
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
    __chatgptNotifierDeliveryReliability: {
      record(status, fields) { diagnostics.push({ status, fields }); }
    },
    __chatgptNotifierDeliveryDedupeHook: {
      async reserveRequestDelivery(identity, owner) {
        reserved.push({ identity, owner });
        return { reserved: true, deliveryKey: 'request|conversation-1|chrome-doc-1|request-1', record: null };
      },
      async commitRequestDelivery(deliveryKey, patch) {
        committed.push({ deliveryKey, patch });
        return true;
      },
      async releaseRequestDelivery(deliveryKey) {
        released.push(deliveryKey);
        return true;
      }
    },
    __chatgptNotifierCoordinator: {
      async queueNotification(turnKey, notification, fingerprint) {
        queued.push({ turnKey, notification, fingerprint });
        return { notificationId: notification.id };
      }
    },
    chrome: {
      runtime: {
        onMessage: { addListener(listener) { listeners.push(listener); } }
      },
      tabs: {
        async sendMessage(tabId, message, options) {
          assert.equal(tabId, 7);
          assert.equal(message.type, 'CHATGPT_MONITOR_QUERY');
          assert.equal(options.documentId, 'chrome-doc-1');
          return { ok: true, snapshot };
        }
      }
    }
  });
  context.globalThis = context;
  return { context, listeners, queued, reserved, committed, released, diagnostics };
}

test('durable stream terminal fallback is loaded after terminal watchdog authority', () => {
  const authorityAt = bootstrap.indexOf("importScripts('terminal-watchdog-authority-background.js')");
  const fallbackAt = bootstrap.indexOf("importScripts('response-stream-terminal-durable-fallback-background.js')");
  assert.ok(authorityAt >= 0 && fallbackAt > authorityAt);
  assert.doesNotThrow(() => new vm.Script(source));
});

test('lost in-memory request context still queues one durable definitive notification from exact persisted request identity', async () => {
  const harness = buildContext();
  vm.runInContext(source, harness.context);
  const runtime = harness.context.__chatgptNotifierStreamTerminalDurableFallback;
  assert.equal(runtime.version, 1);

  const result = await runtime.handleTerminalStatus(
    { type: 'CHATGPT_RESPONSE_STREAM_TERMINAL_STATUS', statusCode: 'BLOCKED_HUMAN' },
    { tab: { id: 7, url: 'https://chatgpt.com/c/conversation-1', title: 'Project chat' }, documentId: 'chrome-doc-1' }
  );

  assert.equal(result, 'notification-1');
  assert.equal(harness.reserved.length, 1);
  assert.equal(harness.reserved[0].identity.requestId, 'request-1');
  assert.equal(harness.reserved[0].identity.promptKey, 'conversation-1|user-1');
  assert.equal(harness.reserved[0].owner.documentId, 'chrome-doc-1');
  assert.equal(harness.queued.length, 1);
  assert.equal(harness.queued[0].turnKey, '');
  assert.equal(harness.queued[0].notification.statusCode, 'BLOCKED_HUMAN');
  assert.equal(harness.queued[0].notification.conversationId, 'conversation-1');
  assert.match(harness.queued[0].fingerprint, /request-1\|BLOCKED_HUMAN$/);
  assert.equal(harness.committed.length, 1);
  assert.equal(harness.released.length, 0);
});

test('durable fallback fails closed when persisted watchdog and current request timestamps disagree', async () => {
  const harness = buildContext({ watchdogStartedAt: 123455, snapshotStartedAt: 123456 });
  vm.runInContext(source, harness.context);

  const result = await harness.context.__chatgptNotifierStreamTerminalDurableFallback.handleTerminalStatus(
    { type: 'CHATGPT_RESPONSE_STREAM_TERMINAL_STATUS', statusCode: 'BLOCKED_HUMAN' },
    { tab: { id: 7, url: 'https://chatgpt.com/c/conversation-1' }, documentId: 'chrome-doc-1' }
  );

  assert.equal(result, null);
  assert.equal(harness.reserved.length, 0);
  assert.equal(harness.queued.length, 0);
  assert.equal(harness.committed.length, 0);
});

test('durable fallback has no ChatGPT traffic or foreground authority', () => {
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|backend-api/);
  assert.doesNotMatch(source, /tabs\.update\([^)]*active:\s*true/);
  assert.doesNotMatch(source, /windows\.update\([^)]*focused:\s*true/);
  assert.match(source, /reserveRequestDelivery/);
  assert.match(source, /stopReason \|\| ''\) !== `status:\$\{statusCode\}`/);
  assert.match(source, /lastRequestStartedAt/);
});
