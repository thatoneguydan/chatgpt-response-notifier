'use strict';

(() => {
  const MONITOR_STATE_KEY = 'quickContinueMonitorWatchdogStates';
  const MONITOR_ALARM_PREFIX = 'quick-continue-monitor-watchdog:';
  const MONITOR_SET_MESSAGE = 'QUICK_CONTINUE_MONITOR_WATCHDOG_SET';
  const MONITOR_GET_MESSAGE = 'QUICK_CONTINUE_MONITOR_WATCHDOG_GET';
  const MONITOR_STATUS_MESSAGE = 'QUICK_CONTINUE_MONITOR_WATCHDOG_STATUS';
  const MONITOR_ACTION_MESSAGE = 'QUICK_CONTINUE_MONITOR_WATCHDOG_ACTION';
  const MONITOR_STATE_MESSAGE = 'QUICK_CONTINUE_MONITOR_WATCHDOG_STATE';
  const MONITOR_REFRESH_READY_POLL_MS = 1000;
  const MONITOR_REFRESH_STALL_MS = 60_000;
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

  let monitorQueue = Promise.resolve();

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

function monitorAlarmName(tabId) {
  return `${MONITOR_ALARM_PREFIX}${tabId}`;
}

function stateKey(tabId) {
  return String(tabId);
}

function normalizeMonitorSettings(value) {
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

async function readMonitorStates() {
  try {
    const stored = (await chrome.storage.local.get(MONITOR_STATE_KEY))?.[MONITOR_STATE_KEY];
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch {
    return {};
  }
}

async function writeMonitorStates(states) {
  await chrome.storage.local.set({ [MONITOR_STATE_KEY]: states });
}

function queueMonitorWork(work) {
  const run = monitorQueue.then(work, work);
  monitorQueue = run.catch(() => {});
  return run;
}

function publicMonitorState(state, extras = {}) {
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

async function notifyMonitorState(tabId, state, extras = {}) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: MONITOR_STATE_MESSAGE,
      state: publicMonitorState(state, extras)
    });
  } catch {}
}

async function clearMonitorState(tabId, extras = {}) {
  const states = await readMonitorStates();
  delete states[stateKey(tabId)];
  await writeMonitorStates(states);
  try { await chrome.alarms.clear(monitorAlarmName(tabId)); } catch {}
  await notifyMonitorState(tabId, null, extras);
  return { enabled: false, ...extras };
}

function scheduleMonitorAlarm(state) {
  if (!state?.enabled || state.exhausted === true || state.phase === 'exhausted' || !Number.isInteger(state.tabId)) return;
  const when = Math.max(Date.now() + 250, Number(state.nextAt || 0));
  try { chrome.alarms.create(monitorAlarmName(state.tabId), { when }); } catch {}
}

async function saveAndScheduleMonitorState(state, states = null) {
  const nextStates = states || await readMonitorStates();
  nextStates[stateKey(state.tabId)] = state;
  await writeMonitorStates(nextStates);
  if (state.exhausted === true || state.phase === 'exhausted') {
    try { await chrome.alarms.clear(monitorAlarmName(state.tabId)); } catch {}
  } else {
    scheduleMonitorAlarm(state);
  }
  await notifyMonitorState(state.tabId, state);
  return publicMonitorState(state);
}

async function setMonitorWatchdog(sender, message) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return { enabled: false, reason: 'No ChatGPT tab identity.' };

  if (message?.enabled !== true) return clearMonitorState(tabId);

  const conversationId = String(message?.conversationId || '').trim();
  if (conversationIdFromUrl(sender?.tab?.url) !== conversationId) {
    return { enabled: false, reason: 'Chat changed before Monitor could start.' };
  }

  const settings = normalizeMonitorSettings(message?.settings);
  if (!settings) return { enabled: false, reason: 'Monitor watchdog JSON is invalid.' };
  if (settings.attempts === 0) return { enabled: false, reason: 'Monitor watchdog attempts are set to 0.' };

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
    lastStatusFingerprint: String(message?.baselineStatusFingerprint || ''),
    lastStatusCode: ''
  };
  return saveAndScheduleMonitorState(state);
}

async function getMonitorWatchdog(sender, message) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return { enabled: false };
  const states = await readMonitorStates();
  const state = states[stateKey(tabId)];
  if (!state?.enabled) return { enabled: false };
  const conversationId = String(message?.conversationId || '').trim();
  if (!state.conversationId && conversationId && conversationIdFromUrl(sender?.tab?.url) === conversationId) {
    state.conversationId = conversationId;
    await writeMonitorStates(states);
  }
  if (state.conversationId !== conversationId || conversationIdFromUrl(sender?.tab?.url) !== conversationId) {
    return clearMonitorState(tabId, { reason: 'chat-changed' });
  }
  return publicMonitorState(state);
}

async function tabForMonitorState(state) {
  let tab = null;
  try { tab = await chrome.tabs.get(state.tabId); } catch {}
  if (!tab) return null;
  const currentId = conversationIdFromUrl(tab.url);
  if (!state.conversationId && currentId) state.conversationId = currentId;
  if (currentId !== state.conversationId) return null;
  if (!currentId && String(tab.url || '').split('#')[0] !== state.initialUrl) return null;
  return tab;
}

async function applyMonitorStatus(sender, message) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return { enabled: false, reason: 'No ChatGPT tab identity.' };
  const states = await readMonitorStates();
  const state = states[stateKey(tabId)];
  if (!state?.enabled) return publicMonitorState(state);

  const conversationId = String(message?.conversationId || '').trim();
  if (!conversationId || state.conversationId !== conversationId || conversationIdFromUrl(sender?.tab?.url) !== conversationId) {
    return publicMonitorState(state, { statusAction: 'ignored-chat' });
  }

  const statusCode = String(message?.statusCode || '').trim();
  if (!STATUS_CODES.includes(statusCode)) return publicMonitorState(state, { statusAction: 'ignored-status' });
  const statusClass = String(message?.statusClass || '').trim();
  if (!['stop', 'continue'].includes(statusClass)) return publicMonitorState(state, { statusAction: 'ignored-status-class' });
  const fingerprint = String(message?.fingerprint || '').trim();
  if (!fingerprint || fingerprint === state.lastStatusFingerprint) return publicMonitorState(state, { statusAction: 'duplicate' });

  const refreshedSettings = normalizeMonitorSettings(message?.settings);
  if (refreshedSettings) state.settings = refreshedSettings;
  const respected = statusClass === 'stop'
    ? state.settings?.respectStopStatusCodes !== false
    : state.settings?.respectContinueStatusCodes !== false;
  state.lastStatusFingerprint = fingerprint;
  state.lastStatusCode = statusCode;

  if (!respected) {
    states[stateKey(tabId)] = state;
    await writeMonitorStates(states);
    return publicMonitorState(state, { statusAction: 'ignored' });
  }

  if (statusClass === 'stop') {
    return clearMonitorState(tabId, { reason: 'status-stop', statusCode, statusAction: 'stop' });
  }

  if (state.exhausted === true || state.phase === 'exhausted') {
    states[stateKey(tabId)] = state;
    await writeMonitorStates(states);
    return publicMonitorState(state, { statusAction: 'exhausted', statusCode });
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
  await writeMonitorStates(states);
  try { await chrome.alarms.clear(monitorAlarmName(tabId)); } catch {}

  let sendResult = null;
  try {
    sendResult = await chrome.tabs.sendMessage(tabId, { type: MONITOR_ACTION_MESSAGE, action: 'send-continue' });
  } catch {}

  await saveAndScheduleMonitorState(state, states);
  return publicMonitorState(state, {
    statusAction: 'continue',
    statusCode,
    sent: sendResult?.ok === true
  });
}

async function handleMonitorAlarm(tabId) {
  const states = await readMonitorStates();
  const state = states[stateKey(tabId)];
  if (!state?.enabled || state.exhausted === true || state.phase === 'exhausted') return;
  if (!await tabForMonitorState(state)) {
    await clearMonitorState(tabId, { reason: 'chat-unavailable' });
    return;
  }

  const now = Date.now();
  if (Number(state.nextAt || 0) > now + 500) {
    scheduleMonitorAlarm(state);
    return;
  }

  if (state.phase === 'countdown') {
    try {
      await chrome.tabs.sendMessage(tabId, { type: MONITOR_ACTION_MESSAGE, action: 'stop' });
    } catch {}
    state.phase = 'stop-wait';
    state.nextAt = Date.now() + (state.settings.stopToRefreshSeconds * 1000);
    await saveAndScheduleMonitorState(state, states);
    return;
  }

  if (state.phase === 'stop-wait') {
    try {
      await chrome.tabs.reload(tabId);
      state.phase = 'refresh-loading';
      state.reloadStartedAt = Date.now();
      state.nextAt = Date.now() + MONITOR_REFRESH_READY_POLL_MS;
    } catch {
      state.nextAt = Date.now() + MONITOR_REFRESH_READY_POLL_MS;
    }
    await saveAndScheduleMonitorState(state, states);
    return;
  }

  if (state.phase === 'refresh-loading') {
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch {}
    if (!tab) {
      await clearMonitorState(tabId, { reason: 'chat-unavailable' });
      return;
    }
    const reloadStartedAt = Math.max(0, Number(state.reloadStartedAt || 0));
    if (String(tab.status || '') !== 'complete') {
      if (reloadStartedAt > 0 && Date.now() - reloadStartedAt >= MONITOR_REFRESH_STALL_MS) {
        try {
          await chrome.tabs.reload(tabId);
          state.reloadStartedAt = Date.now();
        } catch {}
      }
      state.nextAt = Date.now() + MONITOR_REFRESH_READY_POLL_MS;
      await saveAndScheduleMonitorState(state, states);
      return;
    }
    state.phase = 'refresh-wait';
    state.reloadStartedAt = 0;
    state.nextAt = Date.now() + (state.settings.refreshToContinueSeconds * 1000);
    await saveAndScheduleMonitorState(state, states);
    return;
  }

  if (state.phase === 'refresh-wait') {
    let sendResult = null;
    try {
      sendResult = await chrome.tabs.sendMessage(tabId, { type: MONITOR_ACTION_MESSAGE, action: 'send-continue' });
    } catch {}
    state.attemptsUsed = Number(state.attemptsUsed || 0) + 1;
    state.lastSendFailure = sendResult?.ok === true ? '' : String(sendResult?.reason || 'send-failed');
    if (state.attemptsUsed >= state.settings.attempts) {
      state.phase = 'exhausted';
      state.nextAt = 0;
      state.exhausted = true;
      await saveAndScheduleMonitorState(state, states);
      return;
    }
    state.phase = 'countdown';
    state.reloadStartedAt = 0;
    state.nextAt = Date.now() + (state.settings.timerMinutes * 60 * 1000);
    await saveAndScheduleMonitorState(state, states);
    return;
  }

  await clearMonitorState(tabId, { reason: 'invalid-phase' });
}

async function restoreMonitorAlarms() {
  const states = await readMonitorStates();
  for (const state of Object.values(states)) {
    if (!state?.enabled || state.exhausted === true || state.phase === 'exhausted' || !Number.isInteger(state?.tabId)) continue;
    scheduleMonitorAlarm(state);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (![MONITOR_SET_MESSAGE, MONITOR_GET_MESSAGE, MONITOR_STATUS_MESSAGE].includes(message?.type)) return false;
  const work = message.type === MONITOR_SET_MESSAGE
    ? () => setMonitorWatchdog(sender, message)
    : message.type === MONITOR_GET_MESSAGE
      ? () => getMonitorWatchdog(sender, message)
      : () => applyMonitorStatus(sender, message);
  queueMonitorWork(work)
    .then((result) => sendResponse(result))
    .catch(() => sendResponse({ enabled: false, reason: 'Monitor watchdog background failure.' }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!String(alarm?.name || '').startsWith(MONITOR_ALARM_PREFIX)) return;
  const tabId = Number.parseInt(String(alarm.name).slice(MONITOR_ALARM_PREFIX.length), 10);
  if (!Number.isInteger(tabId)) return;
  queueMonitorWork(() => handleMonitorAlarm(tabId)).catch(() => {});
});


  chrome.tabs.onRemoved.addListener((tabId) => {
    if (!Number.isInteger(tabId)) return;
    queueMonitorWork(() => clearMonitorState(tabId, { reason: 'tab-closed' })).catch(() => {});
  });

  chrome.runtime.onStartup.addListener(() => {
    queueMonitorWork(restoreMonitorAlarms).catch(() => {});
  });

  chrome.runtime.onInstalled.addListener(() => {
    queueMonitorWork(restoreMonitorAlarms).catch(() => {});
  });

  queueMonitorWork(restoreMonitorAlarms).catch(() => {});
})();
