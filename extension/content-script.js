'use strict';

(() => {
  if (globalThis.__chatgptPromptBoundNotifierInstalled) return;
  globalThis.__chatgptPromptBoundNotifierInstalled = true;

  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const FINAL_TURN_WAIT_MS = 30000;
  const ANSWER_CHECK_THROTTLE_MS = 150;
  let watchToken = 0;
  let lastSentFingerprint = '';
  let suppressUntilEpoch = 0;

  function pageIsActive() {
    try {
      return document.visibilityState === 'visible' && document.hasFocus();
    } catch {
      return document.visibilityState === 'visible';
    }
  }

  function notifyPageReturned() {
    chrome.runtime.sendMessage({ type: 'CHATGPT_PAGE_RETURNED' }).catch(() => {});
  }

  window.addEventListener('focus', notifyPageReturned, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') notifyPageReturned();
  }, true);
  document.addEventListener('pointerdown', notifyPageReturned, { capture: true, passive: true });
  document.addEventListener('keydown', notifyPageReturned, { capture: true, passive: true });

  function turnNodes() {
    try {
      return Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
    } catch {
      return [];
    }
  }

  function roleOf(turn) {
    if (!turn) return '';
    try {
      const direct = normalize(
        turn.getAttribute('data-turn') || turn.getAttribute('data-message-author-role') || ''
      ).toLowerCase();
      if (direct === 'user' || direct === 'assistant') return direct;
      if (turn.querySelector('[data-message-author-role="user"]')) return 'user';
      if (turn.querySelector('[data-message-author-role="assistant"]')) return 'assistant';
    } catch {}
    return '';
  }

  function assistantText(turn) {
    if (!turn) return '';
    try {
      const roleNode = turn.matches?.('[data-message-author-role="assistant"]')
        ? turn
        : turn.querySelector('[data-message-author-role="assistant"]');
      if (!roleNode) return '';

      const rendered = roleNode.querySelector('.markdown, [class*="prose"]');
      return normalize(
        rendered
          ? (rendered.textContent || rendered.innerText || '')
          : (roleNode.textContent || roleNode.innerText || '')
      );
    } catch {
      return '';
    }
  }

  function latestPromptSnapshot() {
    const turns = turnNodes();
    let latestUserIndex = -1;
    for (let i = 0; i < turns.length; i += 1) {
      if (roleOf(turns[i]) === 'user') latestUserIndex = i;
    }
    if (latestUserIndex < 0) return null;

    let assistantIndex = -1;
    let response = '';
    for (let i = latestUserIndex + 1; i < turns.length; i += 1) {
      if (roleOf(turns[i]) !== 'assistant') continue;
      const text = assistantText(turns[i]);
      if (!text) continue;
      assistantIndex = i;
      response = text;
    }

    const userTurn = turns[latestUserIndex];
    const promptKey = [
      location.pathname,
      userTurn?.getAttribute('data-testid') || `user-${latestUserIndex}`
    ].join('|');

    if (!response || assistantIndex < 0) {
      return { promptKey, assistantKey: '', response: '' };
    }

    const assistantTurn = turns[assistantIndex];
    return {
      promptKey,
      assistantKey: assistantTurn?.getAttribute('data-testid') || `assistant-${assistantIndex}`,
      response
    };
  }

  function answerBoundToLatestPrompt() {
    return latestPromptSnapshot()?.response || '';
  }

  function conversationObserverRoot() {
    const turns = turnNodes();
    const latestTurn = turns[turns.length - 1];
    if (latestTurn) {
      const main = latestTurn.closest?.('main');
      if (main) return main;
      if (latestTurn.parentElement) return latestTurn.parentElement;
    }
    return document.querySelector('main') || document.body || document.documentElement;
  }

  function waitForAnswerBoundToLatestPrompt() {
    const immediate = answerBoundToLatestPrompt();
    if (immediate) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      let settled = false;
      let observer = null;
      let timeoutId = null;
      let throttleId = null;
      let frameId = null;
      let lastCheckAt = 0;

      const cleanupScheduledCheck = () => {
        if (throttleId !== null) {
          clearTimeout(throttleId);
          throttleId = null;
        }
        if (frameId !== null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(frameId);
          frameId = null;
        }
      };

      const finish = (text) => {
        if (settled) return;
        settled = true;
        if (observer) observer.disconnect();
        if (timeoutId !== null) clearTimeout(timeoutId);
        cleanupScheduledCheck();
        resolve(text);
      };

      const check = () => {
        if (settled) return;
        lastCheckAt = performance.now();
        const text = answerBoundToLatestPrompt();
        if (text) finish(text);
      };

      const scheduleCheck = () => {
        if (settled || throttleId !== null || frameId !== null) return;
        const elapsed = performance.now() - lastCheckAt;
        const delay = Math.max(0, ANSWER_CHECK_THROTTLE_MS - elapsed);
        throttleId = setTimeout(() => {
          throttleId = null;
          const run = () => {
            frameId = null;
            check();
          };
          if (typeof requestAnimationFrame === 'function') {
            frameId = requestAnimationFrame(run);
          } else {
            run();
          }
        }, delay);
      };

      const root = conversationObserverRoot();
      if (root && typeof MutationObserver === 'function') {
        observer = new MutationObserver(scheduleCheck);
        observer.observe(root, { childList: true, subtree: true, characterData: true });
      }

      timeoutId = setTimeout(() => {
        finish(answerBoundToLatestPrompt() || 'Response finished.');
      }, FINAL_TURN_WAIT_MS);

      check();
    });
  }

  function sendCompletion(snapshot) {
    const fingerprint = `${snapshot.promptKey}|${snapshot.assistantKey}|${snapshot.response.slice(0, 1000)}`;
    if (fingerprint === lastSentFingerprint) return;

    lastSentFingerprint = fingerprint;
    chrome.runtime.sendMessage({
      type: 'CHATGPT_RESPONSE_COMPLETE',
      sessionTitle: document.title,
      response: snapshot.response,
      fingerprint,
      dismissOnReturn: !pageIsActive()
    }).catch(() => {});
  }

  function armForCurrentPrompt() {
    if (Date.now() < suppressUntilEpoch) return;
    const snapshot = latestPromptSnapshot();
    if (snapshot?.response) {
      sendCompletion(snapshot);
      return;
    }

    const token = watchToken;
    waitForAnswerBoundToLatestPrompt()
      .then((text) => {
        if (token !== watchToken) return;
        const resolved = latestPromptSnapshot();
        if (resolved?.response) {
          sendCompletion(resolved);
        } else {
          sendCompletion({
            promptKey: '',
            assistantKey: '',
            response: text
          });
        }
      });
  }

  function isStopButton(node) {
    if (!(node instanceof Element)) return false;
    return Boolean(node.closest('button[data-testid="stop-button"], button[data-testid="fruitjuice-stop-button"]'));
  }

  document.addEventListener('click', (event) => {
    if (!isStopButton(event.target)) return;
    // A manual stop is not a successful completion. The next conversation
    // request will arm the watcher again.
    watchToken += 1;
    suppressUntilEpoch = Date.now() + 1500;
  }, true);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'CHATGPT_CONVERSATION_REQUEST_COMPLETED') {
      armForCurrentPrompt();
    }
  });
})();

(() => {
  const RUNTIME_VERSION = 1;
  const TOOLBAR_ID = 'chatgpt-notifier-quick-prompts';
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
  let frameId = null;
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

  function sendButtonFor(composer) {
    const root = composer?.closest?.('form') || document;
    for (const selector of ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'button[aria-label="Send"]']) {
      let button = null;
      try { button = root.querySelector(selector) || (root !== document ? document.querySelector(selector) : null); } catch {}
      if (button) return button;
    }
    return null;
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

  function timestampedPrompt(prompt) {
    return `[${formatPromptTimestamp()}] ${String(prompt || '').trim()}`;
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
      zIndex: '2147483646',
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
      button.title = `${preset.prompt} Adds the current local timestamp.`;
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
    time.title = 'Local time used by quick prompts';
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

  function updateAvailability(composer) {
    const hasDraft = Boolean(composer && composerText(composer));
    for (const button of buttons) {
      button.disabled = !composer || hasDraft;
      button.style.opacity = button.disabled ? '.45' : '1';
      button.style.cursor = button.disabled ? 'default' : 'pointer';
      if (hasDraft) button.title = 'Clear the current draft before inserting a preset prompt.';
      else {
        const preset = PRESETS.find((item) => item.id === button.dataset.notifierPreset);
        button.title = `${preset?.prompt || 'Preset prompt'} Adds the current local timestamp.`;
      }
    }
  }

  function syncToolbar() {
    frameId = null;
    const composer = composerElement();
    const anchor = composer ? (sendButtonFor(composer) || composer) : null;
    const root = toolbar || buildToolbar();
    if (!composer || !anchor || !visible(anchor)) {
      root.style.display = 'none';
      return;
    }

    updateAvailability(composer);
    if (clock) clock.textContent = formatClock();

    root.style.display = 'flex';
    root.style.visibility = 'hidden';
    const rect = anchor.getBoundingClientRect();
    const width = root.offsetWidth;
    const height = root.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
    let top = rect.top - height - 8;
    if (top < 8) top = Math.min(window.innerHeight - height - 8, rect.bottom + 8);
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(Math.max(8, top))}px`;
    root.style.visibility = 'visible';
  }

  function scheduleSync() {
    if (frameId !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      frameId = requestAnimationFrame(syncToolbar);
    } else {
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
      try {
        if (frameId !== null) {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameId);
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
