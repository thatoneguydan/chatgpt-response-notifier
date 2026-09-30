import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const readText = (relative) => fs.readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const backgroundSource = readText('standalone-quick-continue/background.js');
const conversationStateSource = readText('standalone-quick-continue/conversation-state.js');
const config = JSON.parse(readText('standalone-quick-continue/config.json'));

const SIMPLE_STATE_KEY = 'quickContinueSimpleWatchdogStates';
const SIMPLE_ALARM_PREFIX = 'quick-continue-simple-watchdog:';
const SET = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_SET';
const ACTION = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_ACTION';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(predicate, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${label}`);
}

function createHarness() {
  const storage = {};
  const alarms = new Map();
  const sentMessages = [];
  const reloads = [];
  const alarmListeners = [];
  const messageListeners = [];
  const startupListeners = [];
  const installedListeners = [];
  const removedListeners = [];
  const tab = {
    id: 41,
    url: 'https://chatgpt.com/c/simple-mode-test',
    discarded: false,
    frozen: false
  };

  const chrome = {
    runtime: {
      getManifest: () => ({ version: '1.2.29' }),
      reload() {},
      onMessage: { addListener: (listener) => messageListeners.push(listener) },
      onStartup: { addListener: (listener) => startupListeners.push(listener) },
      onInstalled: { addListener: (listener) => installedListeners.push(listener) }
    },
    storage: {
      local: {
        async get(key) { return { [key]: structuredClone(storage[key]) }; },
        async set(value) { Object.assign(storage, structuredClone(value)); }
      }
    },
    alarms: {
      create(name, options) { alarms.set(name, structuredClone(options)); },
      async clear(name) { return alarms.delete(name); },
      onAlarm: { addListener: (listener) => alarmListeners.push(listener) }
    },
    tabs: {
      async query() { return []; },
      async get(tabId) {
        if (tabId !== tab.id) throw new Error('missing tab');
        return structuredClone(tab);
      },
      async sendMessage(tabId, message) {
        assert.equal(tabId, tab.id);
        sentMessages.push(structuredClone(message));
        return { ok: true };
      },
      async reload(tabId) {
        assert.equal(tabId, tab.id);
        reloads.push(tabId);
      },
      onRemoved: { addListener: (listener) => removedListeners.push(listener) }
    },
    scripting: { async executeScript() {} }
  };

  const context = {
    globalThis: null,
    chrome,
    URL,
    Date,
    Number,
    String,
    Object,
    Promise,
    Math,
    decodeURIComponent,
    structuredClone,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: false })
  };
  context.globalThis = context;
  vm.runInNewContext(backgroundSource, context);

  async function sendRuntimeMessage(message) {
    assert.equal(messageListeners.length, 1);
    return await new Promise((resolve) => {
      const asyncResponse = messageListeners[0](message, { tab: structuredClone(tab) }, resolve);
      assert.equal(asyncResponse, true);
    });
  }

  async function fireSimpleAlarm() {
    assert.equal(alarmListeners.length, 1);
    alarmListeners[0]({ name: `${SIMPLE_ALARM_PREFIX}${tab.id}` });
    await tick();
    await tick();
  }

  function state() {
    return storage[SIMPLE_STATE_KEY]?.[String(tab.id)] || null;
  }

  return { storage, alarms, sentMessages, reloads, tab, sendRuntimeMessage, fireSimpleAlarm, state };
}

test('Simple mode executes the fixed Stop, reload, Continue sequence and repeats from its configured timer', async () => {
  const harness = createHarness();
  const settings = {
    timerMinutes: 7,
    attempts: 2,
    stopToRefreshSeconds: 11,
    refreshToContinueSeconds: 13
  };

  const enabled = await harness.sendRuntimeMessage({
    type: SET,
    enabled: true,
    conversationId: 'simple-mode-test',
    settings
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.phase, 'countdown');
  assert.equal(enabled.attemptsRemaining, 2);
  assert.deepEqual(harness.state().settings, settings);

  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  await settle(() => harness.state()?.phase === 'stop-wait', 'stop-wait phase');
  assert.deepEqual(harness.sentMessages.at(-1), { type: ACTION, action: 'stop' });
  assert.equal(harness.state().attemptsUsed, 0);

  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  await settle(() => harness.state()?.phase === 'refresh-wait', 'refresh-wait phase');
  assert.deepEqual(harness.reloads, [41]);
  assert.equal(harness.state().attemptsUsed, 0);

  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  await settle(() => harness.state()?.phase === 'countdown', 'second countdown');
  assert.deepEqual(harness.sentMessages.at(-1), { type: ACTION, action: 'send-continue' });
  assert.equal(harness.state().attemptsUsed, 1);
  assert.equal(harness.state().settings.timerMinutes, 7);

  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  await settle(() => harness.state() === null, 'attempt exhaustion');
  assert.equal(harness.sentMessages.filter((entry) => entry.action === 'send-continue').length, 2);
  assert.deepEqual(harness.reloads, [41, 41]);
});

test('Simple mode progresses when Stop is absent and does not consult GitHub status policy', async () => {
  assert.deepEqual(config.simpleWatchdog, {
    timerMinutes: 30,
    attempts: 3,
    stopToRefreshSeconds: 30,
    refreshToContinueSeconds: 30
  });

  for (const code of [
    'PLANNING_ACTIVE',
    'COMPLETE_APPLIED',
    'COMPLETE_NO_CHANGES',
    'BLOCKED_HUMAN',
    'INCOMPLETE_LIMIT',
    'INCOMPLETE_TOOL_FAILURE',
    'INCOMPLETE_CONTINUE',
    'INCOMPLETE_HANDOFF'
  ]) {
    assert.equal(backgroundSource.includes(code), false, `background Simple authority must ignore ${code}`);
    assert.equal(conversationStateSource.includes(code), false, `page Simple authority must ignore ${code}`);
  }

  assert.match(backgroundSource, /await chrome\.tabs\.sendMessage\(tabId, \{ type: SIMPLE_ACTION_MESSAGE, action: 'stop' \}\);[\s\S]*state\.phase = 'stop-wait'/);
  assert.match(backgroundSource, /try \{ await chrome\.tabs\.reload\(tabId\); \} catch \{\}[\s\S]*state\.phase = 'refresh-wait'/);
  assert.match(backgroundSource, /action: 'send-continue'[\s\S]*state\.attemptsUsed = Number/);
  assert.match(conversationStateSource, /button\[data-testid="stop-button"\]/);
  assert.match(conversationStateSource, /sendApi\.submit\(composer, text, \{ replace: true, timeoutMs: 5000 \}\)/);
});

test('Simple mode is mechanically scoped to the exact saved conversation', async () => {
  const harness = createHarness();
  const enabled = await harness.sendRuntimeMessage({
    type: SET,
    enabled: true,
    conversationId: 'simple-mode-test',
    settings: config.simpleWatchdog
  });
  assert.equal(enabled.enabled, true);

  harness.tab.url = 'https://chatgpt.com/c/a-different-chat';
  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  await settle(() => harness.state() === null, 'wrong-chat shutdown');
  assert.equal(harness.sentMessages.some((entry) => entry.action === 'stop' || entry.action === 'send-continue'), false);
  assert.equal(harness.reloads.length, 0);
});
