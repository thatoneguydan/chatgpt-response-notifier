'use strict';

(() => {
  const RUNTIME_VERSION = 9;
  const previousRuntime = globalThis.ChatGPTQuickContinueConfig;
  if (Number(previousRuntime?.runtimeVersion || 0) === RUNTIME_VERSION) return;
  try { previousRuntime?.dispose?.(); } catch {}

  const STORAGE_KEY = 'quickContinueConfig';
  const DEFAULT_MANUAL_TIMESTAMP_TEXT = '[{time}] {message}';
  const MAX_PROJECTS = 40;
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
  const DEFAULT_WATCHDOG = Object.freeze({
    timerMinutes: 30,
    attempts: 3,
    respectStopStatusCodes: true,
    respectContinueStatusCodes: true,
    stopOnStatus: DEFAULT_STOP_ON_STATUS
  });
  const DEFAULT_SIMPLE_WATCHDOG = Object.freeze({
    timerMinutes: 30,
    attempts: 3,
    stopToRefreshSeconds: 30,
    refreshToContinueSeconds: 30
  });
  const listeners = new Set();
  let current = null;
  let loadPromise = null;

  const normalizeInline = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const normalizeTemplate = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim();
  const ensureTimePlaceholder = (value) => {
    const text = normalizeTemplate(value);
    if (!text || text.includes('{time}')) return text;
    return `[{time}] ${text}`;
  };
  const ensureManualMessageTemplate = (value) => {
    let text = ensureTimePlaceholder(value ?? DEFAULT_MANUAL_TIMESTAMP_TEXT);
    if (!text) return text;
    if (!text.includes('{message}')) text = `${text} {message}`;
    return text;
  };

  function normalizeProjectList(value) {
    if (!Array.isArray(value)) throw new Error('"projects" must be an array.');
    const seen = new Set();
    const projects = [];
    for (const entry of value) {
      if (typeof entry !== 'string') throw new Error('Every project title must be a string.');
      const title = normalizeInline(entry);
      if (!title) continue;
      const key = title.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      projects.push(title);
      if (projects.length >= MAX_PROJECTS) break;
    }
    return projects;
  }

  function normalizeWatchdog(value) {
    const raw = value == null ? {} : value;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('"watchdog" must be an object.');
    const timerMinutes = raw.timerMinutes == null ? DEFAULT_WATCHDOG.timerMinutes : Number(raw.timerMinutes);
    if (!Number.isFinite(timerMinutes) || timerMinutes < 0.1 || timerMinutes > 1440) {
      throw new Error('"watchdog.timerMinutes" must be between 0.1 and 1440.');
    }
    const attemptsRaw = raw.attempts == null ? DEFAULT_WATCHDOG.attempts : Number(raw.attempts);
    if (!Number.isInteger(attemptsRaw) || attemptsRaw < 0 || attemptsRaw > 20) {
      throw new Error('"watchdog.attempts" must be an integer between 0 and 20.');
    }
    const respectStopStatusCodes = raw.respectStopStatusCodes == null
      ? DEFAULT_WATCHDOG.respectStopStatusCodes
      : raw.respectStopStatusCodes;
    if (typeof respectStopStatusCodes !== 'boolean') {
      throw new Error('"watchdog.respectStopStatusCodes" must be true or false.');
    }
    const respectContinueStatusCodes = raw.respectContinueStatusCodes == null
      ? DEFAULT_WATCHDOG.respectContinueStatusCodes
      : raw.respectContinueStatusCodes;
    if (typeof respectContinueStatusCodes !== 'boolean') {
      throw new Error('"watchdog.respectContinueStatusCodes" must be true or false.');
    }
    const stopRaw = raw.stopOnStatus == null ? {} : raw.stopOnStatus;
    if (!stopRaw || typeof stopRaw !== 'object' || Array.isArray(stopRaw)) {
      throw new Error('"watchdog.stopOnStatus" must be an object.');
    }
    for (const key of Object.keys(stopRaw)) {
      if (!STATUS_CODES.includes(key)) throw new Error(`Unknown GitHub status code in watchdog.stopOnStatus: ${key}`);
      if (typeof stopRaw[key] !== 'boolean') throw new Error(`watchdog.stopOnStatus.${key} must be true or false.`);
    }
    const stopOnStatus = {};
    for (const code of STATUS_CODES) {
      stopOnStatus[code] = Object.prototype.hasOwnProperty.call(stopRaw, code)
        ? stopRaw[code]
        : DEFAULT_STOP_ON_STATUS[code];
    }
    return Object.freeze({
      timerMinutes: Math.round(timerMinutes * 1000) / 1000,
      attempts: attemptsRaw,
      respectStopStatusCodes,
      respectContinueStatusCodes,
      stopOnStatus: Object.freeze(stopOnStatus)
    });
  }

  function normalizeSimpleWatchdog(value) {
    const raw = value == null ? {} : value;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('"simpleWatchdog" must be an object.');
    const timerMinutes = raw.timerMinutes == null ? DEFAULT_SIMPLE_WATCHDOG.timerMinutes : Number(raw.timerMinutes);
    if (!Number.isFinite(timerMinutes) || timerMinutes < 0.1 || timerMinutes > 1440) {
      throw new Error('"simpleWatchdog.timerMinutes" must be between 0.1 and 1440.');
    }
    const attempts = raw.attempts == null ? DEFAULT_SIMPLE_WATCHDOG.attempts : Number(raw.attempts);
    if (!Number.isInteger(attempts) || attempts < 0 || attempts > 20) {
      throw new Error('"simpleWatchdog.attempts" must be an integer between 0 and 20.');
    }
    const stopToRefreshSeconds = raw.stopToRefreshSeconds == null
      ? DEFAULT_SIMPLE_WATCHDOG.stopToRefreshSeconds
      : Number(raw.stopToRefreshSeconds);
    if (!Number.isFinite(stopToRefreshSeconds) || stopToRefreshSeconds < 0 || stopToRefreshSeconds > 3600) {
      throw new Error('"simpleWatchdog.stopToRefreshSeconds" must be between 0 and 3600.');
    }
    const refreshToContinueSeconds = raw.refreshToContinueSeconds == null
      ? DEFAULT_SIMPLE_WATCHDOG.refreshToContinueSeconds
      : Number(raw.refreshToContinueSeconds);
    if (!Number.isFinite(refreshToContinueSeconds) || refreshToContinueSeconds < 0 || refreshToContinueSeconds > 3600) {
      throw new Error('"simpleWatchdog.refreshToContinueSeconds" must be between 0 and 3600.');
    }
    return Object.freeze({
      timerMinutes: Math.round(timerMinutes * 1000) / 1000,
      attempts,
      stopToRefreshSeconds: Math.round(stopToRefreshSeconds * 1000) / 1000,
      refreshToContinueSeconds: Math.round(refreshToContinueSeconds * 1000) / 1000
    });
  }

  function normalizeConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Config must be a JSON object.');
    const continueText = ensureTimePlaceholder(value.continueText);
    const projectText = ensureTimePlaceholder(value.projectText);
    const manualTimestampText = ensureManualMessageTemplate(value.manualTimestampText);
    if (!continueText) throw new Error('"continueText" must not be blank.');
    if (!projectText) throw new Error('"projectText" must not be blank.');
    if (!manualTimestampText) throw new Error('"manualTimestampText" must not be blank.');
    if (!projectText.includes('{project}')) throw new Error('"projectText" must include {project}.');
    if (!manualTimestampText.includes('{time}')) throw new Error('"manualTimestampText" must include {time}.');
    if (!manualTimestampText.includes('{message}')) throw new Error('"manualTimestampText" must include {message}.');
    return Object.freeze({
      continueText,
      projectText,
      manualTimestampText,
      watchdog: normalizeWatchdog(value.watchdog),
      simpleWatchdog: normalizeSimpleWatchdog(value.simpleWatchdog),
      projects: Object.freeze(normalizeProjectList(value.projects))
    });
  }

  function cloneConfig(value) {
    return {
      continueText: value.continueText,
      projectText: value.projectText,
      manualTimestampText: value.manualTimestampText,
      watchdog: {
        timerMinutes: value.watchdog.timerMinutes,
        attempts: value.watchdog.attempts,
        respectStopStatusCodes: value.watchdog.respectStopStatusCodes,
        respectContinueStatusCodes: value.watchdog.respectContinueStatusCodes,
        stopOnStatus: { ...value.watchdog.stopOnStatus }
      },
      simpleWatchdog: {
        timerMinutes: value.simpleWatchdog.timerMinutes,
        attempts: value.simpleWatchdog.attempts,
        stopToRefreshSeconds: value.simpleWatchdog.stopToRefreshSeconds,
        refreshToContinueSeconds: value.simpleWatchdog.refreshToContinueSeconds
      },
      projects: [...value.projects]
    };
  }

  function notify() {
    if (!current) return;
    const snapshot = cloneConfig(current);
    for (const listener of listeners) { try { listener(snapshot); } catch {} }
  }

  async function bundledConfig() {
    const response = await fetch(chrome.runtime.getURL('config.json'), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load config.json (HTTP ${response.status}).`);
    return normalizeConfig(await response.json());
  }

  async function load() {
    if (current) return cloneConfig(current);
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const defaults = await bundledConfig();
      let stored = null;
      try { stored = (await chrome.storage.local.get(STORAGE_KEY))?.[STORAGE_KEY] ?? null; } catch {}
      if (stored !== null) {
        try { current = normalizeConfig(stored); } catch { current = defaults; }
      } else current = defaults;
      loadPromise = null;
      return cloneConfig(current);
    })().catch((error) => { loadPromise = null; throw error; });
    return loadPromise;
  }

  async function save(value) {
    const normalized = normalizeConfig(value);
    await chrome.storage.local.set({ [STORAGE_KEY]: cloneConfig(normalized) });
    current = normalized;
    notify();
    return cloneConfig(current);
  }

  async function reset() {
    await chrome.storage.local.remove(STORAGE_KEY);
    current = await bundledConfig();
    notify();
    return cloneConfig(current);
  }

  function serialize(value = current) {
    if (!value) return '';
    const normalized = normalizeConfig(value);
    return JSON.stringify(cloneConfig(normalized), null, 2);
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    if (current) { try { listener(cloneConfig(current)); } catch {} }
    return () => listeners.delete(listener);
  }

  function handleStorageChanged(changes, areaName) {
    if (areaName !== 'local' || !Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) return;
    const next = changes[STORAGE_KEY]?.newValue;
    if (next === undefined) {
      bundledConfig().then((value) => { current = value; notify(); }).catch(() => {});
      return;
    }
    try { current = normalizeConfig(next); notify(); } catch {}
  }

  chrome.storage.onChanged.addListener(handleStorageChanged);

  globalThis.ChatGPTQuickContinueConfig = Object.freeze({
    runtimeVersion: RUNTIME_VERSION,
    load,
    save,
    reset,
    serialize,
    subscribe,
    normalizeConfig,
    normalizeWatchdog,
    normalizeSimpleWatchdog,
    statusCodes: STATUS_CODES,
    dispose() {
      try { chrome.storage.onChanged.removeListener(handleStorageChanged); } catch {}
      listeners.clear();
    }
  });
  globalThis.__chatgptQuickContinueLifecycle?.register?.(globalThis.ChatGPTQuickContinueConfig);
})();