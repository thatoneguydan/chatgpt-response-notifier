'use strict';

(() => {
  const RUNTIME_VERSION = 2;
  const TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const PRIMARY_WATCHDOG_ATTR = 'data-chatgpt-notifier-primary-watchdog';
  const PRIMARY_WATCHDOG_CONTROL_ATTR = 'data-chatgpt-notifier-primary-watchdog-control';
  const MONITOR_WATCHDOG_STATE_ATTR = 'data-chatgpt-quick-continue-monitor-watchdog-state';
  const MONITOR_ACTION_MESSAGE = 'QUICK_CONTINUE_MONITOR_WATCHDOG_ACTION';
  const MONITOR_STATE_MESSAGE = 'QUICK_CONTINUE_MONITOR_WATCHDOG_STATE';
  const ROUTE_CHANGED_MESSAGE = 'QUICK_CONTINUE_ROUTE_CHANGED';
  const MONITOR_SET_MESSAGE = 'QUICK_CONTINUE_MONITOR_WATCHDOG_SET';
  const MONITOR_GET_MESSAGE = 'QUICK_CONTINUE_MONITOR_WATCHDOG_GET';
  const MONITOR_STATUS_MESSAGE = 'QUICK_CONTINUE_MONITOR_WATCHDOG_STATUS';
  const MONITOR_CONTROL_MESSAGE = 'QUICK_CONTINUE_MONITOR_WATCHDOG_CONTROL';
  const TERMINAL_BRIDGE_MARKER = 'chatgpt-notifier-terminal-status-v1';
  const TERMINAL_QUERY_MARKER = 'chatgpt-notifier-terminal-status-query-v1';
  const TERMINAL_RESPONSE_MARKER = 'chatgpt-notifier-terminal-status-response-v1';
  const TERMINAL_QUERY_TIMEOUT_MS = 250;

  const previousRuntime = globalThis.__chatgptQuickContinueMonitorWatchdogRuntime;
  if (Number(previousRuntime?.version || 0) === RUNTIME_VERSION) return;
  try { previousRuntime?.dispose?.(); } catch {}

  const prompts = globalThis.ChatGPTQuickContinuePrompts;
  const configApi = globalThis.ChatGPTQuickContinueConfig;
  const sendApi = globalThis.ChatGPTQuickContinueSend;

  let activeConversationId = '';
  let monitorEnabled = false;
  let monitorState = null;
  let monitorRow = null;
  let monitorTickTimer = null;
  let lastMonitorStatusFingerprint = '';
  let monitorStatusInFlightFingerprint = '';
  let monitorConfig = null;
  let lastMonitorAuthorityToken = '';
  let lastMonitorControlCommandId = '';
  let monitorRestoreGeneration = 0;
  let monitorRequestGeneration = 0;
  let monitorRestoreReady = false;
  let lastTrustedMonitorResetAt = 0;
  let unsubscribeConfig = null;
  let disposed = false;
  let scheduled = false;
  let observer = null;

  function conversationIdFromUrl(rawUrl = location.href) {
    try {
      const url = new URL(String(rawUrl || ''), location.origin);
      const parts = url.pathname.split('/').filter(Boolean);
      for (let index = parts.length - 2; index >= 0; index -= 1) {
        if (parts[index] !== 'c') continue;
        const id = decodeURIComponent(parts[index + 1] || '').trim();
        if (id) return id;
      }
    } catch {}
    return '';
  }

  function showStatus(message) {
    if (disposed) return;
    try {
      const status = document.getElementById(TOOLBAR_ID)?.querySelector?.('[role="status"]');
      if (!status) return;
      const text = String(message || '');
      status.textContent = text;
      status.hidden = !text;
      if (!text) return;
      setTimeout(() => {
        try {
          if (status.textContent === text) {
            status.textContent = '';
            status.hidden = true;
          }
        } catch {}
      }, 2200);
    } catch {}
  }

  function ensureMonitorRow() {
    if (disposed) return null;
    const root = document.getElementById(TOOLBAR_ID);
    if (!root) {
      monitorRow = null;
      return null;
    }
    let row = root.querySelector('#chatgpt-quick-continue-monitor-countdown');
    if (!row) {
      row = document.createElement('div');
      row.id = 'chatgpt-quick-continue-monitor-countdown';
      row.hidden = true;
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', 'Monitor auto-continue timer');
      root.append(row);
    }
    monitorRow = row;
    return row;
  }

  function renderMonitorCountdown() {
    if (disposed) return;
    const row = monitorRow?.isConnected ? monitorRow : ensureMonitorRow();
    if (!row) return;
    const active = monitorState?.enabled === true;
    const exhausted = monitorState?.exhausted === true || monitorState?.phase === 'exhausted';
    const remaining = Math.max(0, Number(monitorState?.attemptsRemaining || 0));
    const seconds = Math.max(0, Math.ceil((Number(monitorState?.nextAt || 0) - Date.now()) / 1000));
    const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    const phase = monitorState?.phase;
    const label = phase === 'stop-wait' ? 'Refresh in'
      : phase === 'refresh-loading' ? 'Waiting for refresh'
      : phase === 'refresh-wait' ? 'Continue in'
      : 'Next auto-continue';
    const text = active && exhausted ? 'Monitor: auto-continues exhausted'
      : active ? `Monitor: ${label} ${countdown} · ${remaining} auto-continues left`
      : '';
    if (row.textContent !== text) row.textContent = text;
    if (row.hidden !== !text) row.hidden = !text;
  }

  function publishMonitorWatchdogState() {
    if (disposed) return;
    const snapshot = {
      conversationId: String(monitorState?.conversationId || activeConversationId || conversationIdFromUrl() || ''),
      enabled: monitorState?.enabled === true,
      paused: monitorState?.paused === true || monitorState?.phase === 'paused',
      pauseReason: String(monitorState?.pauseReason || ''),
      phase: String(monitorState?.phase || ''),
      exhausted: monitorState?.exhausted === true || monitorState?.phase === 'exhausted',
      attemptsRemaining: Math.max(0, Number(monitorState?.attemptsRemaining || 0)),
      nextAt: Math.max(0, Number(monitorState?.nextAt || 0)),
      reason: String(monitorState?.reason || '')
    };
    try { document.documentElement?.setAttribute?.(MONITOR_WATCHDOG_STATE_ATTR, JSON.stringify(snapshot)); } catch {}
  }

  function renderMonitorState(state) {
    if (disposed) return;
    monitorState = state && typeof state === 'object' ? state : { enabled: state === true };
    monitorEnabled = monitorState.enabled === true;
    if (typeof monitorState.lastStatusFingerprint === 'string') {
      lastMonitorStatusFingerprint = monitorState.lastStatusFingerprint;
    }
    if (!monitorEnabled) {
      lastMonitorStatusFingerprint = '';
      monitorStatusInFlightFingerprint = '';
    }
    const exhausted = monitorState.exhausted === true || monitorState.phase === 'exhausted';
    if (monitorEnabled && !exhausted && monitorTickTimer === null) {
      monitorTickTimer = setInterval(renderMonitorCountdown, 1000);
    }
    if ((!monitorEnabled || exhausted) && monitorTickTimer !== null) {
      clearInterval(monitorTickTimer);
      monitorTickTimer = null;
    }
    renderMonitorCountdown();
    publishMonitorWatchdogState();
  }

  function normalizeTerminalSignal(value) {
    const terminal = value && typeof value === 'object' ? value : null;
    if (!terminal) return null;
    const conversationId = String(terminal.conversationId || '').trim();
    const statusCode = String(terminal.statusCode || '').trim();
    const statusClass = String(terminal.statusClass || '').trim();
    const fingerprint = String(terminal.fingerprint || '').trim();
    if (!conversationId || !fingerprint || !['stop', 'continue'].includes(statusClass)) return null;
    if (!Array.from(configApi?.statusCodes || []).includes(statusCode)) return null;
    return { conversationId, statusCode, statusClass, fingerprint };
  }

  async function applyTerminalSignal(signalValue) {
    if (disposed || !monitorEnabled) return null;
    const signal = normalizeTerminalSignal(signalValue);
    if (!signal || signal.conversationId !== conversationIdFromUrl()) return null;
    const config = monitorConfig;
    if (!config?.monitorWatchdog) return null;
    const respectClass = signal.statusClass === 'stop'
      ? config.monitorWatchdog.respectStopStatusCodes !== false
      : config.monitorWatchdog.respectContinueStatusCodes !== false;
    if (!respectClass) return null;
    if (
      signal.fingerprint === lastMonitorStatusFingerprint
      || signal.fingerprint === monitorStatusInFlightFingerprint
    ) return null;

    monitorStatusInFlightFingerprint = signal.fingerprint;
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({
        type: MONITOR_STATUS_MESSAGE,
        conversationId: signal.conversationId,
        statusCode: signal.statusCode,
        statusClass: signal.statusClass,
        fingerprint: signal.fingerprint,
        settings: config.monitorWatchdog
      });
    } catch {}
    if (disposed) return null;
    if (monitorStatusInFlightFingerprint === signal.fingerprint) monitorStatusInFlightFingerprint = '';
    if (response && typeof response === 'object') {
      lastMonitorStatusFingerprint = signal.fingerprint;
      renderMonitorState(response);
    }
    return response;
  }

  function handleNotifierTerminalMessage(event) {
    if (event?.source !== window || event?.origin !== location.origin) return;
    const data = event?.data;
    if (!data || data.marker !== TERMINAL_BRIDGE_MARKER) return;
    applyTerminalSignal(data.terminal).catch(() => {});
  }

  function queryNotifierTerminalSignal(timeoutMs = TERMINAL_QUERY_TIMEOUT_MS) {
    return new Promise((resolve) => {
      if (disposed) { resolve(null); return; }
      const requestId = `quick-continue-monitor-terminal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let timer = null;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        try { window.removeEventListener('message', onMessage); } catch {}
        resolve(normalizeTerminalSignal(value));
      };
      const onMessage = (event) => {
        if (event?.source !== window || event?.origin !== location.origin) return;
        const data = event?.data;
        if (!data || data.marker !== TERMINAL_RESPONSE_MARKER || String(data.requestId || '') !== requestId) return;
        finish(data.terminal || null);
      };
      try { window.addEventListener('message', onMessage); } catch { resolve(null); return; }
      timer = setTimeout(() => finish(null), Math.max(25, Number(timeoutMs) || TERMINAL_QUERY_TIMEOUT_MS));
      try { window.postMessage({ marker: TERMINAL_QUERY_MARKER, requestId }, location.origin); }
      catch { finish(null); }
    });
  }

  async function setMonitorEnabled(nextEnabled) {
    if (disposed) return;
    const generation = ++monitorRequestGeneration;
    monitorRestoreGeneration += 1;
    const startedAt = Date.now();
    const conversationId = conversationIdFromUrl();
    let config = monitorConfig;
    if (nextEnabled && !config) {
      try { config = await configApi?.load?.(); } catch {}
    }
    if (disposed || generation !== monitorRequestGeneration) return;
    if (nextEnabled && !config?.monitorWatchdog) {
      showStatus('Monitor watchdog config unavailable.');
      return;
    }

    let baselineSignal = null;
    if (nextEnabled) {
      try { baselineSignal = await queryNotifierTerminalSignal(); } catch {}
      if (disposed || generation !== monitorRequestGeneration || conversationIdFromUrl() !== conversationId) return;
    }
    const baselineStatusFingerprint = baselineSignal?.conversationId === conversationId
      ? String(baselineSignal.fingerprint || '') : '';
    lastMonitorStatusFingerprint = baselineStatusFingerprint;
    renderMonitorState(nextEnabled ? {
      enabled: true,
      phase: 'countdown',
      attemptsRemaining: config.monitorWatchdog.attempts,
      nextAt: startedAt + config.monitorWatchdog.timerMinutes * 60_000,
      lastStatusFingerprint: baselineStatusFingerprint
    } : { enabled: false });

    let response = null;
    try {
      response = await chrome.runtime.sendMessage({
        type: MONITOR_SET_MESSAGE,
        enabled: nextEnabled === true,
        conversationId,
        startedAt,
        settings: config?.monitorWatchdog,
        baselineStatusFingerprint
      });
    } catch {}
    if (disposed || generation !== monitorRequestGeneration || conversationIdFromUrl() !== conversationId) return;
    renderMonitorState(response);
    if (nextEnabled && response?.enabled !== true) {
      showStatus(String(response?.reason || 'Monitor watchdog could not start.'));
    }
  }

  function monitorWatchdogAuthority() {
    let raw = '';
    try { raw = String(document.documentElement?.getAttribute?.(PRIMARY_WATCHDOG_ATTR) || ''); } catch {}
    if (!raw) return null;
    let value = null;
    try { value = JSON.parse(raw); } catch { return null; }
    const conversationId = String(value?.conversationId || '');
    if (conversationId !== conversationIdFromUrl()) return null;
    return {
      conversationId,
      enabled: value?.enabled === true,
      stateRevision: Math.max(0, Number(value?.stateRevision || 0))
    };
  }

  function applyMonitorWatchdogAuthority() {
    if (disposed || !monitorRestoreReady) return;
    const authority = monitorWatchdogAuthority();
    if (!authority) return;
    const token = `${authority.conversationId}|${authority.enabled ? 1 : 0}|${authority.stateRevision}`;

    // The first authority value seen after page load or SPA route entry is a
    // baseline, not a command. The watchdog's persisted state is authoritative
    // across refreshes, so merely reconstructing the green Monitor UI must not
    // restart a timer that was stopped, exhausted, or manually paused.
    if (!lastMonitorAuthorityToken) {
      lastMonitorAuthorityToken = token;
      return;
    }
    if (token === lastMonitorAuthorityToken) return;
    lastMonitorAuthorityToken = token;
    if (authority.enabled !== monitorEnabled) setMonitorEnabled(authority.enabled).catch(() => {});
  }

  function monitorWatchdogControl() {
    let raw = '';
    try { raw = String(document.documentElement?.getAttribute?.(PRIMARY_WATCHDOG_CONTROL_ATTR) || ''); } catch {}
    if (!raw) return null;
    let value = null;
    try { value = JSON.parse(raw); } catch { return null; }
    const conversationId = String(value?.conversationId || '').trim();
    const action = String(value?.action || '').trim();
    const commandId = String(value?.commandId || '').trim();
    if (!conversationId || conversationId !== conversationIdFromUrl()) return null;
    if (!['pause', 'resume', 'reset'].includes(action) || !commandId) return null;
    return { conversationId, action, commandId };
  }

  async function applyMonitorWatchdogControl() {
    if (disposed || !monitorRestoreReady) return;
    const control = monitorWatchdogControl();
    if (!control || control.commandId === lastMonitorControlCommandId) return;
    lastMonitorControlCommandId = control.commandId;

    let config = monitorConfig;
    if (!config) {
      try { config = await configApi?.load?.(); } catch {}
    }
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({
        type: MONITOR_CONTROL_MESSAGE,
        conversationId: control.conversationId,
        action: control.action,
        settings: config?.monitorWatchdog
      });
    } catch {}
    if (disposed || conversationIdFromUrl() !== control.conversationId) return;
    if (response && typeof response === 'object') renderMonitorState(response);
    if (control.action === 'resume' && response?.enabled !== true) {
      showStatus(String(response?.reason || 'Monitor watchdog could not resume.'));
    }
  }

  async function restoreMonitorForConversation(conversationId) {
    const generation = ++monitorRestoreGeneration;
    monitorRestoreReady = false;
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({ type: MONITOR_GET_MESSAGE, conversationId });
    } catch {}
    if (disposed || generation !== monitorRestoreGeneration || activeConversationId !== conversationId) return;
    renderMonitorState(response);
    if (response?.enabled === true) {
      let signal = null;
      try { signal = await queryNotifierTerminalSignal(); } catch {}
      if (disposed || generation !== monitorRestoreGeneration || activeConversationId !== conversationId) return;
      if (signal) await applyTerminalSignal(signal);
    }
    if (disposed || generation !== monitorRestoreGeneration || activeConversationId !== conversationId) return;
    monitorRestoreReady = true;
    applyMonitorWatchdogAuthority();
    applyMonitorWatchdogControl().catch(() => {});
  }

  function composerElement() {
    for (const selector of [
      '#prompt-textarea',
      'textarea[data-testid="prompt-textarea"]',
      '[contenteditable="true"][data-testid="prompt-textarea"]',
      '[contenteditable="true"][data-lexical-editor="true"]'
    ]) {
      let node = null;
      try { node = document.querySelector(selector); } catch {}
      if (!node || node.disabled || node.getAttribute?.('aria-disabled') === 'true') continue;
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement || node.isContentEditable) return node;
    }
    return null;
  }

  function clickChatGptStop() {
    for (const selector of [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop response"]',
      'button[aria-label="Stop"]'
    ]) {
      let button = null;
      try { button = document.querySelector(selector); } catch {}
      if (!button || button.disabled || button.getAttribute?.('aria-disabled') === 'true') continue;
      try {
        button.click();
        return true;
      } catch {}
    }
    return false;
  }

  async function forceSendContinue() {
    const composer = composerElement();
    if (!composer) return { ok: false, reason: 'composer-not-found' };
    let config = null;
    try { config = await configApi?.load?.(); } catch {}
    if (!config?.continueText || !prompts || !sendApi) return { ok: false, reason: 'runtime-unavailable' };
    const text = prompts.continuePrompt(config.continueText, new Date());
    if (!text) return { ok: false, reason: 'continue-text-empty' };
    try {
      return await sendApi.submit(composer, text, { replace: true, timeoutMs: 5000 });
    } catch {
      return { ok: false, reason: 'send-threw' };
    }
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (disposed) return false;
    if (message?.type === ROUTE_CHANGED_MESSAGE) {
      scheduleSync();
      sendResponse?.({ ok: true });
      return false;
    }
    if (message?.type === MONITOR_STATE_MESSAGE) {
      monitorRestoreGeneration += 1;
      if (!message.state?.conversationId || message.state.conversationId === conversationIdFromUrl()) {
        renderMonitorState(message.state);
      }
      sendResponse?.({ ok: true });
      return false;
    }
    if (message?.type !== MONITOR_ACTION_MESSAGE) return false;
    if (message.action === 'stop') {
      sendResponse?.({ ok: true, clicked: clickChatGptStop() });
      return false;
    }
    if (message.action === 'send-continue') {
      forceSendContinue()
        .then((result) => sendResponse?.(result))
        .catch(() => sendResponse?.({ ok: false, reason: 'send-failed' }));
      return true;
    }
    sendResponse?.({ ok: false, reason: 'unknown-action' });
    return false;
  }

  function syncRoute() {
    scheduled = false;
    if (disposed) return;
    ensureMonitorRow();
    const nextConversationId = conversationIdFromUrl();
    if (nextConversationId !== activeConversationId) {
      activeConversationId = nextConversationId;
      lastMonitorStatusFingerprint = '';
      monitorStatusInFlightFingerprint = '';
      lastMonitorAuthorityToken = '';
      lastMonitorControlCommandId = '';
      monitorRestoreReady = false;
      restoreMonitorForConversation(nextConversationId).catch(() => {});
    } else {
      applyMonitorWatchdogAuthority();
      renderMonitorCountdown();
    }
  }

  function scheduleSync() {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(syncRoute);
  }

  function quickToolbarSendControl(node) {
    let control = null;
    try { control = node?.closest?.(`#${TOOLBAR_ID} button`); } catch {}
    if (!control || control.disabled === true || control.getAttribute?.('aria-disabled') === 'true') return null;
    const label = String(control.getAttribute?.('aria-label') || '').trim();
    if (
      label === 'Send timestamped Continue'
      || label === 'Send custom Project Continue'
      || /^Continue\s+.+/.test(label)
    ) return control;
    return null;
  }

  function nativeSendControl(node) {
    let button = null;
    try { button = node?.closest?.('button'); } catch {}
    if (!button || button.disabled === true || button.getAttribute?.('aria-disabled') === 'true') return null;
    const testId = String(button.getAttribute?.('data-testid') || '').toLowerCase();
    const aria = String(button.getAttribute?.('aria-label') || '').toLowerCase();
    if (!(testId.includes('send-button') || /^send(?:\s|$)/.test(aria) || aria.includes('send message'))) return null;
    return button;
  }

  function restartMonitorWatchdogFromTrustedSend() {
    if (disposed || !monitorRestoreReady) return;
    const authority = monitorWatchdogAuthority();
    if (authority?.enabled !== true) return;
    if (monitorState?.paused === true && monitorState?.pauseReason === 'manual') return;
    const now = Date.now();
    if (now - lastTrustedMonitorResetAt < 250) return;
    lastTrustedMonitorResetAt = now;
    setMonitorEnabled(true).catch(() => {});
  }

  function handleTrustedSendClick(event) {
    if (event?.isTrusted !== true) return;
    if (!quickToolbarSendControl(event.target) && !nativeSendControl(event.target)) return;
    restartMonitorWatchdogFromTrustedSend();
  }

  function handleTrustedSendKeydown(event) {
    if (event?.isTrusted !== true || event?.key !== 'Enter') return;
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
    const target = event?.target;
    let composer = null;
    try {
      composer = target?.closest?.(
        '#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid="prompt-textarea"], [contenteditable="true"][data-lexical-editor="true"]'
      );
    } catch {}
    if (!composer) return;
    restartMonitorWatchdogFromTrustedSend();
  }

  function handleDocumentMutations(records) {
    if (disposed) return;
    const routeChanged = conversationIdFromUrl() !== activeConversationId;
    if (routeChanged || !monitorRow?.isConnected) scheduleSync();
    const attributes = new Set(
      Array.from(records || [])
        .filter((record) => record.type === 'attributes')
        .map((record) => String(record.attributeName || ''))
    );
    if (attributes.has(PRIMARY_WATCHDOG_ATTR)) applyMonitorWatchdogAuthority();
    if (attributes.has(PRIMARY_WATCHDOG_CONTROL_ATTR)) applyMonitorWatchdogControl().catch(() => {});
  }

  try {
    unsubscribeConfig = configApi?.subscribe?.((config) => {
      if (!disposed) monitorConfig = config;
    });
    configApi?.load?.()
      .then((config) => { if (!disposed) monitorConfig = config; })
      .catch(() => {});
  } catch {}

  observer = new MutationObserver(handleDocumentMutations);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [PRIMARY_WATCHDOG_ATTR, PRIMARY_WATCHDOG_CONTROL_ATTR]
  });
  document.addEventListener('click', handleTrustedSendClick, true);
  document.addEventListener('keydown', handleTrustedSendKeydown, true);
  window.addEventListener('popstate', scheduleSync, true);
  window.addEventListener('hashchange', scheduleSync, true);
  window.addEventListener('message', handleNotifierTerminalMessage);
  try { globalThis.navigation?.addEventListener?.('navigatesuccess', scheduleSync); } catch {}
  try { chrome.runtime.onMessage.addListener(handleRuntimeMessage); } catch {}
  scheduleSync();

  const runtime = Object.freeze({
    version: RUNTIME_VERSION,
    get monitorEnabled() { return monitorEnabled; },
    queryNotifierTerminalSignal,
    dispose() {
      if (disposed) return;
      disposed = true;
      monitorRestoreGeneration += 1;
      monitorRequestGeneration += 1;
      try { unsubscribeConfig?.(); } catch {}
      try { if (monitorTickTimer !== null) clearInterval(monitorTickTimer); } catch {}
      try { monitorRow?.remove(); } catch {}
      try { observer?.disconnect(); } catch {}
      try { document.removeEventListener('click', handleTrustedSendClick, true); } catch {}
      try { document.removeEventListener('keydown', handleTrustedSendKeydown, true); } catch {}
      try { window.removeEventListener('popstate', scheduleSync, true); } catch {}
      try { window.removeEventListener('hashchange', scheduleSync, true); } catch {}
      try { window.removeEventListener('message', handleNotifierTerminalMessage); } catch {}
      try { globalThis.navigation?.removeEventListener?.('navigatesuccess', scheduleSync); } catch {}
      try { chrome.runtime.onMessage.removeListener(handleRuntimeMessage); } catch {}
      try { document.documentElement?.removeAttribute?.(MONITOR_WATCHDOG_STATE_ATTR); } catch {}
      monitorRow = null;
      if (globalThis.__chatgptQuickContinueMonitorWatchdogRuntime === runtime) {
        delete globalThis.__chatgptQuickContinueMonitorWatchdogRuntime;
      }
    }
  });

  globalThis.__chatgptQuickContinueMonitorWatchdogRuntime = runtime;
  globalThis.__chatgptQuickContinueLifecycle?.register?.(runtime);
})();
