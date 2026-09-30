'use strict';

(() => {
  const RUNTIME_VERSION = 4;
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
      if (runtime && typeof runtime.manualTimestampEnabled === 'boolean') {
        return runtime.manualTimestampEnabled;
      }
    } catch {}
    try {
      return document.querySelector(CLOCK_SELECTOR)?.getAttribute('aria-pressed') === 'true';
    } catch {
      return false;
    }
  }

  function applyDesiredState() {
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
    desiredEnabled = false;
    applyDesiredState();

    if (!nextConversationId) {
      provisionalEnabled = false;
      provisionalTouched = false;
      return;
    }

    let stored = { found: false, enabled: false };
    try { stored = await readStoredState(nextConversationId); } catch {}
    if (generation !== restoreGeneration || activeConversationId !== nextConversationId) return;

    if (stored.found) {
      desiredEnabled = stored.enabled;
      provisionalEnabled = stored.enabled;
      provisionalTouched = false;
      applyDesiredState();
      return;
    }

    if (!previousConversationId && provisionalTouched) {
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

  function renderSimpleState(enabled) {
    simpleEnabled = enabled === true;
    if (!simpleButton) return;
    simpleButton.setAttribute('aria-pressed', String(simpleEnabled));
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
    const conversationId = conversationIdFromUrl();
    if (nextEnabled && !conversationId) {
      renderSimpleState(false);
      showStatus('Open a saved chat before enabling Simple.');
      return;
    }
    let config = null;
    try { config = await configApi?.load?.(); } catch {}
    if (!config?.simpleWatchdog) {
      showStatus('Simple watchdog config unavailable.');
      return;
    }
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({
        type: SIMPLE_SET_MESSAGE,
        enabled: nextEnabled === true,
        conversationId,
        settings: config.simpleWatchdog
      });
    } catch {}
    renderSimpleState(response?.enabled === true);
    if (response?.enabled === true) showStatus('Simple watchdog on.');
    else if (nextEnabled) showStatus(String(response?.reason || 'Simple watchdog could not start.'));
    else showStatus('Simple watchdog off.');
  }

  function handleSimpleButtonClick(event) {
    event.preventDefault();
    event.stopPropagation();
    setSimpleEnabled(!simpleEnabled).catch(() => {});
  }

  function ensureSimpleButton() {
    const root = document.getElementById(TOOLBAR_ID);
    if (!root) {
      simpleButton = null;
      return;
    }
    const existing = root.querySelector(`#${SIMPLE_BUTTON_ID}`);
    if (existing) {
      simpleButton = existing;
      renderSimpleState(simpleEnabled);
      return;
    }
    const button = document.createElement('button');
    button.id = SIMPLE_BUTTON_ID;
    button.type = 'button';
    button.textContent = 'Simple';
    button.setAttribute('aria-label', 'Toggle simple fallback watchdog');
    button.setAttribute('aria-pressed', String(simpleEnabled));
    styleSimpleButton(button);
    renderSimpleState(simpleEnabled);
    button.addEventListener('click', handleSimpleButtonClick);
    const project = root.querySelector('button[aria-label="Project Continue"]');
    if (project?.nextSibling) root.insertBefore(button, project.nextSibling);
    else root.append(button);
    simpleButton = button;
    renderSimpleState(simpleEnabled);
  }

  async function restoreSimpleForConversation(conversationId) {
    const generation = ++simpleRestoreGeneration;
    if (!conversationId) {
      renderSimpleState(false);
      return;
    }
    let response = null;
    try { response = await chrome.runtime.sendMessage({ type: SIMPLE_GET_MESSAGE, conversationId }); } catch {}
    if (generation !== simpleRestoreGeneration || activeConversationId !== conversationId) return;
    renderSimpleState(response?.enabled === true);
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
    if (message?.type === SIMPLE_STATE_MESSAGE) {
      renderSimpleState(message?.state?.enabled === true);
      if (message?.state?.exhausted === true) showStatus('Simple watchdog attempts exhausted.');
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
    ensureSimpleButton();
    const nextConversationId = conversationIdFromUrl();
    if (nextConversationId !== activeConversationId) {
      const previousConversationId = activeConversationId || '';
      activeConversationId = nextConversationId;
      restoreForConversation(nextConversationId, previousConversationId).catch(() => {});
      restoreSimpleForConversation(nextConversationId).catch(() => {});
    } else {
      applyDesiredState();
    }
  }

  function scheduleSync() {
    if (scheduled) return;
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

    // hover-edit-script is loaded before this runtime and owns the clock toggle.
    // Its document-capture listener has already committed the new in-memory
    // state by the time this listener runs. Invalidate any asynchronous restore
    // that started before this trusted choice so a late storage read cannot
    // overwrite the user's newer state.
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

  observer = new MutationObserver(scheduleSync);
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
})();
