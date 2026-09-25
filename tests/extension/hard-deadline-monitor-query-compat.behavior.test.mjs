import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('extension/monitor-query-compat-background.js', root), 'utf8');

function loadCompat({ result, watchdog, enrollment, now = 1_000_000 }) {
  const sent = [];
  const context = vm.createContext({
    globalThis: null,
    String,
    Number,
    Math,
    Object,
    Promise,
    Date: { now: () => now },
    chrome: {
      tabs: {
        async sendMessage(tabId, message, ...rest) {
          sent.push({ tabId, message, rest });
          return structuredClone(result);
        }
      }
    },
    __chatgptNotifierMonitorBackground: {
      async readCodeWatchdog() { return structuredClone(watchdog); },
      async getEnrollment() { return structuredClone(enrollment); }
    }
  });
  context.globalThis = context;
  vm.runInContext(source, context);
  return { context, sent };
}

const mismatchedResult = {
  ok: true,
  snapshot: {
    conversationId: 'conversation-1',
    promptKey: 'conversation-1|stale-prompt',
    applicationStateIdentityMatched: false,
    applicationStateReason: 'identity-mismatch',
    online: true
  }
};

test('overdue auto-continue ignores response identity lag and targets the current conversation turn', async () => {
  const now = 1_000_000;
  const { context } = loadCompat({
    result: mismatchedResult,
    watchdog: {
      conversationId: 'conversation-1',
      deadlineAt: now - 1,
      stopped: false,
      sendCount: 1
    },
    enrollment: { enabled: true, userPaused: false },
    now
  });

  const result = await context.chrome.tabs.sendMessage(7, { type: 'CHATGPT_MONITOR_QUERY' });
  assert.equal(result.conversationId, 'conversation-1');
  assert.equal(result.applicationStateIdentityMatched, true);
  assert.equal(result.applicationStateReason, 'hard-deadline-identity-bypass');
  assert.equal(result.promptKey, '');
  assert.equal(result.snapshot.applicationStateIdentityMatched, true);
  assert.equal(result.snapshot.promptKey, '');
  assert.equal(context.__chatgptNotifierMonitorQueryCompat.version, 2);
});

test('response identity remains a veto before the 30-minute deadline', async () => {
  const now = 1_000_000;
  const { context } = loadCompat({
    result: mismatchedResult,
    watchdog: {
      conversationId: 'conversation-1',
      deadlineAt: now + 60_000,
      stopped: false
    },
    enrollment: { enabled: true, userPaused: false },
    now
  });

  const result = await context.chrome.tabs.sendMessage(7, { type: 'CHATGPT_MONITOR_QUERY' });
  assert.equal(result.applicationStateIdentityMatched, false);
  assert.equal(result.promptKey, 'conversation-1|stale-prompt');
  assert.equal(result.snapshot.applicationStateIdentityMatched, false);
});

test('paused or stopped automation never receives the hard-deadline bypass', async () => {
  const now = 1_000_000;
  for (const [watchdog, enrollment] of [
    [{ conversationId: 'conversation-1', deadlineAt: now - 1, stopped: true }, { enabled: true, userPaused: false }],
    [{ conversationId: 'conversation-1', deadlineAt: now - 1, stopped: false }, { enabled: true, userPaused: true }],
    [{ conversationId: 'conversation-1', deadlineAt: now - 1, stopped: false }, { enabled: false, userPaused: false }]
  ]) {
    const { context } = loadCompat({ result: mismatchedResult, watchdog, enrollment, now });
    const result = await context.chrome.tabs.sendMessage(7, { type: 'CHATGPT_MONITOR_QUERY' });
    assert.equal(result.applicationStateIdentityMatched, false);
    assert.equal(result.promptKey, 'conversation-1|stale-prompt');
  }
});

test('non-monitor messages are passed through unchanged', async () => {
  const result = { ok: true, value: 42 };
  const { context } = loadCompat({
    result,
    watchdog: null,
    enrollment: null
  });
  const observed = await context.chrome.tabs.sendMessage(7, { type: 'OTHER_MESSAGE' });
  assert.deepEqual({ ...observed }, result);
});
