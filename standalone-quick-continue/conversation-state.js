'use strict';

(() => {
  const RUNTIME_VERSION = 7;
  const STORAGE_PREFIX = 'quick-continue:manual-timestamp:';
  const CLOCK_SELECTOR = '[aria-label="Current local time"]';
  const TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const SIMPLE_BUTTON_ID = 'chatgpt-quick-continue-simple-watchdog';
  const SIMPLE_ACTION_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_ACTION';
  const SIMPLE_STATE_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_STATE';
  const SIMPLE_SET_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_SET';
  const SIMPLE_GET_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_GET';
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
  let simpleConfig = null;
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
    const remaining = Math.max(0, Number(simpleState?.attemptsRemaining || 0));
    const seconds = Math.max(0, Math.ceil((Number(simpleState?.nextAt || 0) - Date.now()) / 1000));
    const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    const phase = simpleState?.phase;
    const label = phase === 'stop-wait' ? 'Refresh in' : phase === 'refresh-wait' ? 'Continue in' : 'Next auto-continue';
    const text = active ? `${label} ${countdown} · ${remaining} auto-continues left`
      : simpleState?.exhausted === true ? 'Auto-continues exhausted' : '';
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
    if (simpleEnabled && simpleTickTimer === null) simpleTickTimer = setInterval(renderSimpleCountdown, 1000);
    if (!simpleEnabled && simpleTickTimer !== null) { clearInterval(simpleTickTimer); simpleTickTimer = null; }
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
    renderSimpleState(nextEnabled ? {
      enabled: true, phase: 'countdown', attemptsRemaining: config.simpleWatchdog.attempts,
      nextAt: startedAt + config.simpleWatchdog.timerMinutes * 60_000
    } : { enabled: false });
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({
        type: SIMPLE_SET_MESSAGE,
        enabled: nextEnabled === true,
        conversationId,
        startedAt,
        settings: config?.simpleWatchdog
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
    if (!root) {
      simpleButton = null;
      simpleRow = null;
      return;
    }
    simpleRow = root.querySelector('#chatgpt-quick-continue-simple-countdown');
    if (!simpleRow) {
      simpleRow = document.createElement('div');
      simpleRow.id = 'chatgpt-quick-continue-simple-countdown';
      simpleRow.hidden = true;
      simpleRow.setAttribute('role', 'group');
      simpleRow.setAttribute('aria-label', 'Simple auto-continue timer');
      root.append(simpleRow);
    }
    const existing = root.querySelector(`#${SIMPLE_BUTTON_ID}`);
    if (existing) {
      simpleButton = existing;
      const project = root.querySelector('button[aria-label="Project Continue"]');
      if (project && simpleButton.nextElementSibling !== project) root.insertBefore(simpleButton, project);
      renderSimpleState(simpleState);
      return;
    }
    const button = document.createElement('button');
    button.id = SIMPLE_BUTTON_ID;
    button.type = 'button';
    button.textContent = 'Simple';
    button.setAttribute('aria-label', 'Toggle simple fallback watchdog');
    button.setAttribute('aria-pressed', String(simpleEnabled));
    styleSimpleButton(button);
    button.addEventListener('click', handleSimpleButtonClick);
    const project = root.querySelector('button[aria-label="Project Continue"]');
    if (project) root.insertBefore(button, project);
    else root.append(button);
    simpleButton = button;
    renderSimpleState(simpleState);
  }

  async function restoreSimpleForConversation(conversationId) {
    const generation = ++simpleRestoreGeneration;
    let response = null;
    try { response = await chrome.runtime.sendMessage({ type: SIMPLE_GET_MESSAGE, conversationId }); } catch {}
    if (disposed || generation !== simpleRestoreGeneration || activeConversationId !== conversationId) return;
    renderSimpleState(response);
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

  function handleDocumentMutations() {
    if (disposed) return;
    // Route changes are also covered by Navigation/popstate; this observer only
    // needs to repair a detached/remounted toolbar. Avoid URL parsing and other
    // work for every editor keystroke while the toolbar is healthy.
    if (!simpleButton?.isConnected || document.getElementById(TOOLBAR_ID) !== simpleButton?.parentElement) scheduleSync();
  }

  try {
    unsubscribeConfig = configApi?.subscribe?.((config) => { if (!disposed) simpleConfig = config; });
    configApi?.load?.().then((config) => { if (!disposed) simpleConfig = config; }).catch(() => {});
  } catch {}
  observer = new MutationObserver(handleDocumentMutations);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('click', persistUserChoiceSoon, true);
  document.addEventListener('keydown', handleClockKeydown, true);
  window.addEventListener('popstate', scheduleSync, true);
  window.addEventListener('hashchange', scheduleSync, true);
  try { globalThis.navigation?.addEventListener?.('navigatesuccess', scheduleSync); } catch {}
  try { chrome.storage.onChanged.addListener(handleStorageChanged); } catch {}
  try { chrome.runtime.onMessage.addListener(handleRuntimeMessage); } catch {}
  scheduleSync();

  globalThis.__chatgptQuickContinueConversationStateRuntime = Object.freeze({
    version: RUNTIME_VERSION,
    get activeConversationId() { return activeConversationId || ''; },
    get desiredEnabled() { return desiredEnabled; },
    get simpleEnabled() { return simpleEnabled; },
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
      try { document.removeEventListener('keydown', handleClockKeydown, true); } catch {}
      try { window.removeEventListener('popstate', scheduleSync, true); } catch {}
      try { window.removeEventListener('hashchange', scheduleSync, true); } catch {}
      try { globalThis.navigation?.removeEventListener?.('navigatesuccess', scheduleSync); } catch {}
      try { chrome.storage.onChanged.removeListener(handleStorageChanged); } catch {}
      try { chrome.runtime.onMessage.removeListener(handleRuntimeMessage); } catch {}
      try { simpleButton?.removeEventListener('click', handleSimpleButtonClick); } catch {}
      simpleButton = null;
    }
  });
  globalThis.__chatgptQuickContinueLifecycle?.register?.(globalThis.__chatgptQuickContinueConversationStateRuntime);
})();