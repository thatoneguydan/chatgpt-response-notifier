'use strict';

(() => {
  const RUNTIME_VERSION = 9;
  const previousRuntime = globalThis.__chatgptQuickContinueHoverEditRuntime;
  if (Number(previousRuntime?.version || 0) === RUNTIME_VERSION) return;
  const restoredTimestampState = Boolean(previousRuntime?.manualTimestampEnabled);
  try { previousRuntime?.dispose?.(); } catch {}

  const prompts = globalThis.ChatGPTQuickContinuePrompts;
  const configApi = globalThis.ChatGPTQuickContinueConfig;
  const composerApi = globalThis.ChatGPTQuickContinueComposer;
  const sendApi = globalThis.ChatGPTQuickContinueSend;
  if (!prompts || !configApi || !composerApi || !sendApi) return;

  const TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const CLOCK_SELECTOR = '[aria-label="Current local time"]';
  const DEFAULT_MANUAL_TIMESTAMP_TEXT = '[{time}] {message}';

  let observer = null;
  let toolbar = null;
  let clockToggle = null;
  let manualTimestampEnabled = restoredTimestampState;
  let manualTimestampText = DEFAULT_MANUAL_TIMESTAMP_TEXT;
  let manualSendInFlight = false;
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
      try {
        const style = getComputedStyle(node);
        if (node.hidden || style.display === 'none' || style.visibility === 'hidden') continue;
      } catch {}
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement || node.isContentEditable) return node;
    }
    return null;
  }

  function rawComposerText(node) {
    return composerApi.read(node) || '';
  }

  function normalizedComposerText(value) {
    return String(value ?? '').replace(/\r\n?/g, '\n');
  }

  function formatPromptTimestamp(date = new Date()) {
    try {
      const formatter = prompts.formatTimestamp;
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
      const renderer = prompts.renderManualMessage;
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

  async function submitManualMessage() {
    if (manualSendInFlight) return false;
    const composer = composerElement();
    if (!composer) return false;

    const before = rawComposerText(composer);
    if (!before.trim()) return false;
    const normalizedBefore = normalizedComposerText(before);
    const alreadyStamped = hasLeadingTimestamp(normalizedBefore);
    const expected = alreadyStamped
      ? normalizedBefore
      : renderManualMessage(normalizedBefore, new Date());

    manualSendInFlight = true;
    try {
      const result = await sendApi.submit(composer, expected, {
        replace: !alreadyStamped
      });
      return result?.ok === true;
    } finally {
      manualSendInFlight = false;
    }
  }

  function handleManualSendClick(event) {
    if (!manualTimestampEnabled || event?.isTrusted !== true) return;
    const sendButton = sendApi.closestSendButton(event.target);
    if (!sendButton) return;

    const composer = composerElement();
    if (!composer || !rawComposerText(composer).trim()) return;

    // Never let ChatGPT consume the trusted click that existed before the
    // timestamp edit. Commit the final text first, then the shared transaction
    // issues exactly one fresh send against that committed editor state.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!manualSendInFlight) void submitManualMessage();
  }

  function handleManualSendKeydown(event) {
    if (!manualTimestampEnabled || event?.isTrusted !== true) return;
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;

    const composer = composerElement();
    if (!composer || !sendApi.enabledSendButton(composer) || !rawComposerText(composer).trim()) return;
    const target = event.target;
    if (target !== composer && !(target instanceof Node && composer.contains(target))) return;

    // The original keydown is deliberately consumed. Allowing it to continue
    // after replacing Lexical's contents is what made the first Enter only add
    // the timestamp and the second Enter actually submit.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!manualSendInFlight) void submitManualMessage();
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
    unsubscribeConfig = configApi.subscribe(applyManualTimestampConfig) || null;
    configApi.load().then(applyManualTimestampConfig).catch(() => {});
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
