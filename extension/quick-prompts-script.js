'use strict';

(() => {
  const RUNTIME_VERSION = 2;
  const TOOLBAR_ID = 'chatgpt-notifier-quick-prompts';
  const TOOLBAR_Z_INDEX = '40';
  const PRESETS = Object.freeze([
    Object.freeze({
      id: 'continue',
      label: 'Continue',
      prompt: 'Continue until you finish or need something from me.'
    }),
    Object.freeze({
      id: 'status',
      label: 'Status',
      prompt: 'Give me a concise status update: what is complete, what remains, and whether you need anything from me.'
    }),
    Object.freeze({
      id: 'checkpoint',
      label: 'Checkpoint',
      prompt: 'Checkpoint your current findings, changes, and exact next action to canonical GitHub state, then continue.'
    }),
    Object.freeze({
      id: 'handoff',
      label: 'Handoff',
      prompt: 'Checkpoint everything needed for another chat to continue from canonical GitHub state without repeating completed work.'
    })
  ]);

  try { globalThis.__chatgptNotifierQuickPromptsRuntime?.dispose?.(); } catch {}

  const abortController = new AbortController();
  let toolbar = null;
  let clock = null;
  let observer = null;
  let resizeObserver = null;
  let observedComposer = null;
  let observedAnchor = null;
  let frameId = null;
  let frameUsesAnimation = false;
  let clockTimer = null;
  const buttons = [];

  const cleanComposer = (value) => String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  function composerElement() {
    for (const selector of ['#prompt-textarea', 'textarea[data-testid="prompt-textarea"]', '[contenteditable="true"][data-testid="prompt-textarea"]']) {
      let node = null;
      try { node = document.querySelector(selector); } catch {}
      if (!node || node.disabled || node.getAttribute?.('aria-disabled') === 'true') continue;
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement || node.isContentEditable) return node;
    }
    return null;
  }

  function composerAnchor(composer) {
    if (!composer) return null;
    try {
      return composer.closest?.('form') ||
        composer.closest?.('[data-type="unified-composer"]') ||
        composer.closest?.('[data-testid*="composer" i]') ||
        composer.parentElement ||
        composer;
    } catch {
      return composer;
    }
  }

  function composerText(node) {
    try {
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return cleanComposer(node.value);
      return cleanComposer(node?.innerText || node?.textContent || '');
    } catch {
      return '';
    }
  }

  function inputEvent(node, text) {
    try {
      node.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: text ? 'insertText' : 'deleteContentBackward',
        data: text || null
      }));
    } catch {
      try { node.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    }
  }

  function writeComposer(node, text) {
    if (!node) return false;
    try { node.focus({ preventScroll: true }); } catch { try { node.focus(); } catch {} }
    try {
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
        const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(node, text); else node.value = text;
        inputEvent(node, text);
      } else if (node.isContentEditable) {
        node.textContent = text;
        inputEvent(node, text);
      } else {
        return false;
      }
      return composerText(node) === cleanComposer(text);
    } catch {
      return false;
    }
  }

  function formatPromptTimestamp(date = new Date()) {
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

  function formatClock(date = new Date()) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit'
      }).format(date);
    } catch {
      return date.toLocaleTimeString();
    }
  }

  function timestampedPrompt(prompt, date = new Date()) {
    return `[${formatPromptTimestamp(date)}] ${String(prompt || '').trim()}`;
  }

  function presetTitle(preset, date = new Date()) {
    return timestampedPrompt(preset?.prompt || 'Preset prompt', date);
  }

  function visible(node) {
    try {
      const rect = node?.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    } catch {
      return false;
    }
  }

  function buildToolbar() {
    const root = document.createElement('div');
    root.id = TOOLBAR_ID;
    root.dataset.chatgptNotifierOwned = 'quick-prompts';
    root.dataset.notifierLayer = 'composer-adjacent';
    root.setAttribute('role', 'toolbar');
    root.setAttribute('aria-label', 'Notifier quick prompts');
    Object.assign(root.style, {
      position: 'fixed',
      display: 'none',
      alignItems: 'center',
      gap: '4px',
      padding: '4px 5px',
      border: '1px solid var(--border-light, rgba(127,127,127,.28))',
      borderRadius: '9px',
      background: 'var(--main-surface-primary, #fff)',
      color: 'var(--text-primary, #111)',
      boxShadow: '0 4px 18px rgba(0,0,0,.14)',
      zIndex: TOOLBAR_Z_INDEX,
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: '11px',
      lineHeight: '1',
      whiteSpace: 'nowrap'
    });

    for (const preset of PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.notifierPreset = preset.id;
      button.textContent = preset.label;
      button.title = presetTitle(preset);
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
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const composer = composerElement();
        if (!composer || composerText(composer)) return;
        writeComposer(composer, timestampedPrompt(preset.prompt));
        scheduleSync();
      }, { signal: abortController.signal });
      buttons.push(button);
      root.append(button);
    }

    const time = document.createElement('span');
    time.dataset.notifierPromptClock = 'true';
    time.title = 'Current local time';
    Object.assign(time.style, {
      marginLeft: '2px',
      padding: '0 3px',
      opacity: '.65',
      fontVariantNumeric: 'tabular-nums'
    });
    root.append(time);
    clock = time;

    (document.body || document.documentElement).append(root);
    toolbar = root;
    return root;
  }

  function updateAvailability(composer, now = new Date()) {
    const hasDraft = Boolean(composer && composerText(composer));
    for (const button of buttons) {
      button.disabled = !composer || hasDraft;
      button.style.opacity = button.disabled ? '.45' : '1';
      button.style.cursor = button.disabled ? 'default' : 'pointer';
      if (hasDraft) button.title = 'Clear the current draft before inserting a preset prompt.';
      else {
        const preset = PRESETS.find((item) => item.id === button.dataset.notifierPreset);
        button.title = presetTitle(preset, now);
      }
    }
  }

  function observeGeometry(composer, anchor) {
    if (typeof ResizeObserver !== 'function') return;
    if (!resizeObserver) resizeObserver = new ResizeObserver(scheduleSync);

    if (observedComposer !== composer) {
      try { if (observedComposer) resizeObserver.unobserve(observedComposer); } catch {}
      observedComposer = composer || null;
      try { if (observedComposer) resizeObserver.observe(observedComposer); } catch {}
    }

    if (observedAnchor !== anchor) {
      try { if (observedAnchor && observedAnchor !== observedComposer) resizeObserver.unobserve(observedAnchor); } catch {}
      observedAnchor = anchor || null;
      try { if (observedAnchor && observedAnchor !== observedComposer) resizeObserver.observe(observedAnchor); } catch {}
    }
  }

  function syncToolbar() {
    frameId = null;
    const composer = composerElement();
    const anchor = composerAnchor(composer);
    const root = toolbar || buildToolbar();
    observeGeometry(composer, anchor);
    if (!composer || !anchor || !visible(anchor)) {
      root.style.display = 'none';
      return;
    }

    const now = new Date();
    updateAvailability(composer, now);
    if (clock) clock.textContent = formatClock(now);

    root.style.display = 'flex';
    root.style.visibility = 'hidden';
    const rect = anchor.getBoundingClientRect();
    const width = root.offsetWidth;
    const height = root.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
    const top = Math.max(8, rect.top - height - 8);
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
    root.style.visibility = 'visible';
  }

  function scheduleSync() {
    if (frameId !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      frameUsesAnimation = true;
      frameId = requestAnimationFrame(syncToolbar);
    } else {
      frameUsesAnimation = false;
      frameId = setTimeout(syncToolbar, 16);
    }
  }

  observer = new MutationObserver(scheduleSync);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('input', scheduleSync, { capture: true, passive: true, signal: abortController.signal });
  document.addEventListener('scroll', scheduleSync, { capture: true, passive: true, signal: abortController.signal });
  window.addEventListener('resize', scheduleSync, { passive: true, signal: abortController.signal });
  clockTimer = setInterval(scheduleSync, 30_000);

  const runtime = {
    version: RUNTIME_VERSION,
    presets: PRESETS,
    dispose() {
      try { abortController.abort(); } catch {}
      try { observer?.disconnect(); } catch {}
      try { resizeObserver?.disconnect(); } catch {}
      observedComposer = null;
      observedAnchor = null;
      try {
        if (frameId !== null) {
          if (frameUsesAnimation && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameId);
          else clearTimeout(frameId);
        }
      } catch {}
      try { if (clockTimer !== null) clearInterval(clockTimer); } catch {}
      try { toolbar?.remove(); } catch {}
      if (globalThis.__chatgptNotifierQuickPromptsRuntime === runtime) delete globalThis.__chatgptNotifierQuickPromptsRuntime;
    }
  };
  globalThis.__chatgptNotifierQuickPromptsRuntime = runtime;
  scheduleSync();
})();
