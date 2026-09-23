'use strict';

(() => {
  const RUNTIME_VERSION = 2;
  const previousRuntime = globalThis.__chatgptQuickContinueHoverEditRuntime;
  if (Number(previousRuntime?.version || 0) === RUNTIME_VERSION) return;
  const restoredTimestampState = Boolean(previousRuntime?.manualTimestampEnabled);
  try { previousRuntime?.dispose?.(); } catch {}

  const TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const EDIT_BUTTON_ID = 'chatgpt-quick-continue-hover-edit';
  const CLOCK_SELECTOR = '[aria-label="Current local time"]';
  const TARGET_SELECTOR = [
    'button[aria-label="Send timestamped Continue"]',
    'button[aria-label="Project Continue"]'
  ].join(',');
  const SEND_BUTTON_SELECTOR = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send"]'
  ].join(',');
  const HOVER_DELAY_MS = 700;
  const HIDE_DELAY_MS = 260;

  let observer = null;
  let toolbar = null;
  let editButton = null;
  let clockToggle = null;
  let activeTarget = null;
  let hoverTimer = null;
  let hideTimer = null;
  let manualTimestampEnabled = restoredTimestampState;

  function clearHoverTimer() {
    if (hoverTimer === null) return;
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }

  function clearHideTimer() {
    if (hideTimer === null) return;
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  function hideEditButton() {
    clearHoverTimer();
    clearHideTimer();
    activeTarget = null;
    if (editButton) editButton.hidden = true;
  }

  function scheduleHide() {
    clearHideTimer();
    hideTimer = setTimeout(() => {
      hideTimer = null;
      try {
        if (activeTarget?.matches?.(':hover') || editButton?.matches?.(':hover')) return;
      } catch {}
      hideEditButton();
    }, HIDE_DELAY_MS);
  }

  function styleEditButton(button) {
    Object.assign(button.style, {
      border: '1px solid var(--border-light, rgba(127,127,127,.25))',
      borderRadius: '6px',
      padding: '4px 6px',
      background: 'var(--main-surface-secondary, rgba(127,127,127,.10))',
      color: 'inherit',
      font: 'inherit',
      fontWeight: '600',
      fontSize: '10px',
      lineHeight: '1',
      cursor: 'pointer'
    });
  }

  function openConfigEditor() {
    const root = toolbar;
    if (!root?.isConnected) return;

    const projectButton = root.querySelector('button[aria-label="Project Continue"]');
    const projectPopover = root.querySelector('[role="group"][aria-label="Project Continue"]');
    const configEditButton = root.querySelector('button[aria-label="Edit Quick Continue JSON"]');
    if (!projectButton || !projectPopover || !configEditButton) return;

    if (projectPopover.hidden) projectButton.click();
    setTimeout(() => {
      try {
        root.querySelector('button[aria-label="Edit Quick Continue JSON"]')?.click();
      } catch {}
    }, 0);
  }

  function ensureEditButton() {
    if (editButton?.isConnected || editButton) return editButton;

    const button = document.createElement('button');
    button.id = EDIT_BUTTON_ID;
    button.type = 'button';
    button.textContent = 'Edit';
    button.hidden = true;
    button.setAttribute('aria-label', 'Edit Continue and Project text');
    styleEditButton(button);

    button.addEventListener('pointerenter', () => {
      clearHoverTimer();
      clearHideTimer();
      button.style.background = 'var(--main-surface-tertiary, rgba(127,127,127,.18))';
    });
    button.addEventListener('pointerleave', () => {
      button.style.background = 'var(--main-surface-secondary, rgba(127,127,127,.10))';
      scheduleHide();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openConfigEditor();
      hideEditButton();
    });

    editButton = button;
    return editButton;
  }

  function revealFor(target) {
    if (!toolbar?.isConnected || !target?.isConnected || !toolbar.contains(target)) return;
    const button = ensureEditButton();
    activeTarget = target;
    target.insertAdjacentElement('afterend', button);
    button.hidden = false;
  }

  function scheduleReveal(target) {
    clearHoverTimer();
    clearHideTimer();
    activeTarget = target;
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      revealFor(target);
    }, HOVER_DELAY_MS);
  }

  function targetFromEvent(event) {
    const node = event?.target;
    if (!(node instanceof Element)) return null;
    const target = node.closest(TARGET_SELECTOR);
    if (!target || !toolbar?.contains(target)) return null;
    return target;
  }

  function handlePointerOver(event) {
    const target = targetFromEvent(event);
    if (!target) return;
    if (target === activeTarget && editButton && !editButton.hidden) {
      clearHideTimer();
      return;
    }
    scheduleReveal(target);
  }

  function handlePointerOut(event) {
    const target = targetFromEvent(event);
    if (!target || target !== activeTarget) return;
    const related = event.relatedTarget;
    if (related && (target.contains(related) || editButton === related || editButton?.contains?.(related))) return;
    scheduleHide();
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

  function formatPromptTimestamp(date = new Date()) {
    try {
      const formatter = globalThis.ChatGPTQuickContinuePrompts?.formatTimestamp;
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

  function hasLeadingTimestamp(text) {
    const value = String(text || '').trimStart();
    return /^\[[^\]\r\n]{0,80}\d{1,2}:\d{2}(?:\s*[AP]M)?[^\]\r\n]{0,80}\]\s+/i.test(value);
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

  function prependTextControl(node, prefix) {
    const before = String(node.value || '');
    const next = `${prefix}${before}`;
    try {
      const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(node, next);
      else node.value = next;
      dispatchInput(node, prefix);
      return String(node.value || '') === next;
    } catch {
      return false;
    }
  }

  function prependContentEditable(node, prefix) {
    const before = rawComposerText(node);
    if (!before.trim()) return false;

    try { node.focus({ preventScroll: true }); } catch { try { node.focus(); } catch {} }

    try {
      const selection = window.getSelection?.();
      const range = document.createRange?.();
      if (selection && range) {
        range.selectNodeContents(node);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, prefix)) {
          if (rawComposerText(node).startsWith(prefix)) return true;
        }
      }
    } catch {}

    try {
      node.textContent = `${prefix}${before}`;
      dispatchInput(node, prefix);
      return rawComposerText(node).startsWith(prefix);
    } catch {
      return false;
    }
  }

  function prependTimestampToComposer(node, date = new Date()) {
    if (!node) return false;
    const before = rawComposerText(node);
    if (!before.trim() || hasLeadingTimestamp(before)) return false;
    const prefix = `[${formatPromptTimestamp(date)}] `;
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
      return prependTextControl(node, prefix);
    }
    if (node.isContentEditable) return prependContentEditable(node, prefix);
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
    if (!composer || !rawComposerText(composer).trim()) return false;
    if (hasLeadingTimestamp(rawComposerText(composer))) return true;
    return prependTimestampToComposer(composer, new Date());
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
    clearHoverTimer();
    clearHideTimer();
    activeTarget = null;
    detachClockToggle();
    if (toolbar) {
      try { toolbar.removeEventListener('pointerover', handlePointerOver); } catch {}
      try { toolbar.removeEventListener('pointerout', handlePointerOut); } catch {}
      try { toolbar.removeEventListener('pointerleave', scheduleHide); } catch {}
    }
    try { editButton?.remove(); } catch {}
    editButton = null;
    toolbar = null;
  }

  function attachToolbar(nextToolbar) {
    if (!nextToolbar || nextToolbar === toolbar) {
      if (nextToolbar) attachClockToggle(nextToolbar);
      return;
    }
    detachToolbar();
    toolbar = nextToolbar;
    toolbar.addEventListener('pointerover', handlePointerOver);
    toolbar.addEventListener('pointerout', handlePointerOut);
    toolbar.addEventListener('pointerleave', scheduleHide);
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

  observer = new MutationObserver(syncToolbar);
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
      try { document.removeEventListener('click', handleManualSendClick, true); } catch {}
      try { document.removeEventListener('keydown', handleManualSendKeydown, true); } catch {}
      detachToolbar();
    }
  });
})();
