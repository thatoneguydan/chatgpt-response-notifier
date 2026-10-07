'use strict';

(() => {
  const RUNTIME_VERSION = 11;
  const STORAGE_PREFIX = 'quick-continue:manual-timestamp:';
  const CLOCK_SELECTOR = '[aria-label="Current local time"]';
  const TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const SIMPLE_BUTTON_ID = 'chatgpt-quick-continue-simple-watchdog';
  const SIMPLE_MENU_ITEMS_ID = 'chatgpt-quick-continue-menu-items';
  const PRIMARY_WATCHDOG_ATTR = 'data-chatgpt-notifier-primary-watchdog';
  const SIMPLE_ACTION_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_ACTION';
  const SIMPLE_STATE_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_STATE';
  const SIMPLE_SET_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_SET';
  const SIMPLE_GET_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_GET';
  const SIMPLE_STATUS_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_STATUS';
  const TERMINAL_BRIDGE_MARKER = 'chatgpt-notifier-terminal-status-v1';
  const TERMINAL_QUERY_MARKER = 'chatgpt-notifier-terminal-status-query-v1';
  const TERMINAL_RESPONSE_MARKER = 'chatgpt-notifier-terminal-status-response-v1';
  const TERMINAL_QUERY_TIMEOUT_MS = 250;
  const previousRuntime = globalThis.__chatgptQuickContinueConversationStateRuntime;
  if (Number(previousRuntime?.version || 0) === RUNTIME_VERSION) return;
  try { previousRuntime?.dispose?.(); } catch {}

  const prompts = globalThis.ChatGPTQuickContinuePrompts;
  const configApi = globalThis.ChatGPTQuickContinueConfig;
  const sendApi = globalThis.ChatGPTQuickContinueSend;

  let activeConversationId = null;
  let desiredEnabled = false;
  let provisionalEnabled = false;
  let provisionalTouched = false;
  let restoreGeneration = 0;
  let simpleEnabled = false;
  let simpleButton = null;
  let simpleRestoreGeneration = 0;
  let simpleRequestGeneration = 0;
  let simpleState = null;
  let simpleRow = null;
  let simpleTickTimer = null;
  let lastSimpleStatusFingerprint = '';
  let simpleStatusInFlightFingerprint = '';
  let simpleConfig = null;
  let lastMonitorAuthorityToken = '';
  let simpleRestoreReady = false;
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

  const storageKey = (conversationId) => `${STORAGE_PREFIX}${String(conversationId || '')}`;

  function currentEnabled() {
    try {
      const runtime = globalThis.__chatgptQuickContinueHoverEditRuntime;
      if (runtime && typeof runtime.manualTimestampEnabled === 'boolean') return runtime.manualTimestampEnabled;
    } catch {}
    try { return document.querySelector(CLOCK_SELECTOR)?.getAttribute('aria-pressed') === 'true'; }
    catch { return false; }
  }

  function applyDesiredState() {
    if (disposed) return false;
    const runtime = globalThis.__chatgptQuickContinueHoverEditRuntime;
    if (typeof runtime?.setManualTimestampEnabled === 'function') {
      try {
        runtime.setManualTimestampEnabled(desiredEnabled);
        return runtime.manualTimestampEnabled === desiredEnabled;
      } catch {}
    }
    const clock = document.querySelector(CLOCK_SELECTOR);
    if (!clock) return false;
    if (currentEnabled() === desiredEnabled) return true;
    try {
      clock.click();
      return currentEnabled() === desiredEnabled;
    } catch {
      return false;
    }
  }

  async function readStoredState(conversationId) {
    const key = storageKey(conversationId);
    const values = await chrome.storage.local.get(key);
    return {
      found: Object.prototype.hasOwnProperty.call(values || {}, key),
      enabled: values?.[key] === true
    };
  }

  async function writeStoredState(conversationId, enabled) {
    if (!conversationId) return;
    await chrome.storage.local.set({ [storageKey(conversationId)]: enabled === true });
  }

  async function restoreForConversation(nextConversationId, previousConversationId) {
    const generation = ++restoreGeneration;
    const carryProvisional = !previousConversationId && provisionalTouched;
    desiredEnabled = carryProvisional ? provisionalEnabled : false;
    applyDesiredState();

    if (!nextConversationId) {
      if (!carryProvisional) {
        provisionalEnabled = false;
        provisionalTouched = false;
      }
      return;
    }

    let stored = { found: false, enabled: false };
    try { stored = await readStoredState(nextConversationId); } catch {}
    if (disposed || generation !== restoreGeneration || activeConversationId !== nextConversationId) return;

    if (stored.found) {
      desiredEnabled = stored.enabled;
      provisionalEnabled = stored.enabled;
      provisionalTouched = false;
      applyDesiredState();
      return;
    }

    if (carryProvisional) {
      desiredEnabled = provisionalEnabled;
      try { await writeStoredState(nextConversationId, desiredEnabled); } catch {}
      if (generation !== restoreGeneration || activeConversationId !== nextConversationId) return;
      provisionalTouched = false;
      applyDesiredState();
      return;
    }

    desiredEnabled = false;
    provisionalEnabled = false;
    provisionalTouched = false;
    applyDesiredState();
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

  function renderSimpleCountdown() {
    if (disposed || !simpleRow) return;
    const active = simpleState?.enabled === true;
    const exhausted = simpleState?.exhausted === true || simpleState?.phase === 'exhausted';
    const remaining = Math.max(0, Number(simpleState?.attemptsRemaining || 0));
    const seconds = Math.max(0, Math.ceil((Number(simpleState?.nextAt || 0) - Date.now()) / 1000));
    const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    const phase = simpleState?.phase;
    const label = phase === 'stop-wait' ? 'Refresh in' : phase === 'refresh-loading' ? 'Waiting for refresh' : phase === 'refresh-wait' ? 'Continue in' : 'Next auto-continue';
    const text = active && exhausted ? 'Auto-continues exhausted'
      : active ? `${label} ${countdown} · ${remaining} auto-continues left`
      : '';
    if (simpleRow.textContent !== text) simpleRow.textContent = text;
    if (simpleRow.hidden !== !text) simpleRow.hidden = !text;
    const root = simpleRow.parentElement;
    const showing = String(Boolean(text));
    if (root && root.getAttribute('data-simple-watchdog-active') !== showing) root.setAttribute('data-simple-watchdog-active', showing);
  }

  function renderSimpleState(state) {
    if (disposed) return;
    simpleState = state && typeof state === 'object' ? state : { enabled: state === true };
    simpleEnabled = simpleState.enabled === true;
    if (typeof simpleState.lastStatusFingerprint === 'string') lastSimpleStatusFingerprint = simpleState.lastStatusFingerprint;
    if (!simpleEnabled) {
      lastSimpleStatusFingerprint = '';
      simpleStatusInFlightFingerprint = '';
    }
    const exhausted = simpleState.exhausted === true || simpleState.phase === 'exhausted';
    if (simpleEnabled && !exhausted && simpleTickTimer === null) simpleTickTimer = setInterval(renderSimpleCountdown, 1000);
    if ((!simpleEnabled || exhausted) && simpleTickTimer !== null) { clearInterval(simpleTickTimer); simpleTickTimer = null; }
    renderSimpleCountdown();
    if (!simpleButton) return;
    const pressed = String(simpleEnabled);
    if (simpleButton.getAttribute('aria-pressed') !== pressed) simpleButton.setAttribute('aria-pressed', pressed);
    Object.assign(simpleButton.style, {
      background: simpleEnabled ? '#16a34a' : 'var(--main-surface-secondary, rgba(127,127,127,.10))',
      color: simpleEnabled ? '#fff' : 'inherit'
    });
  }

  function styleSimpleButton(button) {
    Object.assign(button.style, {
      border: '1px solid var(--border-light, rgba(127,127,127,.25))',
      borderRadius: '6px',
      padding: '5px 7px',
      background: 'var(--main-surface-secondary, rgba(127,127,127,.10))',
      color: 'inherit',
      font: 'inherit',
      fontWeight: '600',
      cursor: 'pointer'
    });
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
    if (disposed || !simpleEnabled) return null;
    const signal = normalizeTerminalSignal(signalValue);
    if (!signal || signal.conversationId !== conversationIdFromUrl()) return null;
    const config = simpleConfig;
    if (!config?.simpleWatchdog) return null;
    const respectClass = signal.statusClass === 'stop'
      ? config.simpleWatchdog.respectStopStatusCodes !== false
      : config.simpleWatchdog.respectContinueStatusCodes !== false;
    if (!respectClass) return null;
    if (signal.fingerprint === lastSimpleStatusFingerprint || signal.fingerprint === simpleStatusInFlightFingerprint) return null;

    simpleStatusInFlightFingerprint = signal.fingerprint;
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({
        type: SIMPLE_STATUS_MESSAGE,
        conversationId: signal.conversationId,
        statusCode: signal.statusCode,
        statusClass: signal.statusClass,
        fingerprint: signal.fingerprint,
        settings: config.simpleWatchdog
      });
    } catch {}
    if (disposed) return null;
    if (simpleStatusInFlightFingerprint === signal.fingerprint) simpleStatusInFlightFingerprint = '';
    if (response && typeof response === 'object') {
      lastSimpleStatusFingerprint = signal.fingerprint;
      renderSimpleState(response);
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
      const requestId = `quick-continue-terminal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

  async function setSimpleEnabled(nextEnabled) {
    if (disposed) return;
    const generation = ++simpleRequestGeneration;
    simpleRestoreGeneration += 1;
    const startedAt = Date.now();
    const conversationId = conversationIdFromUrl();
    let config = simpleConfig;
    if (nextEnabled && !config) { try { config = await configApi?.load?.(); } catch {} }
    if (disposed || generation !== simpleRequestGeneration) return;
    if (nextEnabled && !config?.simpleWatchdog) {
      showStatus('Simple watchdog config unavailable.');
      return;
    }

    let baselineSignal = null;
    if (nextEnabled) {
      try { baselineSignal = await queryNotifierTerminalSignal(); } catch {}
      if (disposed || generation !== simpleRequestGeneration || conversationIdFromUrl() !== conversationId) return;
    }
    const baselineStatusFingerprint = baselineSignal?.conversationId === conversationId
      ? String(baselineSignal.fingerprint || '') : '';
    lastSimpleStatusFingerprint = baselineStatusFingerprint;
    renderSimpleState(nextEnabled ? {
      enabled: true, phase: 'countdown', attemptsRemaining: config.simpleWatchdog.attempts,
      nextAt: startedAt + config.simpleWatchdog.timerMinutes * 60_000,
      lastStatusFingerprint: baselineStatusFingerprint
    } : { enabled: false });
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({
        type: SIMPLE_SET_MESSAGE,
        enabled: nextEnabled === true,
        conversationId,
        startedAt,
        settings: config?.simpleWatchdog,
        baselineStatusFingerprint
      });
    } catch {}
    if (disposed || generation !== simpleRequestGeneration || conversationIdFromUrl() !== conversationId) return;
    renderSimpleState(response);
    if (nextEnabled && response?.enabled !== true) showStatus(String(response?.reason || 'Simple watchdog could not start.'));
  }

  function handleSimpleButtonClick(event) {
    event.preventDefault();
    event.stopPropagation();
    setSimpleEnabled(!simpleEnabled).catch(() => {});
  }

  function ensureSimpleButton() {
    if (disposed) return;
    const root = document.getElementById(TOOLBAR_ID);
    const menuItems = root?.querySelector?.(`#${SIMPLE_MENU_ITEMS_ID}`) || null;
    if (!root || !menuItems) {
      simpleButton = null;
      simpleRow = root?.querySelector?.('#chatgpt-quick-continue-simple-countdown') || null;
      return;
    }
    simpleRow = root.querySelector('#chatgpt-quick-continue-simple-countdown');
    if (!simpleRow) {
      simpleRow = document.createElement('div');
      simpleRow.id = 'chatgpt-quick-continue-simple-countdown';
      simpleRow.hidden = true;
      simpleRow.setAttribute('role', 'group');
      simpleRow.setAttribute('aria-label', 'Primary auto-continue timer');
      root.append(simpleRow);
    }
    const existing = root.querySelector(`#${SIMPLE_BUTTON_ID}`);
    if (existing) {
      simpleButton = existing;
      if (simpleButton.parentElement !== menuItems) menuItems.prepend(simpleButton);
      renderSimpleState(simpleState);
      return;
    }
    const button = document.createElement('button');
    button.id = SIMPLE_BUTTON_ID;
    button.type = 'button';
    button.textContent = 'Simple watchdog';
    button.setAttribute('aria-label', 'Toggle Simple watchdog');
    button.setAttribute('aria-pressed', String(simpleEnabled));
    styleSimpleButton(button);
    Object.assign(button.style, { width: '100%', textAlign: 'left' });
    button.addEventListener('click', handleSimpleButtonClick);
    menuItems.prepend(button);
    simpleButton = button;
    renderSimpleState(simpleState);
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
    if (disposed || !simpleRestoreReady) return;
    const authority = monitorWatchdogAuthority();
    if (!authority) return;
    const token = `${authority.conversationId}|${authority.enabled ? 1 : 0}|${authority.stateRevision}`;
    if (token === lastMonitorAuthorityToken) return;
    lastMonitorAuthorityToken = token;
    if (authority.enabled !== simpleEnabled) setSimpleEnabled(authority.enabled).catch(() => {});
  }

  async function restoreSimpleForConversation(conversationId) {
    const generation = ++simpleRestoreGeneration;
    simpleRestoreReady = false;
    let response = null;
    try { response = await chrome.runtime.sendMessage({ type: SIMPLE_GET_MESSAGE, conversationId }); } catch {}
    if (disposed || generation !== simpleRestoreGeneration || activeConversationId !== conversationId) return;
    renderSimpleState(response);
    if (response?.enabled === true) {
      let signal = null;
      try { signal = await queryNotifierTerminalSignal(); } catch {}
      if (disposed || generation !== simpleRestoreGeneration || activeConversationId !== conversationId) return;
      if (signal) await applyTerminalSignal(signal);
    }
    if (disposed || generation !== simpleRestoreGeneration || activeConversationId !== conversationId) return;
    simpleRestoreReady = true;
    applyMonitorWatchdogAuthority();
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
    if (message?.type === SIMPLE_STATE_MESSAGE) {
      simpleRestoreGeneration += 1;
      if (!message.state?.conversationId || message.state.conversationId === conversationIdFromUrl()) renderSimpleState(message.state);
      sendResponse?.({ ok: true });
      return false;
    }
    if (message?.type !== SIMPLE_ACTION_MESSAGE) return false;
    if (message.action === 'stop') {
      sendResponse?.({ ok: true, clicked: clickChatGptStop() });
      return false;
    }
    if (message.action === 'send-continue') {
      forceSendContinue().then((result) => sendResponse?.(result)).catch(() => sendResponse?.({ ok: false, reason: 'send-failed' }));
      return true;
    }
    sendResponse?.({ ok: false, reason: 'unknown-action' });
    return false;
  }

  function syncRouteAndToggle() {
    scheduled = false;
    if (disposed) return;
    ensureSimpleButton();
    const nextConversationId = conversationIdFromUrl();
    if (nextConversationId !== activeConversationId) {
      const previousConversationId = activeConversationId || '';
      activeConversationId = nextConversationId;
      lastSimpleStatusFingerprint = '';
      simpleStatusInFlightFingerprint = '';
      lastMonitorAuthorityToken = '';
      simpleRestoreReady = false;
      restoreForConversation(nextConversationId, previousConversationId).catch(() => {});
      // Always query the background on route assignment. Its GET path owns the
      // provisional -> real-conversation migration, while the current UI state
      // remains painted until that authoritative state returns.
      restoreSimpleForConversation(nextConversationId).catch(() => {});
    } else {
      applyDesiredState();
    }
  }

  function scheduleSync() {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(syncRouteAndToggle);
  }

  function clockFromEvent(event) {
    const target = event?.target;
    if (!(target instanceof Element)) return null;
    try { return target.closest(CLOCK_SELECTOR); } catch { return null; }
  }

  function persistUserChoiceSoon(event) {
    if (event?.isTrusted !== true || !clockFromEvent(event)) return;

    restoreGeneration += 1;
    const enabled = currentEnabled();
    desiredEnabled = enabled;
    const conversationId = conversationIdFromUrl();
    activeConversationId = conversationId;
    if (conversationId) {
      provisionalTouched = false;
      writeStoredState(conversationId, enabled).catch(() => {});
    } else {
      provisionalEnabled = enabled;
      provisionalTouched = true;
    }
  }

  function handleClockKeydown(event) {
    if (!['Enter', ' '].includes(event?.key)) return;
    persistUserChoiceSoon(event);
  }

  function quickToolbarSendControl(node) {
    let control = null;
    try { control = node?.closest?.(`#${TOOLBAR_ID} button`); } catch {}
    if (!control || control.disabled === true || control.getAttribute?.('aria-disabled') === 'true') return null;
    const label = String(control.getAttribute?.('aria-label') || '').trim();
    if (label === 'Send timestamped Continue' || label === 'Send custom Project Continue' || /^Continue\s+.+/.test(label)) return control;
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

  function restartPrimaryWatchdogFromTrustedSend() {
    if (disposed || !simpleRestoreReady) return;
    const authority = monitorWatchdogAuthority();
    if (authority?.enabled !== true) return;
    const now = Date.now();
    if (now - lastTrustedMonitorResetAt < 250) return;
    lastTrustedMonitorResetAt = now;
    setSimpleEnabled(true).catch(() => {});
  }

  function handleTrustedSendClick(event) {
    if (event?.isTrusted !== true) return;
    if (!quickToolbarSendControl(event.target) && !nativeSendControl(event.target)) return;
    restartPrimaryWatchdogFromTrustedSend();
  }

  function handleTrustedSendKeydown(event) {
    if (event?.isTrusted !== true || event?.key !== 'Enter') return;
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
    const target = event?.target;
    let composer = null;
    try { composer = target?.closest?.('#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid="prompt-textarea"], [contenteditable="true"][data-lexical-editor="true"]'); } catch {}
    if (!composer) return;
    restartPrimaryWatchdogFromTrustedSend();
  }


  function handleStorageChanged(changes, areaName) {
    if (areaName !== 'local' || !activeConversationId) return;
    const key = storageKey(activeConversationId);
    if (!Object.prototype.hasOwnProperty.call(changes || {}, key)) return;
    restoreGeneration += 1;
    desiredEnabled = changes[key]?.newValue === true;
    provisionalEnabled = desiredEnabled;
    provisionalTouched = false;
    applyDesiredState();
  }

  function handleDocumentMutations(records) {
    if (disposed) return;
    const root = document.getElementById(TOOLBAR_ID);
    const menuItems = root?.querySelector?.(`#${SIMPLE_MENU_ITEMS_ID}`) || null;
    const routeChanged = conversationIdFromUrl() !== activeConversationId;
    if (routeChanged || !simpleButton?.isConnected || simpleButton?.parentElement !== menuItems) scheduleSync();
    if (Array.from(records || []).some((record) => record.type === 'attributes' && record.attributeName === PRIMARY_WATCHDOG_ATTR)) {
      applyMonitorWatchdogAuthority();
    }
  }

  try {
    unsubscribeConfig = configApi?.subscribe?.((config) => { if (!disposed) simpleConfig = config; });
    configApi?.load?.().then((config) => { if (!disposed) simpleConfig = config; }).catch(() => {});
  } catch {}
  observer = new MutationObserver(handleDocumentMutations);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: [PRIMARY_WATCHDOG_ATTR] });
  document.addEventListener('click', persistUserChoiceSoon, true);
  document.addEventListener('click', handleTrustedSendClick, true);
  document.addEventListener('keydown', handleClockKeydown, true);
  document.addEventListener('keydown', handleTrustedSendKeydown, true);
  window.addEventListener('popstate', scheduleSync, true);
  window.addEventListener('hashchange', scheduleSync, true);
  window.addEventListener('message', handleNotifierTerminalMessage);
  try { globalThis.navigation?.addEventListener?.('navigatesuccess', scheduleSync); } catch {}
  try { chrome.storage.onChanged.addListener(handleStorageChanged); } catch {}
  try { chrome.runtime.onMessage.addListener(handleRuntimeMessage); } catch {}
  scheduleSync();

  globalThis.__chatgptQuickContinueConversationStateRuntime = Object.freeze({
    version: RUNTIME_VERSION,
    get activeConversationId() { return activeConversationId || ''; },
    get desiredEnabled() { return desiredEnabled; },
    get simpleEnabled() { return simpleEnabled; },
    queryNotifierTerminalSignal,
    dispose() {
      if (disposed) return;
      disposed = true;
      restoreGeneration += 1;
      simpleRestoreGeneration += 1;
      simpleRequestGeneration += 1;
      try { unsubscribeConfig?.(); } catch {}
      try { if (simpleTickTimer !== null) clearInterval(simpleTickTimer); } catch {}
      try { simpleRow?.remove(); } catch {}
      try { observer?.disconnect(); } catch {}
      try { document.removeEventListener('click', persistUserChoiceSoon, true); } catch {}
      try { document.removeEventListener('click', handleTrustedSendClick, true); } catch {}
      try { document.removeEventListener('keydown', handleClockKeydown, true); } catch {}
      try { document.removeEventListener('keydown', handleTrustedSendKeydown, true); } catch {}
      try { window.removeEventListener('popstate', scheduleSync, true); } catch {}
      try { window.removeEventListener('hashchange', scheduleSync, true); } catch {}
      try { window.removeEventListener('message', handleNotifierTerminalMessage); } catch {}
      try { globalThis.navigation?.removeEventListener?.('navigatesuccess', scheduleSync); } catch {}
      try { chrome.storage.onChanged.removeListener(handleStorageChanged); } catch {}
      try { chrome.runtime.onMessage.removeListener(handleRuntimeMessage); } catch {}
      try { simpleButton?.removeEventListener('click', handleSimpleButtonClick); } catch {}
      simpleButton = null;
    }
  });
  globalThis.__chatgptQuickContinueLifecycle?.register?.(globalThis.__chatgptQuickContinueConversationStateRuntime);
})();