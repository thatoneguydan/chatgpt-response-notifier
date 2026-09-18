'use strict';

(() => {
  if (globalThis.__chatgptQuickContinueInstalled) return;
  globalThis.__chatgptQuickContinueInstalled = true;

  const prompts = globalThis.ChatGPTQuickContinuePrompts;
  if (!prompts) return;

  const TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const SEND_READY_TIMEOUT_MS = 1800;
  const buttons = [];
  let toolbar = null;
  let clock = null;
  let projectPopover = null;
  let projectInput = null;
  let projectSend = null;
  let status = null;
  let statusTimer = null;
  let observer = null;
  let resizeObserver = null;
  let observedComposer = null;
  let observedAnchor = null;
  let scheduled = null;
  let scheduledWithAnimationFrame = false;
  let clockTimer = null;
  let busy = false;

  const cleanComposer = (value) => String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

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

  function composerAnchor(composer) {
    if (!composer) return null;
    try {
      return composer.closest?.('form')
        || composer.closest?.('[data-type="unified-composer"]')
        || composer.closest?.('[data-testid*="composer" i]')
        || composer.parentElement
        || composer;
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

  function dispatchInput(node, text) {
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
    try {
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
        const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(node, text);
        else node.value = text;
        dispatchInput(node, text);
      } else if (node.isContentEditable) {
        node.textContent = text;
        dispatchInput(node, text);
      } else {
        return false;
      }
      return composerText(node) === cleanComposer(text);
    } catch {
      return false;
    }
  }

  function stopPresent() {
    try {
      return Boolean(document.querySelector(
        'button[data-testid="stop-button"], button[data-testid="fruitjuice-stop-button"], button[aria-label="Stop generating"]'
      ));
    } catch {
      return false;
    }
  }

  function enabledSend(composer) {
    const root = composer?.closest?.('form') || document;
    for (const selector of [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]'
    ]) {
      let button = null;
      try {
        button = root.querySelector(selector) || (root !== document ? document.querySelector(selector) : null);
      } catch {}
      if (!button || button.disabled || button.getAttribute?.('aria-disabled') === 'true') continue;
      return button;
    }
    return null;
  }

  function waitForSendButton(composer) {
    const immediate = !stopPresent() && enabledSend(composer);
    if (immediate) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      let settled = false;
      let mutationObserver = null;
      const root = composer?.closest?.('form') || document.body || document.documentElement;

      const finish = (button) => {
        if (settled) return;
        settled = true;
        try { mutationObserver?.disconnect(); } catch {}
        clearTimeout(timer);
        resolve(button || null);
      };

      const inspect = () => {
        const button = !stopPresent() && enabledSend(composer);
        if (button) finish(button);
      };

      if (root && typeof MutationObserver === 'function') {
        mutationObserver = new MutationObserver(inspect);
        mutationObserver.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['disabled', 'aria-disabled', 'data-testid', 'aria-label']
        });
      }

      const timer = setTimeout(() => finish(!stopPresent() && enabledSend(composer)), SEND_READY_TIMEOUT_MS);
      inspect();
    });
  }

  function setStatus(message) {
    if (!status) return;
    status.textContent = String(message || '');
    status.hidden = !message;
    if (statusTimer !== null) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusTimer = null;
      if (status) {
        status.textContent = '';
        status.hidden = true;
      }
    }, 2200);
  }

  async function sendPrompt(text) {
    if (busy) return false;
    const composer = composerElement();
    if (!composer) {
      setStatus('ChatGPT composer not found.');
      return false;
    }
    if (composerText(composer)) {
      setStatus('Clear the current draft first.');
      scheduleSync();
      return false;
    }
    if (stopPresent()) {
      setStatus('Wait for the current response to stop.');
      return false;
    }

    busy = true;
    updateAvailability(composer);
    try {
      if (!writeComposer(composer, text)) {
        setStatus('Could not write the prompt.');
        return false;
      }

      const sendButton = await waitForSendButton(composer);
      if (!sendButton) {
        setStatus('Send not ready; prompt left in composer.');
        return false;
      }
      if (composerText(composer) !== cleanComposer(text) || stopPresent()) {
        setStatus('Composer changed; nothing sent.');
        return false;
      }

      try {
        sendButton.click();
        setStatus('Sent.');
        return true;
      } catch {
        setStatus('Send failed; prompt left in composer.');
        return false;
      }
    } finally {
      busy = false;
      scheduleSync();
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

  function visible(node) {
    try {
      const rect = node?.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    } catch {
      return false;
    }
  }

  function closeProjectPopover({ clear = false } = {}) {
    if (!projectPopover) return;
    projectPopover.hidden = true;
    if (clear && projectInput) projectInput.value = '';
    updateProjectSendState();
  }

  function updateProjectSendState() {
    if (!projectSend || !projectInput) return;
    const composer = composerElement();
    projectSend.disabled = busy
      || !prompts.normalizeInline(projectInput.value)
      || !composer
      || Boolean(composerText(composer))
      || stopPresent();
  }

  async function sendProject() {
    if (!projectInput) return;
    const projectName = prompts.normalizeInline(projectInput.value);
    if (!projectName) return;
    const text = prompts.projectContinuePrompt(projectName, new Date());
    const sent = await sendPrompt(text);
    if (sent) closeProjectPopover({ clear: true });
  }

  function buildToolbar() {
    const root = document.createElement('div');
    root.id = TOOLBAR_ID;
    root.setAttribute('role', 'toolbar');
    root.setAttribute('aria-label', 'Quick Continue');
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
      zIndex: '40',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: '11px',
      lineHeight: '1',
      whiteSpace: 'nowrap'
    });

    const continueButton = document.createElement('button');
    continueButton.type = 'button';
    continueButton.textContent = 'Continue';
    continueButton.setAttribute('aria-label', 'Send timestamped Continue');
    styleButton(continueButton);
    continueButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      sendPrompt(prompts.continuePrompt(new Date()));
    });
    buttons.push(continueButton);
    root.append(continueButton);

    const projectButton = document.createElement('button');
    projectButton.type = 'button';
    projectButton.textContent = 'Project';
    projectButton.setAttribute('aria-label', 'Project Continue');
    styleButton(projectButton);
    projectButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!projectPopover) return;
      projectPopover.hidden = !projectPopover.hidden;
      updateProjectSendState();
    });
    buttons.push(projectButton);
    root.append(projectButton);

    const time = document.createElement('span');
    time.setAttribute('aria-label', 'Current local time');
    Object.assign(time.style, {
      marginLeft: '2px',
      padding: '0 3px',
      opacity: '.65',
      fontVariantNumeric: 'tabular-nums'
    });
    root.append(time);
    clock = time;

    const statusNode = document.createElement('span');
    statusNode.hidden = true;
    statusNode.setAttribute('role', 'status');
    Object.assign(statusNode.style, {
      marginLeft: '2px',
      maxWidth: '180px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      opacity: '.72'
    });
    root.append(statusNode);
    status = statusNode;

    const popover = document.createElement('div');
    popover.hidden = true;
    popover.setAttribute('role', 'group');
    popover.setAttribute('aria-label', 'Project Continue');
    Object.assign(popover.style, {
      position: 'absolute',
      right: '0',
      bottom: 'calc(100% + 6px)',
      display: 'flex',
      alignItems: 'center',
      gap: '5px',
      padding: '6px',
      border: '1px solid var(--border-light, rgba(127,127,127,.28))',
      borderRadius: '9px',
      background: 'var(--main-surface-primary, #fff)',
      color: 'var(--text-primary, #111)',
      boxShadow: '0 4px 18px rgba(0,0,0,.14)'
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Project name…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Project name');
    Object.assign(input.style, {
      width: '170px',
      height: '27px',
      padding: '0 7px',
      border: '1px solid var(--border-light, rgba(127,127,127,.30))',
      borderRadius: '6px',
      outline: 'none',
      background: 'var(--main-surface-secondary, rgba(127,127,127,.08))',
      color: 'inherit',
      font: '12px system-ui, sans-serif'
    });
    input.addEventListener('input', updateProjectSendState);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        sendProject();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeProjectPopover();
      }
    });
    popover.append(input);
    projectInput = input;

    const send = document.createElement('button');
    send.type = 'button';
    send.textContent = 'Send';
    send.setAttribute('aria-label', 'Send Project Continue');
    styleButton(send);
    send.disabled = true;
    send.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      sendProject();
    });
    popover.append(send);
    projectSend = send;

    root.append(popover);
    projectPopover = popover;

    (document.body || document.documentElement).append(root);
    toolbar = root;

    document.addEventListener('pointerdown', (event) => {
      if (!projectPopover || projectPopover.hidden) return;
      if (toolbar?.contains(event.target)) return;
      closeProjectPopover();
    }, true);

    return root;
  }

  function styleButton(button) {
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
    button.addEventListener('mouseenter', () => {
      if (!button.disabled) button.style.background = 'var(--main-surface-tertiary, rgba(127,127,127,.18))';
    });
    button.addEventListener('mouseleave', () => {
      button.style.background = 'var(--main-surface-secondary, rgba(127,127,127,.10))';
    });
  }

  function updateAvailability(composer) {
    const hasDraft = Boolean(composer && composerText(composer));
    const unavailable = busy || !composer || hasDraft || stopPresent();
    for (const button of buttons) {
      button.disabled = unavailable;
      button.style.opacity = button.disabled ? '.45' : '1';
      button.style.cursor = button.disabled ? 'default' : 'pointer';
    }
    updateProjectSendState();
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

  function suppressLegacyNotifierToolbar() {
    try {
      const legacy = document.getElementById('chatgpt-notifier-quick-prompts');
      if (legacy) legacy.remove();
    } catch {}
  }

  function syncToolbar() {
    scheduled = null;
    suppressLegacyNotifierToolbar();
    const composer = composerElement();
    const anchor = composerAnchor(composer);
    const root = toolbar || buildToolbar();
    observeGeometry(composer, anchor);

    if (!composer || !anchor || !visible(anchor)) {
      root.style.display = 'none';
      return;
    }

    const now = new Date();
    updateAvailability(composer);
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
    if (scheduled !== null) return;
    if (typeof requestAnimationFrame === 'function' && document.visibilityState !== 'hidden') {
      scheduledWithAnimationFrame = true;
      scheduled = requestAnimationFrame(syncToolbar);
    } else {
      scheduledWithAnimationFrame = false;
      scheduled = setTimeout(syncToolbar, 16);
    }
  }

  observer = new MutationObserver(scheduleSync);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('input', scheduleSync, { capture: true, passive: true });
  document.addEventListener('scroll', scheduleSync, { capture: true, passive: true });
  document.addEventListener('visibilitychange', scheduleSync, true);
  window.addEventListener('resize', scheduleSync, { passive: true });
  clockTimer = setInterval(scheduleSync, 30_000);

  globalThis.__chatgptQuickContinueRuntime = Object.freeze({
    version: 1,
    dispose() {
      try { observer?.disconnect(); } catch {}
      try { resizeObserver?.disconnect(); } catch {}
      try {
        if (scheduled !== null) {
          if (scheduledWithAnimationFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scheduled);
          else clearTimeout(scheduled);
        }
      } catch {}
      try { if (clockTimer !== null) clearInterval(clockTimer); } catch {}
      try { toolbar?.remove(); } catch {}
    }
  });

  scheduleSync();
})();
