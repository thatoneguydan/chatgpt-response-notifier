'use strict';

(() => {
  const RUNTIME_VERSION = 7;
  const previousRuntime = globalThis.__chatgptQuickContinueHoverEditRuntime;
  if (Number(previousRuntime?.version || 0) === RUNTIME_VERSION) return;
  const restoredTimestampState = Boolean(previousRuntime?.manualTimestampEnabled);
  try { previousRuntime?.dispose?.(); } catch {}

  const prompts = globalThis.ChatGPTQuickContinuePrompts;
  const configApi = globalThis.ChatGPTQuickContinueConfig;
  const TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const CLOCK_SELECTOR = '[aria-label="Current local time"]';
  const SEND_BUTTON_SELECTOR = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send"]'
  ].join(',');
  const DEFAULT_MANUAL_TIMESTAMP_TEXT = '[{time}] {message}';

  let observer = null;
  let toolbar = null;
  let clockToggle = null;
  let manualTimestampEnabled = restoredTimestampState;
  let manualTimestampText = DEFAULT_MANUAL_TIMESTAMP_TEXT;
  let unsubscribeConfig = null;
  let scheduledSync = null;
  let scheduledWithAnimationFrame = false;

  function applyManualTimestampConfig(config) {
    const next = String(config?.manualTimestampText ?? '').replace(/\r\n?/g, '\n').trim();
    manualTimestampText = next || DEFAULT_MANUAL_TIMESTAMP_TEXT;
  }

  function composerElement() {
    for (const selector of [
      '#prompt-textarea',
      'textarea[data-testid="prompt-textarea"]',
      '[contenteditable="true"][data-testid="prompt-textarea"]'
    ]) {
      let node = null;
      try { node = document.querySelector(selector); } catch {}
      if (!node || node.disabled || node.getAttribute?.('aria-disabled') === 'true') continue;
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement || node.isContentEditable) return node;
    }
    return null;
  }

  function rawComposerText(node) {
    try {
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return String(node.value || '');
      return String(node?.innerText || node?.textContent || '');
    } catch {
      return '';
    }
  }

  function normalizedComposerText(value) {
    return String(value ?? '').replace(/\r\n?/g, '\n');
  }

  function formatPromptTimestamp(date = new Date()) {
    try {
      const formatter = prompts?.formatTimestamp;
      if (typeof formatter === 'function') return formatter(date);
    } catch {}
    try {
      return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      }).format(date);
    } catch {
      return date.toLocaleString();
    }
  }

  function renderManualMessage(message, date = new Date()) {
    try {
      const renderer = prompts?.renderManualMessage;
      if (typeof renderer === 'function') {
        const rendered = String(renderer(manualTimestampText, message, date) || '');
        if (rendered) return rendered;
      }
    } catch {}
    return `[${formatPromptTimestamp(date)}] ${normalizedComposerText(message)}`;
  }

  function hasLeadingTimestamp(text) {
    const value = String(text || '').trimStart();
    return /^\[[^\]\r\n]{0,80}\d{1,2}:\d{2}(?:\s*[AP]M)?[^\]\r\n]{0,80}\](?:\s|$)/i.test(value);
  }

  function dispatchInput(node, data) {
    try {
      node.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data
      }));
    } catch {
      try { node.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    }
  }

  function replaceTextControl(node, text) {
    const next = normalizedComposerText(text);
    try {
      const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(node, next);
      else node.value = next;
      dispatchInput(node, next);
      return normalizedComposerText(node.value) === next;
    } catch {
      return false;
    }
  }

  function replaceContentEditableFallback(node, text) {
    const next = normalizedComposerText(text);
    try {
      const fragment = document.createDocumentFragment();
      const lines = next.split('\n');
      lines.forEach((line, index) => {
        if (index > 0) fragment.append(document.createElement('br'));
        if (line) fragment.append(document.createTextNode(line));
      });
      node.replaceChildren(fragment);
      dispatchInput(node, next);
      return normalizedComposerText(rawComposerText(node)) === next;
    } catch {
      return false;
    }
  }

  function replaceContentEditable(node, text) {
    const next = normalizedComposerText(text);
    try { node.focus({ preventScroll: true }); } catch { try { node.focus(); } catch {} }

    try {
      const selection = window.getSelection?.();
      const range = document.createRange?.();
      if (selection && range && typeof document.execCommand === 'function') {
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
        if (document.execCommand('insertText', false, next)) {
          if (normalizedComposerText(rawComposerText(node)) === next) return true;
        }
      }
    } catch {}

    return replaceContentEditableFallback(node, next);
  }

  function replaceComposerText(node, text) {
    if (!node) return false;
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
      return replaceTextControl(node, text);
    }
    if (node.isContentEditable) return replaceContentEditable(node, text);
    return false;
  }

  function enabledSendButton(composer) {
    const root = composer?.closest?.('form') || document;
    let button = null;
    try {
      button = root.querySelector(SEND_BUTTON_SELECTOR)
        || (root !== document ? document.querySelector(SEND_BUTTON_SELECTOR) : null);
    } catch {}
    if (!button || button.disabled || button.getAttribute?.('aria-disabled') === 'true') return null;
    return button;
  }

  function stampManualMessage() {
    if (!manualTimestampEnabled) return false;
    const composer = composerElement();
    if (!composer) return false;
    const before = rawComposerText(composer);
    if (!before.trim()) return false;
    if (hasLeadingTimestamp(before)) return true;
    return replaceComposerText(composer, renderManualMessage(before, new Date()));
  }

  function handleManualSendClick(event) {
    if (!manualTimestampEnabled || event?.isTrusted !== true) return;
    const node = event.target;
    if (!(node instanceof Element)) return;
    const sendButton = node.closest(SEND_BUTTON_SELECTOR);
    if (!sendButton || sendButton.disabled || sendButton.getAttribute?.('aria-disabled') === 'true') return;
    stampManualMessage();
  }

  function handleManualSendKeydown(event) {
    if (!manualTimestampEnabled || event?.isTrusted !== true) return;
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;

    const composer = composerElement();
    if (!composer || !enabledSendButton(composer)) return;
    const target = event.target;
    if (target !== composer && !(target instanceof Node && composer.contains(target))) return;
    stampManualMessage();
  }

  function updateClockToggleStyle() {
    if (!clockToggle) return;
    clockToggle.setAttribute('role', 'button');
    clockToggle.setAttribute('tabindex', '0');
    clockToggle.setAttribute('aria-pressed', String(manualTimestampEnabled));
    clockToggle.title = manualTimestampEnabled
      ? 'Manual message timestamps on'
      : 'Manual message timestamps off';
    Object.assign(clockToggle.style, {
      cursor: 'pointer',
      borderRadius: '4px',
      outlineOffset: '1px',
      outline: manualTimestampEnabled ? '1px solid currentColor' : '1px solid transparent',
      background: manualTimestampEnabled ? 'var(--main-surface-secondary, rgba(127,127,127,.10))' : 'transparent',
      opacity: manualTimestampEnabled ? '1' : '.65'
    });
  }

  function setManualTimestampEnabled(enabled) {
    manualTimestampEnabled = Boolean(enabled);
    updateClockToggleStyle();
  }

  function handleClockClick(event) {
    event.preventDefault();
    event.stopPropagation();
    setManualTimestampEnabled(!manualTimestampEnabled);
  }

  function handleClockKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    setManualTimestampEnabled(!manualTimestampEnabled);
  }

  function detachClockToggle() {
    if (!clockToggle) return;
    try { clockToggle.removeEventListener('click', handleClockClick); } catch {}
    try { clockToggle.removeEventListener('keydown', handleClockKeydown); } catch {}
    try {
      clockToggle.removeAttribute('role');
      clockToggle.removeAttribute('tabindex');
      clockToggle.removeAttribute('aria-pressed');
      clockToggle.removeAttribute('title');
      clockToggle.style.cursor = '';
      clockToggle.style.borderRadius = '';
      clockToggle.style.outlineOffset = '';
      clockToggle.style.outline = '';
      clockToggle.style.background = '';
      clockToggle.style.opacity = '.65';
    } catch {}
    clockToggle = null;
  }

  function attachClockToggle(root) {
    const nextClock = root?.querySelector?.(CLOCK_SELECTOR) || null;
    if (nextClock === clockToggle) {
      updateClockToggleStyle();
      return;
    }
    detachClockToggle();
    if (!nextClock) return;
    clockToggle = nextClock;
    clockToggle.addEventListener('click', handleClockClick);
    clockToggle.addEventListener('keydown', handleClockKeydown);
    updateClockToggleStyle();
  }

  function detachToolbar() {
    detachClockToggle();
    toolbar = null;
  }

  function attachToolbar(nextToolbar) {
    if (!nextToolbar || nextToolbar === toolbar) {
      if (nextToolbar) attachClockToggle(nextToolbar);
      return;
    }
    detachToolbar();
    toolbar = nextToolbar;
    attachClockToggle(toolbar);
  }

  function syncToolbar() {
    const nextToolbar = document.getElementById(TOOLBAR_ID);
    if (nextToolbar === toolbar) {
      if (nextToolbar) attachClockToggle(nextToolbar);
      return;
    }
    if (nextToolbar) attachToolbar(nextToolbar);
    else detachToolbar();
  }

  function scheduleToolbarSync() {
    if (scheduledSync !== null) return;
    if (typeof requestAnimationFrame === 'function' && document.visibilityState !== 'hidden') {
      scheduledWithAnimationFrame = true;
      scheduledSync = requestAnimationFrame(() => {
        scheduledSync = null;
        syncToolbar();
      });
    } else {
      scheduledWithAnimationFrame = false;
      scheduledSync = setTimeout(() => {
        scheduledSync = null;
        syncToolbar();
      }, 32);
    }
  }

  try {
    unsubscribeConfig = configApi?.subscribe?.(applyManualTimestampConfig) || null;
    configApi?.load?.().then(applyManualTimestampConfig).catch(() => {});
  } catch {}

  observer = new MutationObserver(scheduleToolbarSync);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('click', handleManualSendClick, true);
  document.addEventListener('keydown', handleManualSendKeydown, true);
  syncToolbar();

  globalThis.__chatgptQuickContinueHoverEditRuntime = Object.freeze({
    version: RUNTIME_VERSION,
    get manualTimestampEnabled() {
      return manualTimestampEnabled;
    },
    dispose() {
      try { observer?.disconnect(); } catch {}
      try { unsubscribeConfig?.(); } catch {}
      unsubscribeConfig = null;
      try {
        if (scheduledSync !== null) {
          if (scheduledWithAnimationFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scheduledSync);
          else clearTimeout(scheduledSync);
        }
      } catch {}
      scheduledSync = null;
      try { document.removeEventListener('click', handleManualSendClick, true); } catch {}
      try { document.removeEventListener('keydown', handleManualSendKeydown, true); } catch {}
      detachToolbar();
    }
  });
})();
