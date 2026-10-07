import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const readText = (relative) => fs.readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const source = readText('standalone-quick-continue/monitor-watchdog-background.js');
const simpleSource = readText('standalone-quick-continue/background.js');
const config = JSON.parse(readText('standalone-quick-continue/config.json'));

const STATE_KEY = 'quickContinueMonitorWatchdogStates';
const ALARM_PREFIX = 'quick-continue-monitor-watchdog:';
const SET = 'QUICK_CONTINUE_MONITOR_WATCHDOG_SET';
const GET = 'QUICK_CONTINUE_MONITOR_WATCHDOG_GET';
const ACTION = 'QUICK_CONTINUE_MONITOR_WATCHDOG_ACTION';

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
    id: 52,
    url: 'https://chatgpt.com/c/monitor-mode-test',
    status: 'complete'
  };

  const chrome = {
    runtime: {
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
    }
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
    clearTimeout
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);

  async function send(message) {
    assert.equal(messageListeners.length, 1);
    return new Promise((resolve) => {
      const asynchronous = messageListeners[0](message, { tab: structuredClone(tab) }, resolve);
      assert.equal(asynchronous, true);
    });
  }

  async function fireAlarm() {
    assert.equal(alarmListeners.length, 1);
    alarmListeners[0]({ name: `${ALARM_PREFIX}${tab.id}` });
    await tick();
    await tick();
  }

  function state() {
    return storage[STATE_KEY]?.[String(tab.id)] || null;
  }

  function actions() {
    return sentMessages.filter((message) => message?.type === ACTION);
  }

  return { storage, alarms, sentMessages, reloads, tab, send, fireAlarm, state, actions };
}

test('Monitor is a mechanically separate copy of the Simple scheduler namespace', () => {
  assert.match(source, /quickContinueMonitorWatchdogStates/);
  assert.match(source, /quick-continue-monitor-watchdog:/);
  assert.match(source, /QUICK_CONTINUE_MONITOR_WATCHDOG_SET/);
  assert.doesNotMatch(source, /quickContinueSimpleWatchdogStates/);
  assert.doesNotMatch(source, /QUICK_CONTINUE_SIMPLE_WATCHDOG_/);

  assert.match(simpleSource, /quickContinueSimpleWatchdogStates/);
  assert.match(simpleSource, /quick-continue-simple-watchdog:/);
  assert.doesNotMatch(simpleSource, /quickContinueMonitorWatchdogStates/);

  assert.deepEqual(config.monitorWatchdog, config.simpleWatchdog);
});

test('Monitor executes the copied Stop -> refresh -> page-ready -> Continue sequence on its own state', async () => {
  const harness = createHarness();
  const settings = {
    timerMinutes: 7,
    attempts: 2,
    stopToRefreshSeconds: 11,
    refreshToContinueSeconds: 13,
    respectStopStatusCodes: true,
    respectContinueStatusCodes: true
  };

  const enabled = await harness.send({
    type: SET,
    enabled: true,
    conversationId: 'monitor-mode-test',
    settings
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.phase, 'countdown');
  assert.equal(enabled.attemptsRemaining, 2);
  assert.deepEqual(harness.state().settings, settings);

  harness.state().nextAt = 0;
  await harness.fireAlarm();
  await settle(() => harness.state()?.phase === 'stop-wait', 'stop-wait');
  assert.deepEqual(harness.actions().at(-1), { type: ACTION, action: 'stop' });

  harness.state().nextAt = 0;
  await harness.fireAlarm();
  await settle(() => harness.state()?.phase === 'refresh-loading', 'refresh-loading');
  assert.deepEqual(harness.reloads, [52]);

  harness.tab.status = 'loading';
  harness.state().nextAt = 0;
  await harness.fireAlarm();
  assert.equal(harness.state().phase, 'refresh-loading');
  assert.equal(harness.actions().filter((entry) => entry.action === 'send-continue').length, 0);

  harness.tab.status = 'complete';
  harness.state().nextAt = 0;
  await harness.fireAlarm();
  await settle(() => harness.state()?.phase === 'refresh-wait', 'refresh-wait');

  harness.state().nextAt = 0;
  await harness.fireAlarm();
  await settle(() => harness.state()?.phase === 'countdown', 'next countdown');
  assert.deepEqual(harness.actions().at(-1), { type: ACTION, action: 'send-continue' });
  assert.equal(harness.state().attemptsUsed, 1);

  const restored = await harness.send({ type: GET, conversationId: 'monitor-mode-test' });
  assert.equal(restored.enabled, true);
  assert.equal(restored.attemptsRemaining, 1);
});

test('Monitor and Simple configuration objects can diverge without normalization coupling them', () => {
  const monitor = { ...config.monitorWatchdog, timerMinutes: 12, attempts: 5 };
  const simple = { ...config.simpleWatchdog, timerMinutes: 30, attempts: 3 };
  assert.notDeepEqual(monitor, simple);
  assert.equal(simple.timerMinutes, 30);
  assert.equal(simple.attempts, 3);
  assert.equal(monitor.timerMinutes, 12);
  assert.equal(monitor.attempts, 5);
});
