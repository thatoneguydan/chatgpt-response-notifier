import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const readText = (relative) => fs.readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const backgroundSource = readText('standalone-quick-continue/background.js');
const conversationStateSource = readText('standalone-quick-continue/conversation-state.js');
const notifierObserverSource = readText('extension/terminal-status-live-observer.js');
const config = JSON.parse(readText('standalone-quick-continue/config.json'));

const SIMPLE_STATE_KEY = 'quickContinueSimpleWatchdogStates';
const SIMPLE_ALARM_PREFIX = 'quick-continue-simple-watchdog:';
const SET = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_SET';
const GET = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_GET';
const STATUS = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_STATUS';
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
    status: 'complete',
    discarded: false,
    frozen: false
  };

  const chrome = {
    runtime: {
      getManifest: () => ({ version: '1.2.38' }),
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

  function actionMessages() {
    return sentMessages.filter((entry) => entry?.type === ACTION);
  }

  return { storage, alarms, sentMessages, reloads, tab, sendRuntimeMessage, fireSimpleAlarm, state, actionMessages };
}

test('Simple mode executes the fixed sequence and stays enabled after attempts exhaust until explicitly turned off', async () => {
  const harness = createHarness();
  const settings = {
    timerMinutes: 7,
    attempts: 2,
    stopToRefreshSeconds: 11,
    refreshToContinueSeconds: 13,
    respectStopStatusCodes: true,
    respectContinueStatusCodes: true
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
  assert.deepEqual(harness.actionMessages().at(-1), { type: ACTION, action: 'stop' });

  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  await settle(() => harness.state()?.phase === 'refresh-loading', 'refresh-loading phase');
  assert.deepEqual(harness.reloads, [41]);

  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  await settle(() => harness.state()?.phase === 'refresh-wait', 'refresh-wait phase');

  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  await settle(() => harness.state()?.phase === 'countdown', 'second countdown');
  assert.deepEqual(harness.actionMessages().at(-1), { type: ACTION, action: 'send-continue' });
  assert.equal(harness.state().attemptsUsed, 1);

  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  await settle(() => harness.state()?.phase === 'exhausted', 'attempt exhaustion');
  assert.equal(harness.state().enabled, true);
  assert.equal(harness.state().exhausted, true);
  assert.equal(harness.state().attemptsUsed, 2);
  assert.equal(harness.alarms.has(SIMPLE_ALARM_PREFIX + harness.tab.id), false);
  assert.equal(harness.actionMessages().filter((entry) => entry.action === 'send-continue').length, 2);
  assert.deepEqual(harness.reloads, [41, 41]);

  const exhausted = await harness.sendRuntimeMessage({ type: GET, conversationId: 'simple-mode-test' });
  assert.equal(exhausted.enabled, true);
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.attemptsRemaining, 0);

  const disabled = await harness.sendRuntimeMessage({ type: SET, enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(harness.state(), null);
});

test('Simple waits for a completed page reload before starting the configured post-refresh delay', async () => {
  const harness = createHarness();
  await harness.sendRuntimeMessage({
    type: SET,
    enabled: true,
    conversationId: 'simple-mode-test',
    settings: config.simpleWatchdog
  });

  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  await settle(() => harness.state()?.phase === 'refresh-loading', 'refresh-loading phase');

  harness.tab.status = 'loading';
  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  assert.equal(harness.state().phase, 'refresh-loading');
  assert.equal(harness.actionMessages().filter((entry) => entry.action === 'send-continue').length, 0);

  harness.tab.status = 'complete';
  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  assert.equal(harness.state().phase, 'refresh-wait');
  assert.equal(harness.actionMessages().filter((entry) => entry.action === 'send-continue').length, 0);

  harness.state().nextAt = 0;
  await harness.fireSimpleAlarm();
  assert.equal(harness.actionMessages().filter((entry) => entry.action === 'send-continue').length, 1);
});

test('Simple status gates consume the notifier canonical terminal authority instead of duplicating a DOM parser', () => {
  assert.deepEqual(config.simpleWatchdog, {
    timerMinutes: 30,
    attempts: 3,
    stopToRefreshSeconds: 30,
    refreshToContinueSeconds: 30,
    respectStopStatusCodes: true,
    respectContinueStatusCodes: true
  });
  assert.equal(config.watchdog.respectStopStatusCodes, undefined);
  assert.equal(config.watchdog.respectContinueStatusCodes, undefined);

  assert.match(notifierObserverSource, /chatgpt-notifier-terminal-status-v1/);
  assert.match(notifierObserverSource, /chatgpt-notifier-terminal-status-query-v1/);
  assert.match(notifierObserverSource, /chatgpt-notifier-terminal-status-response-v1/);
  assert.match(notifierObserverSource, /getWatchdogSettings/);
  assert.match(notifierObserverSource, /statusClass/);

  assert.match(conversationStateSource, /TERMINAL_BRIDGE_MARKER = 'chatgpt-notifier-terminal-status-v1'/);
  assert.match(conversationStateSource, /queryNotifierTerminalSignal/);
  assert.match(conversationStateSource, /applyTerminalSignal/);
  assert.doesNotMatch(conversationStateSource, /latestSimpleTerminal|terminalCodeFromElement|conversationTurns/);
  assert.doesNotMatch(conversationStateSource, /querySelectorAll\?\.\('p, li'\)/);

  assert.match(backgroundSource, /const statusClass = String\(message\?\.statusClass/);
  assert.match(backgroundSource, /\['stop', 'continue'\]\.includes\(statusClass\)/);
  assert.match(backgroundSource, /respectStopStatusCodes !== false/);
  assert.match(backgroundSource, /respectContinueStatusCodes !== false/);
  assert.doesNotMatch(backgroundSource, /normalizeStopOnStatus|DEFAULT_STOP_ON_STATUS/);
});

test('respected stop-class status disables Simple; ignored stop-class status leaves its timer intact', async () => {
  const stopping = createHarness();
  await stopping.sendRuntimeMessage({
    type: SET,
    enabled: true,
    conversationId: 'simple-mode-test',
    settings: config.simpleWatchdog
  });
  const stopped = await stopping.sendRuntimeMessage({
    type: STATUS,
    conversationId: 'simple-mode-test',
    statusCode: 'COMPLETE_APPLIED',
    statusClass: 'stop',
    fingerprint: 'simple-mode-test|assistant-1|COMPLETE_APPLIED',
    settings: config.simpleWatchdog
  });
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.statusAction, 'stop');
  assert.equal(stopping.state(), null);
  assert.equal(stopping.actionMessages().filter((entry) => entry.action === 'send-continue').length, 0);

  const ignoring = createHarness();
  const ignoredSettings = { ...config.simpleWatchdog, respectStopStatusCodes: false };
  await ignoring.sendRuntimeMessage({
    type: SET,
    enabled: true,
    conversationId: 'simple-mode-test',
    settings: ignoredSettings
  });
  const originalNextAt = ignoring.state().nextAt;
  const ignored = await ignoring.sendRuntimeMessage({
    type: STATUS,
    conversationId: 'simple-mode-test',
    statusCode: 'COMPLETE_APPLIED',
    statusClass: 'stop',
    fingerprint: 'simple-mode-test|assistant-1|COMPLETE_APPLIED',
    settings: ignoredSettings
  });
  assert.equal(ignored.enabled, true);
  assert.equal(ignored.statusAction, 'ignored');
  assert.equal(ignoring.state().phase, 'countdown');
  assert.equal(ignoring.state().nextAt, originalNextAt);
  assert.equal(ignoring.actionMessages().filter((entry) => entry.action === 'send-continue').length, 0);
});

test('respected continue-class status sends once, consumes one Simple attempt, resets cadence, and dedupes the same footer', async () => {
  const harness = createHarness();
  await harness.sendRuntimeMessage({
    type: SET,
    enabled: true,
    conversationId: 'simple-mode-test',
    settings: config.simpleWatchdog
  });
  const fingerprint = 'simple-mode-test|assistant-2|INCOMPLETE_CONTINUE';
  const continued = await harness.sendRuntimeMessage({
    type: STATUS,
    conversationId: 'simple-mode-test',
    statusCode: 'INCOMPLETE_CONTINUE',
    statusClass: 'continue',
    fingerprint,
    settings: config.simpleWatchdog
  });
  assert.equal(continued.enabled, true);
  assert.equal(continued.statusAction, 'continue');
  assert.equal(continued.sent, true);
  assert.equal(harness.state().attemptsUsed, 1);
  assert.equal(harness.state().phase, 'countdown');
  assert.equal(harness.actionMessages().filter((entry) => entry.action === 'send-continue').length, 1);

  const duplicate = await harness.sendRuntimeMessage({
    type: STATUS,
    conversationId: 'simple-mode-test',
    statusCode: 'INCOMPLETE_CONTINUE',
    statusClass: 'continue',
    fingerprint,
    settings: config.simpleWatchdog
  });
  assert.equal(duplicate.statusAction, 'duplicate');
  assert.equal(harness.state().attemptsUsed, 1);
  assert.equal(harness.actionMessages().filter((entry) => entry.action === 'send-continue').length, 1);
});

test('ignored continue-class status does not send, while a respected final allowed attempt leaves Simple enabled and exhausted', async () => {
  const ignoredHarness = createHarness();
  const ignoredSettings = { ...config.simpleWatchdog, respectContinueStatusCodes: false };
  await ignoredHarness.sendRuntimeMessage({
    type: SET,
    enabled: true,
    conversationId: 'simple-mode-test',
    settings: ignoredSettings
  });
  const ignored = await ignoredHarness.sendRuntimeMessage({
    type: STATUS,
    conversationId: 'simple-mode-test',
    statusCode: 'INCOMPLETE_LIMIT',
    statusClass: 'continue',
    fingerprint: 'simple-mode-test|assistant-3|INCOMPLETE_LIMIT',
    settings: ignoredSettings
  });
  assert.equal(ignored.statusAction, 'ignored');
  assert.equal(ignoredHarness.state().attemptsUsed, 0);
  assert.equal(ignoredHarness.actionMessages().filter((entry) => entry.action === 'send-continue').length, 0);

  const exhaustedHarness = createHarness();
  const oneAttempt = { ...config.simpleWatchdog, attempts: 1 };
  await exhaustedHarness.sendRuntimeMessage({
    type: SET,
    enabled: true,
    conversationId: 'simple-mode-test',
    settings: oneAttempt
  });
  const exhausted = await exhaustedHarness.sendRuntimeMessage({
    type: STATUS,
    conversationId: 'simple-mode-test',
    statusCode: 'INCOMPLETE_LIMIT',
    statusClass: 'continue',
    fingerprint: 'simple-mode-test|assistant-4|INCOMPLETE_LIMIT',
    settings: oneAttempt
  });
  assert.equal(exhausted.statusAction, 'continue');
  assert.equal(exhausted.enabled, true);
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhaustedHarness.state().phase, 'exhausted');
  assert.equal(exhaustedHarness.state().attemptsUsed, 1);
  assert.equal(exhaustedHarness.alarms.has(SIMPLE_ALARM_PREFIX + exhaustedHarness.tab.id), false);
});

test('exhausted Simple still honors a later stop-class COMPLETE_APPLIED and never sends another continue', async () => {
  const harness = createHarness();
  const oneAttempt = { ...config.simpleWatchdog, attempts: 1 };
  await harness.sendRuntimeMessage({
    type: SET,
    enabled: true,
    conversationId: 'simple-mode-test',
    settings: oneAttempt
  });
  await harness.sendRuntimeMessage({
    type: STATUS,
    conversationId: 'simple-mode-test',
    statusCode: 'INCOMPLETE_CONTINUE',
    statusClass: 'continue',
    fingerprint: 'simple-mode-test|assistant-4|INCOMPLETE_CONTINUE',
    settings: oneAttempt
  });
  assert.equal(harness.state().phase, 'exhausted');
  assert.equal(harness.actionMessages().filter((entry) => entry.action === 'send-continue').length, 1);

  const ignoredContinue = await harness.sendRuntimeMessage({
    type: STATUS,
    conversationId: 'simple-mode-test',
    statusCode: 'INCOMPLETE_LIMIT',
    statusClass: 'continue',
    fingerprint: 'simple-mode-test|assistant-5|INCOMPLETE_LIMIT',
    settings: oneAttempt
  });
  assert.equal(ignoredContinue.statusAction, 'exhausted');
  assert.equal(ignoredContinue.enabled, true);
  assert.equal(harness.actionMessages().filter((entry) => entry.action === 'send-continue').length, 1);

  const stopped = await harness.sendRuntimeMessage({
    type: STATUS,
    conversationId: 'simple-mode-test',
    statusCode: 'COMPLETE_APPLIED',
    statusClass: 'stop',
    fingerprint: 'simple-mode-test|assistant-6|COMPLETE_APPLIED',
    settings: oneAttempt
  });
  assert.equal(stopped.statusAction, 'stop');
  assert.equal(stopped.enabled, false);
  assert.equal(harness.state(), null);
  assert.equal(harness.actionMessages().filter((entry) => entry.action === 'send-continue').length, 1);
});

test('Simple persists an enable-time canonical terminal baseline so a pre-existing footer cannot fire after runtime replacement', async () => {
  const harness = createHarness();
  const baselineStatusFingerprint = 'simple-mode-test|assistant-old|COMPLETE_APPLIED';
  const enabled = await harness.sendRuntimeMessage({
    type: SET,
    enabled: true,
    conversationId: 'simple-mode-test',
    settings: config.simpleWatchdog,
    baselineStatusFingerprint
  });
  assert.equal(enabled.enabled, true);
  assert.equal(harness.state().lastStatusFingerprint, baselineStatusFingerprint);
  assert.equal(enabled.lastStatusFingerprint, baselineStatusFingerprint);
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
  assert.equal(harness.actionMessages().some((entry) => entry.action === 'stop' || entry.action === 'send-continue'), false);
  assert.equal(harness.reloads.length, 0);
});

test('Simple starts on an unsaved chat and keeps its click deadline when the chat gains an ID', async () => {
  const harness = createHarness();
  harness.tab.url = 'https://chatgpt.com/';
  const startedAt = Date.now() - 2000;
  const enabled = await harness.sendRuntimeMessage({ type: SET, enabled: true, conversationId: '', startedAt, settings: config.simpleWatchdog });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.nextAt, startedAt + config.simpleWatchdog.timerMinutes * 60_000);
  const deadline = enabled.nextAt;
  harness.tab.url = 'https://chatgpt.com/c/newly-saved-chat';
  const restored = await harness.sendRuntimeMessage({ type: GET, conversationId: 'newly-saved-chat' });
  assert.equal(restored.enabled, true);
  assert.equal(restored.nextAt, deadline);
  assert.equal(harness.state().conversationId, 'newly-saved-chat');
});

test('Simple switches off without loading settings or receiving a response', async () => {
  const harness = createHarness();
  await harness.sendRuntimeMessage({ type: SET, enabled: true, conversationId: 'simple-mode-test', settings: config.simpleWatchdog });
  const disabled = await harness.sendRuntimeMessage({ type: SET, enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(harness.state(), null);
  assert.equal(harness.alarms.has(SIMPLE_ALARM_PREFIX + harness.tab.id), false);
});