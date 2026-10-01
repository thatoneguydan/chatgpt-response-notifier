'use strict';

const UPDATE_ALARM = 'quick-continue-managed-update';
const UPDATE_URL = 'http://127.0.0.1:38473/quick-continue/update';
const SIMPLE_STATE_KEY = 'quickContinueSimpleWatchdogStates';
const SIMPLE_ALARM_PREFIX = 'quick-continue-simple-watchdog:';
const SIMPLE_SET_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_SET';
const SIMPLE_GET_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_GET';
const SIMPLE_STATUS_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_STATUS';
const SIMPLE_ACTION_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_ACTION';
const SIMPLE_STATE_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_STATE';
const STATUS_CODES = Object.freeze([
  'PLANNING_ACTIVE',
  'COMPLETE_APPLIED',
  'COMPLETE_NO_CHANGES',
  'BLOCKED_HUMAN',
  'INCOMPLETE_LIMIT',
  'INCOMPLETE_TOOL_FAILURE',
  'INCOMPLETE_CONTINUE',
  'INCOMPLETE_HANDOFF'
]);
const DEFAULT_STOP_ON_STATUS = Object.freeze({
  PLANNING_ACTIVE: true,
  COMPLETE_APPLIED: true,
  COMPLETE_NO_CHANGES: true,
  BLOCKED_HUMAN: true,
  INCOMPLETE_LIMIT: false,
  INCOMPLETE_TOOL_FAILURE: false,
  INCOMPLETE_CONTINUE: false,
  INCOMPLETE_HANDOFF: false
});
const CONTENT_FILES = [
  'runtime-reset.js',
  'dom-compat.js',
  'prompt-format.js',
  'config.js',
  'composer-text.js',
  'send-transaction.js',
  'config-editor-style.js',
  'content-script.js',
  'hover-edit-script.js',
  'conversation-state.js'
];

let simpleQueue = Promise.resolve();

function parseVersion(value) {
  const parts = String(value || '').split('.');
  if (parts.length < 2 || parts.length > 4) return null;
  const numbers = parts.map((part) => Number.parseInt(part, 10));
  if (numbers.some((part) => !Number.isInteger(part) || part < 0)) return null;
  return numbers;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const av = a[index] || 0;
    const bv = b[index] || 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

function managedUpdateShouldReload(installedVersion, runningVersion) {
  const comparison = compareVersions(installedVersion, runningVersion);
  return comparison !== null && comparison > 0;
}

async function injectCurrentRuntimeIntoOpenTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); } catch { return; }

  for (const tab of tabs) {
    if (!Number.isInteger(tab?.id) || tab.discarded === true || tab.frozen === true) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: CONTENT_FILES
      });
    } catch {}
  }
}

async function checkManagedUpdate() {
  let response;
  try {
    response = await fetch(UPDATE_URL, { cache: 'no-store' });
  } catch {
    return false;
  }
  if (!response.ok) return false;

  let payload;
  try { payload = await response.json(); } catch { return false; }
  const installedVersion = String(payload?.installedVersion || '');
  const runningVersion = String(chrome.runtime.getManifest().version || '');
  if (!managedUpdateShouldReload(installedVersion, runningVersion)) return false;

  setTimeout(() => chrome.runtime.reload(), 200);
  return true;
}

function ensureUpdateAlarm() {
  try {
    chrome.alarms.create(UPDATE_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: 15
    });
  } catch {}
}

function conversationIdFromUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    const parts = url.pathname.split('/').filter(Boolean);
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      if (parts[index] !== 'c') continue;
      const id = decodeURIComponent(parts[index + 1] || '').trim();
      if (id) return id;
    }
  } catch {}
  return '';
}

function simpleAlarmName(tabId) {
  return `${SIMPLE_ALARM_PREFIX}${tabId}`;
}

function stateKey(tabId) {
  return String(tabId);
}

function normalizeSimpleSettings(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const timerMinutes = Number(raw.timerMinutes);
  const attempts = Number(raw.attempts);
  const stopToRefreshSeconds = Number(raw.stopToRefreshSeconds);
  const refreshToContinueSeconds = Number(raw.refreshToContinueSeconds);
  const respectStopStatusCodes = raw.respectStopStatusCodes == null ? true : raw.respectStopStatusCodes;
  const respectContinueStatusCodes = raw.respectContinueStatusCodes == null ? true : raw.respectContinueStatusCodes;
  if (!Number.isFinite(timerMinutes) || timerMinutes < 0.1 || timerMinutes > 1440) return null;
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > 20) return null;
  if (!Number.isFinite(stopToRefreshSeconds) || stopToRefreshSeconds < 0 || stopToRefreshSeconds > 3600) return null;
  if (!Number.isFinite(refreshToContinueSeconds) || refreshToContinueSeconds < 0 || refreshToContinueSeconds > 3600) return null;
  if (typeof respectStopStatusCodes !== 'boolean' || typeof respectContinueStatusCodes !== 'boolean') return null;
  return {
    timerMinutes,
    attempts,
    stopToRefreshSeconds,
    refreshToContinueSeconds,
    respectStopStatusCodes,
    respectContinueStatusCodes
  };
}

function normalizeStopOnStatus(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const code of STATUS_CODES) {
    normalized[code] = typeof raw[code] === 'boolean' ? raw[code] : DEFAULT_STOP_ON_STATUS[code];
  }
  return normalized;
}

async function readSimpleStates() {
  try {
    const stored = (await chrome.storage.local.get(SIMPLE_STATE_KEY))?.[SIMPLE_STATE_KEY];
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch {
    return {};
  }
}

async function writeSimpleStates(states) {
  await chrome.storage.local.set({ [SIMPLE_STATE_KEY]: states });
}

function queueSimpleWork(work) {
  const run = simpleQueue.then(work, work);
  simpleQueue = run.catch(() => {});
  return run;
}

function publicSimpleState(state, extras = {}) {
  if (!state) return { enabled: false, ...extras };
  return {
    enabled: state.enabled === true,
    conversationId: String(state.conversationId || ''),
    phase: String(state.phase || ''),
    attemptsUsed: Number(state.attemptsUsed || 0),
    attemptsRemaining: Math.max(0, Number(state.settings?.attempts || 0) - Number(state.attemptsUsed || 0)),
    nextAt: Number(state.nextAt || 0),
    exhausted: state.exhausted === true || state.phase === 'exhausted',
    lastStatusCode: String(state.lastStatusCode || ''),
    lastStatusFingerprint: String(state.lastStatusFingerprint || ''),
    ...extras
  };
}

async function notifySimpleState(tabId, state, extras = {}) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: SIMPLE_STATE_MESSAGE,
      state: publicSimpleState(state, extras)
    });
  } catch {}
}

async function clearSimpleState(tabId, extras = {}) {
  const states = await readSimpleStates();
  delete states[stateKey(tabId)];
  await writeSimpleStates(states);
  try { await chrome.alarms.clear(simpleAlarmName(tabId)); } catch {}
  await notifySimpleState(tabId, null, extras);
  return { enabled: false, ...extras };
}

function scheduleSimpleAlarm(state) {
  if (!state?.enabled || state.exhausted === true || state.phase === 'exhausted' || !Number.isInteger(state.tabId)) return;
  const when = Math.max(Date.now() + 250, Number(state.nextAt || 0));
  try { chrome.alarms.create(simpleAlarmName(state.tabId), { when }); } catch {}
}

async function saveAndScheduleSimpleState(state, states = null) {
  const nextStates = states || await readSimpleStates();
  nextStates[stateKey(state.tabId)] = state;
  await writeSimpleStates(nextStates);
  if (state.exhausted === true || state.phase === 'exhausted') {
    try { await chrome.alarms.clear(simpleAlarmName(state.tabId)); } catch {}
  } else {
    scheduleSimpleAlarm(state);
  }
  await notifySimpleState(state.tabId, state);
  return publicSimpleState(state);
}

async function setSimpleWatchdog(sender, message) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return { enabled: false, reason: 'No ChatGPT tab identity.' };

  if (message?.enabled !== true) return clearSimpleState(tabId);

  const conversationId = String(message?.conversationId || '').trim();
  if (conversationIdFromUrl(sender?.tab?.url) !== conversationId) {
    return { enabled: false, reason: 'Chat changed before Simple could start.' };
  }

  const settings = normalizeSimpleSettings(message?.settings);
  if (!settings) return { enabled: false, reason: 'Simple watchdog JSON is invalid.' };
  if (settings.attempts === 0) return { enabled: false, reason: 'Simple watchdog attempts are set to 0.' };

  const state = {
    enabled: true,
    tabId,
    conversationId,
    initialUrl: String(sender?.tab?.url || '').split('#')[0],
    phase: 'countdown',
    attemptsUsed: 0,
    nextAt: Math.min(Date.now(), Math.max(Date.now() - 10_000, Number(message.startedAt) || Date.now())) + (settings.timerMinutes * 60 * 1000),
    exhausted: false,
    settings,
    stopOnStatus: normalizeStopOnStatus(message?.stopOnStatus),
    lastStatusFingerprint: String(message?.baselineStatusFingerprint || ''),
    lastStatusCode: ''
  };
  return saveAndScheduleSimpleState(state);
}

async function getSimpleWatchdog(sender, message) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return { enabled: false };
  const states = await readSimpleStates();
  const state = states[stateKey(tabId)];
  if (!state?.enabled) return { enabled: false };
  const conversationId = String(message?.conversationId || '').trim();
  if (!state.conversationId && conversationId && conversationIdFromUrl(sender?.tab?.url) === conversationId) {
    state.conversationId = conversationId;
    await writeSimpleStates(states);
  }
  if (state.conversationId !== conversationId || conversationIdFromUrl(sender?.tab?.url) !== conversationId) {
    return clearSimpleState(tabId, { reason: 'chat-changed' });
  }
  return publicSimpleState(state);
}

async function tabForSimpleState(state) {
  let tab = null;
  try { tab = await chrome.tabs.get(state.tabId); } catch {}
  if (!tab) return null;
  const currentId = conversationIdFromUrl(tab.url);
  if (!state.conversationId && currentId) state.conversationId = currentId;
  if (currentId !== state.conversationId) return null;
  if (!currentId && String(tab.url || '').split('#')[0] !== state.initialUrl) return null;
  return tab;
}

async function applySimpleStatus(sender, message) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return { enabled: false, reason: 'No ChatGPT tab identity.' };
  const states = await readSimpleStates();
  const state = states[stateKey(tabId)];
  if (!state?.enabled || state.exhausted === true || state.phase === 'exhausted') return publicSimpleState(state);

  const conversationId = String(message?.conversationId || '').trim();
  if (!conversationId || state.conversationId !== conversationId || conversationIdFromUrl(sender?.tab?.url) !== conversationId) {
    return publicSimpleState(state, { statusAction: 'ignored-chat' });
  }

  const statusCode = String(message?.statusCode || '').trim();
  if (!STATUS_CODES.includes(statusCode)) return publicSimpleState(state, { statusAction: 'ignored-status' });
  const fingerprint = String(message?.fingerprint || `${conversationId}|${statusCode}`).trim();
  if (!fingerprint || fingerprint === state.lastStatusFingerprint) return publicSimpleState(state, { statusAction: 'duplicate' });

  const refreshedSettings = normalizeSimpleSettings(message?.settings);
  if (refreshedSettings) state.settings = refreshedSettings;
  if (message?.stopOnStatus && typeof message.stopOnStatus === 'object' && !Array.isArray(message.stopOnStatus)) {
    state.stopOnStatus = normalizeStopOnStatus(message.stopOnStatus);
  } else if (!state.stopOnStatus) {
    state.stopOnStatus = normalizeStopOnStatus(null);
  }

  const stopClass = state.stopOnStatus[statusCode] === true;
  const respected = stopClass
    ? state.settings?.respectStopStatusCodes !== false
    : state.settings?.respectContinueStatusCodes !== false;
  state.lastStatusFingerprint = fingerprint;
  state.lastStatusCode = statusCode;

  if (!respected) {
    states[stateKey(tabId)] = state;
    await writeSimpleStates(states);
    return publicSimpleState(state, { statusAction: 'ignored' });
  }

  if (stopClass) {
    return clearSimpleState(tabId, { reason: 'status-stop', statusCode, statusAction: 'stop' });
  }

  state.attemptsUsed = Number(state.attemptsUsed || 0) + 1;
  if (state.attemptsUsed >= Number(state.settings?.attempts || 0)) {
    state.phase = 'exhausted';
    state.nextAt = 0;
    state.exhausted = true;
  } else {
    state.phase = 'countdown';
    state.nextAt = Date.now() + (Number(state.settings?.timerMinutes || 30) * 60 * 1000);
    state.exhausted = false;
  }
  states[stateKey(tabId)] = state;
  await writeSimpleStates(states);
  try { await chrome.alarms.clear(simpleAlarmName(tabId)); } catch {}

  let sendResult = null;
  try {
    sendResult = await chrome.tabs.sendMessage(tabId, { type: SIMPLE_ACTION_MESSAGE, action: 'send-continue' });
  } catch {}

  await saveAndScheduleSimpleState(state, states);
  return publicSimpleState(state, {
    statusAction: 'continue',
    statusCode,
    sent: sendResult?.ok === true
  });
}

async function handleSimpleAlarm(tabId) {
  const states = await readSimpleStates();
  const state = states[stateKey(tabId)];
  if (!state?.enabled || state.exhausted === true || state.phase === 'exhausted') return;
  if (!await tabForSimpleState(state)) {
    await clearSimpleState(tabId, { reason: 'chat-unavailable' });
    return;
  }

  const now = Date.now();
  if (Number(state.nextAt || 0) > now + 500) {
    scheduleSimpleAlarm(state);
    return;
  }

  if (state.phase === 'countdown') {
    try {
      await chrome.tabs.sendMessage(tabId, { type: SIMPLE_ACTION_MESSAGE, action: 'stop' });
    } catch {}
    state.phase = 'stop-wait';
    state.nextAt = Date.now() + (state.settings.stopToRefreshSeconds * 1000);
    await saveAndScheduleSimpleState(state, states);
    return;
  }

  if (state.phase === 'stop-wait') {
    try { await chrome.tabs.reload(tabId); } catch {}
    state.phase = 'refresh-wait';
    state.nextAt = Date.now() + (state.settings.refreshToContinueSeconds * 1000);
    await saveAndScheduleSimpleState(state, states);
    return;
  }

  if (state.phase === 'refresh-wait') {
    try {
      await chrome.tabs.sendMessage(tabId, { type: SIMPLE_ACTION_MESSAGE, action: 'send-continue' });
    } catch {}
    state.attemptsUsed = Number(state.attemptsUsed || 0) + 1;
    if (state.attemptsUsed >= state.settings.attempts) {
      state.phase = 'exhausted';
      state.nextAt = 0;
      state.exhausted = true;
      await saveAndScheduleSimpleState(state, states);
      return;
    }
    state.phase = 'countdown';
    state.nextAt = Date.now() + (state.settings.timerMinutes * 60 * 1000);
    await saveAndScheduleSimpleState(state, states);
    return;
  }

  await clearSimpleState(tabId, { reason: 'invalid-phase' });
}

async function restoreSimpleAlarms() {
  const states = await readSimpleStates();
  for (const state of Object.values(states)) {
    if (!state?.enabled || state.exhausted === true || state.phase === 'exhausted' || !Number.isInteger(state?.tabId)) continue;
    scheduleSimpleAlarm(state);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (![SIMPLE_SET_MESSAGE, SIMPLE_GET_MESSAGE, SIMPLE_STATUS_MESSAGE].includes(message?.type)) return false;
  const work = message.type === SIMPLE_SET_MESSAGE
    ? () => setSimpleWatchdog(sender, message)
    : message.type === SIMPLE_GET_MESSAGE
      ? () => getSimpleWatchdog(sender, message)
      : () => applySimpleStatus(sender, message);
  queueSimpleWork(work)
    .then((result) => sendResponse(result))
    .catch(() => sendResponse({ enabled: false, reason: 'Simple watchdog background failure.' }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === UPDATE_ALARM) {
    checkManagedUpdate().catch(() => {});
    return;
  }
  if (!String(alarm?.name || '').startsWith(SIMPLE_ALARM_PREFIX)) return;
  const tabId = Number.parseInt(String(alarm.name).slice(SIMPLE_ALARM_PREFIX.length), 10);
  if (!Number.isInteger(tabId)) return;
  queueSimpleWork(() => handleSimpleAlarm(tabId)).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!Number.isInteger(tabId)) return;
  queueSimpleWork(() => clearSimpleState(tabId, { reason: 'tab-closed' })).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  // Restored/new pages receive the declared content scripts from Chrome itself.
  // Reinjecting here used to dispose and rebuild the live toolbar during startup.
  ensureUpdateAlarm();
  checkManagedUpdate().catch(() => {});
  queueSimpleWork(restoreSimpleAlarms).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  // Existing ChatGPT tabs do need a one-time hot replacement after an actual
  // extension install/update. This is the only lifecycle path allowed to run
  // runtime-reset.js; ordinary MV3 service-worker wakes must never rebuild UI.
  ensureUpdateAlarm();
  injectCurrentRuntimeIntoOpenTabs().catch(() => {});
  checkManagedUpdate().catch(() => {});
  queueSimpleWork(restoreSimpleAlarms).catch(() => {});
});

// MV3 service workers are routinely stopped and restarted while Chrome remains
// open. Keep cold-start work side-effect free with respect to page DOM/runtime
// ownership: alarms/update checks are safe, content-script reinjection is not.
ensureUpdateAlarm();
checkManagedUpdate().catch(() => {});
queueSimpleWork(restoreSimpleAlarms).catch(() => {});
