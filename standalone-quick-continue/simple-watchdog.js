'use strict';

(() => {
  const RUNTIME_VERSION = 1;
  const TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const BUTTON_ID = 'chatgpt-quick-continue-simple-watchdog';
  const ACTION_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_ACTION';
  const STATE_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_STATE';
  const SET_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_SET';
  const GET_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_GET';

  const prompts = globalThis.ChatGPTQuickContinuePrompts;
  const configApi = globalThis.ChatGPTQuickContinueConfig;
  const composerApi = globalThis.ChatGPTQuickContinueComposer;
  const sendApi = globalThis.ChatGPTQuickContinueSend;
  if (!prompts || !configApi || !composerApi || !sendApi) return;

  const previousRuntime = globalThis.__chatgptQuickContinueSimpleWatchdogRuntime;
  if (Number(previousRuntime?.version || 0) === RUNTIME_VERSION) return;
  try { previousRuntime?.dispose?.(); } catch {}

  let enabled = false;
  let disposed = false;
  let discoveryObserver = null;
  let toolbarObserver = null;
  let observedToolbar = null;
  let button = null;

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
    try {
      const root = document.getElementById(TOOLBAR_ID);
      const status = root?.querySelector?.('[role="status"]');
      if (!status) return;
      status.textContent = String(message || '');
      status.hidden = !message;
      if (message) setTimeout(() => {
        try {
          if (status.textContent === message) {
            status.textContent = '';
            status.hidden = true;
          }
        } catch {}
      }, 2200);
    } catch {}
  }

  function styleButton(node) {
    Object.assign(node.style, {
      border: '1px solid var(--border-light, rgba(127,127,127,.25))',
      borderRadius: '6px',
      padding: '5px 7px',
      background: enabled ? '#16a34a' : 'var(--main-surface-secondary, rgba(127,127,127,.10))',
      color: enabled ? '#fff' : 'inherit',
      font: 'inherit',
      fontWeight: '600',
      cursor: 'pointer'
    });
  }

  function renderState(nextEnabled) {
    enabled = nextEnabled === true;
    if (!button) return;
    button.setAttribute('aria-pressed', String(enabled));
    button.textContent = 'Simple';
    styleButton(button);
  }

  async function setEnabled(nextEnabled) {
    const conversationId = conversationIdFromUrl();
    if (nextEnabled && !conversationId) {
      showStatus('Open a saved chat before enabling Simple.');
      renderState(false);
      return;
    }

    let config = null;
    try { config = await configApi.load(); } catch {}
    if (!config?.simpleWatchdog) {
      showStatus('Simple watchdog config unavailable.');
      return;
    }

    let response = null;
    try {
      response = await chrome.runtime.sendMessage({
        type: SET_MESSAGE,
        enabled: nextEnabled === true,
        conversationId,
        settings: config.simpleWatchdog
      });
    } catch {}

    renderState(response?.enabled === true);
    if (response?.enabled === true) showStatus('Simple watchdog on.');
    else if (nextEnabled) showStatus(String(response?.reason || 'Simple watchdog could not start.'));
    else showStatus('Simple watchdog off.');
  }

  function handleToggle(event) {
    event.preventDefault();
    event.stopPropagation();
    setEnabled(!enabled).catch(() => {});
  }

  function installButton(root) {
    if (!root || disposed) return;
    const existing = root.querySelector(`#${BUTTON_ID}`);
    if (existing) {
      button = existing;
      renderState(enabled);
      return;
    }

    const node = document.createElement('button');
    node.id = BUTTON_ID;
    node.type = 'button';
    node.textContent = 'Simple';
    node.setAttribute('aria-label', 'Toggle simple fallback watchdog');
    node.setAttribute('aria-pressed', String(enabled));
    styleButton(node);
    node.addEventListener('click', handleToggle);

    const project = root.querySelector('button[aria-label="Project Continue"]');
    if (project?.nextSibling) root.insertBefore(node, project.nextSibling);
    else root.append(node);
    button = node;
  }

  function observeToolbar(root) {
    if (observedToolbar === root) return;
    try { toolbarObserver?.disconnect(); } catch {}
    observedToolbar = root || null;
    if (!root) return;
    toolbarObserver = new MutationObserver(() => {
      if (disposed) return;
      if (!document.contains(root)) {
        try { toolbarObserver?.disconnect(); } catch {}
        observedToolbar = null;
        button = null;
        discoverToolbar();
        return;
      }
      if (!root.querySelector(`#${BUTTON_ID}`)) installButton(root);
    });
    toolbarObserver.observe(root, { childList: true });
  }

  function discoverToolbar() {
    if (disposed) return;
    const root = document.getElementById(TOOLBAR_ID);
    if (root) {
      try { discoveryObserver?.disconnect(); } catch {}
      discoveryObserver = null;
      installButton(root);
      observeToolbar(root);
      return;
    }
    if (discoveryObserver || !document.documentElement) return;
    discoveryObserver = new MutationObserver(() => {
      const next = document.getElementById(TOOLBAR_ID);
      if (!next) return;
      try { discoveryObserver?.disconnect(); } catch {}
      discoveryObserver = null;
      installButton(next);
      observeToolbar(next);
    });
    discoveryObserver.observe(document.documentElement, { childList: true, subtree: true });
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

  function clickStopButton() {
    for (const selector of [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop response"]',
      'button[aria-label="Stop"]'
    ]) {
      let node = null;
      try { node = document.querySelector(selector); } catch {}
      if (!node || node.disabled || node.getAttribute?.('aria-disabled') === 'true') continue;
      try {
        node.click();
        return true;
      } catch {}
    }
    return false;
  }

  async function forceSendContinue() {
    const composer = composerElement();
    if (!composer) return { ok: false, reason: 'composer-not-found' };
    let config = null;
    try { config = await configApi.load(); } catch {}
    if (!config?.continueText) return { ok: false, reason: 'config-unavailable' };
    const text = prompts.continuePrompt(config.continueText, new Date());
    if (!text) return { ok: false, reason: 'continue-text-empty' };
    try {
      return await sendApi.submit(composer, text, { replace: true, timeoutMs: 5000 });
    } catch {
      return { ok: false, reason: 'send-threw' };
    }
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type === STATE_MESSAGE) {
      renderState(message?.state?.enabled === true);
      if (message?.state?.exhausted === true) showStatus('Simple watchdog attempts exhausted.');
      sendResponse?.({ ok: true });
      return false;
    }
    if (message?.type !== ACTION_MESSAGE) return false;

    if (message.action === 'stop') {
      sendResponse?.({ ok: true, clicked: clickStopButton() });
      return false;
    }
    if (message.action === 'send-continue') {
      forceSendContinue().then((result) => sendResponse?.(result)).catch(() => sendResponse?.({ ok: false, reason: 'send-failed' }));
      return true;
    }
    sendResponse?.({ ok: false, reason: 'unknown-action' });
    return false;
  }

  async function restoreState() {
    const conversationId = conversationIdFromUrl();
    if (!conversationId) {
      renderState(false);
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({ type: GET_MESSAGE, conversationId });
      renderState(response?.enabled === true);
    } catch {
      renderState(false);
    }
  }

  try { chrome.runtime.onMessage.addListener(handleRuntimeMessage); } catch {}
  discoverToolbar();
  restoreState().catch(() => {});

  globalThis.__chatgptQuickContinueSimpleWatchdogRuntime = Object.freeze({
    version: RUNTIME_VERSION,
    get enabled() { return enabled; },
    dispose() {
      disposed = true;
      try { discoveryObserver?.disconnect(); } catch {}
      try { toolbarObserver?.disconnect(); } catch {}
      try { chrome.runtime.onMessage.removeListener(handleRuntimeMessage); } catch {}
      try { button?.removeEventListener('click', handleToggle); } catch {}
      button = null;
      observedToolbar = null;
    }
  });
})();
