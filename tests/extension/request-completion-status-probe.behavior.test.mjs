import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../../extension/tab-lifecycle-diagnostics-background.js', import.meta.url), 'utf8');

function createRuntime({ documentId = 'chrome-doc-1', frozen = false, discarded = false, statusCode = 'COMPLETE_NO_CHANGES' } = {}) {
  const completedListeners = [];
  const updatedListeners = [];
  const diagnostics = [];
  const scheduled = [];
  const tab = {
    id: 7,
    url: 'https://chatgpt.com/c/conversation-1',
    title: 'Probe test',
    active: true,
    frozen,
    discarded
  };

  const context = vm.createContext({
    console,
    URL,
    queryTerminalStatus: async (tabId, exactDocumentId, timeoutMs) => {
      assert.equal(tabId, 7);
      assert.equal(exactDocumentId, documentId);
      assert.equal(timeoutMs, 30000);
      return {
        statusCode,
        conversationId: 'conversation-1',
        conversationUrl: tab.url,
        documentId: 'status-runtime-1',
        promptKey: 'conversation-1|conversation-turn-1',
        promptRevision: '5:abc',
        assistantKey: 'conversation-turn-2',
        revision: '10:def'
      };
    },
    chrome: {
      tabs: {
        get: async () => ({ ...tab }),
        onUpdated: { addListener: (listener) => updatedListeners.push(listener) }
      },
      webRequest: {
        onCompleted: { addListener: (listener) => completedListeners.push(listener) }
      }
    },
    __chatgptNotifierDeliveryDiagnostics: {
      record(status, fields) { diagnostics.push({ status, fields }); }
    },
    ChatGPTNotifierStatusCode: {
      isStatusCode: (value) => ['COMPLETE_NO_CHANGES', 'INCOMPLETE_LIMIT'].includes(String(value || ''))
    },
    __chatgptNotifierNormalContinuationBudgetHook: {
      async scheduleObservedStatusDelivery(message, sender) {
        scheduled.push({ message, sender });
      }
    }
  });

  vm.runInContext(source, context);

  return {
    diagnostics,
    scheduled,
    async complete() {
      completedListeners[0]({
        tabId: 7,
        method: 'POST',
        url: 'https://chatgpt.com/backend-api/f/conversation',
        statusCode: 200,
        requestId: 'request-1',
        documentId
      });
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    }
  };
}

test('request completion probes terminal status and routes exact Chrome document identity without page publish timer', async () => {
  const runtime = createRuntime();
  await runtime.complete();

  assert.equal(runtime.scheduled.length, 1);
  assert.equal(runtime.scheduled[0].sender.documentId, 'chrome-doc-1');
  assert.equal(runtime.scheduled[0].message.type, 'CHATGPT_MONITOR_STATE');
  assert.equal(runtime.scheduled[0].message.snapshot.statusCode, 'COMPLETE_NO_CHANGES');
  assert.equal(runtime.scheduled[0].message.snapshot.documentId, 'status-runtime-1');
  assert.ok(runtime.diagnostics.some((item) => item.status === 'request-completion-status-probe-observed'));
});

test('request completion probe fails safe when Chrome document identity is unavailable', async () => {
  const runtime = createRuntime({ documentId: '' });
  await runtime.complete();

  assert.equal(runtime.scheduled.length, 0);
  assert.ok(runtime.diagnostics.some((item) =>
    item.status === 'request-completion-status-probe-unroutable' &&
    item.fields.reason === 'chrome-document-id-missing'
  ));
});

test('request completion probe does not query or act on frozen/discarded pages', async () => {
  for (const unavailable of [{ frozen: true }, { discarded: true }]) {
    const runtime = createRuntime(unavailable);
    await runtime.complete();
    assert.equal(runtime.scheduled.length, 0);
    assert.ok(runtime.diagnostics.some((item) => item.status === 'request-completion-status-probe-deferred'));
  }
});

test('probe source introduces no ChatGPT HTTP polling or foregrounding', () => {
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /XMLHttpRequest/);
  assert.doesNotMatch(source, /tabs\.update\([^)]*active:\s*true/);
  assert.doesNotMatch(source, /windows\.update\([^)]*focused:\s*true/);
  assert.match(source, /queryTerminalStatus\(details\.tabId, chromeDocumentId, 30_000\)/);
  assert.match(source, /scheduleObservedStatusDelivery/);
});
