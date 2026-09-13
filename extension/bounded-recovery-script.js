'use strict';

(() => {
  const RUNTIME_VERSION = 1;
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const AUTO_CONTINUE_TEXT = 'continue until you finish or need something from me';
  const FORMAT_REPAIR_TEXT = 'Classify the existing work result and supply the missing final GitHub status. Do not rerun tools, builds, deployments, writes, or completed actions. Use the actual current end state and end with exactly one valid `[GITHUB_STATUS: CODE]` line.';
  const READY_WAIT_MS = 5_000;
  const USER_TURN_WAIT_MS = 3_500;
  const ACTIVE_GUARD_MS = 3_000;

  try { globalThis.__chatgptNotifierBoundedRecoveryRuntime?.dispose?.(); } catch {}
  const abortController = new AbortController();
  let lastTrustedInteractionAt = 0;

  const inline = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const cleanComposer = (value) => inline(String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, ''));

  function monitorSnapshot() {
    try { return globalThis.__chatgptNotifierMonitorRuntime?.snapshot?.() || null; } catch { return null; }
  }

  function turns() { try { return Array.from(document.querySelectorAll(TURN_SELECTOR)); } catch { return []; } }
  function roleOf(turn) {
    try {
      const direct = inline(turn?.getAttribute?.('data-turn') || turn?.getAttribute?.('data-message-author-role') || '').toLowerCase();
      if (direct === 'user' || direct === 'assistant') return direct;
      if (turn?.querySelector?.('[data-message-author-role="user"]')) return 'user';
      if (turn?.querySelector?.('[data-message-author-role="assistant"]')) return 'assistant';
    } catch {}
    return '';
  }
  function turnId(turn, role, index) {
    return String(turn?.getAttribute?.('data-testid') || turn?.id || `${role}-${index}`).trim();
  }
  function turnText(turn, role) {
    try {
      const selector = `[data-message-author-role="${role}"]`;
      const roleNode = turn?.matches?.(selector) ? turn : turn?.querySelector?.(selector);
      const node = roleNode?.querySelector?.('.markdown, [class*="prose"]') || roleNode;
      return String(node?.innerText || node?.textContent || '').replace(/\r\n?/g, '\n').trimEnd();
    } catch { return ''; }
  }

  function latestUserTurn() {
    const snapshot = monitorSnapshot();
    const nodes = turns();
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      if (roleOf(nodes[index]) !== 'user') continue;
      const id = turnId(nodes[index], 'user', index);
      return {
        key: `${snapshot?.conversationId || location.pathname}|${id}`,
        text: turnText(nodes[index], 'user')
      };
    }
    return null;
  }

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
    } catch { return ''; }
  }

  function markTrusted(event) { if (event?.isTrusted === true) lastTrustedInteractionAt = Date.now(); }
  for (const type of ['pointerdown', 'keydown', 'beforeinput', 'input', 'compositionstart']) {
    try { document.addEventListener(type, markTrusted, { capture: true, passive: true, signal: abortController.signal }); } catch {}
  }

  function activeUserBlockReason(node) {
    const snapshot = monitorSnapshot();
    if (snapshot?.hasUpload) return 'upload-present';
    if (snapshot?.manualStopped) return 'manual-stop';
    if (snapshot?.authRequired) return 'auth-required';
    if (snapshot?.approvalRequired) return 'approval-required';
    if (snapshot?.rateLimited) return 'rate-limited';
    if (snapshot?.online === false) return 'offline';
    let focused = false;
    let visible = false;
    try { focused = document.hasFocus(); visible = document.visibilityState === 'visible'; } catch {}
    try {
      return globalThis.ChatGPTNotifierContinuationPolicy?.userInteractionBlockReason?.({
        composerText: composerText(node),
        documentFocused: focused,
        documentVisible: visible,
        lastTrustedInteractionAt,
        now: Date.now(),
        guardMs: ACTIVE_GUARD_MS
      }) || '';
    } catch { return composerText(node) ? 'composer-not-empty' : ''; }
  }

  function inputEvent(node, text) {
    try { node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: text ? 'insertText' : 'deleteContentBackward', data: text || null })); }
    catch { try { node.dispatchEvent(new Event('input', { bubbles: true })); } catch {} }
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
      } else return false;
      return composerText(node) === cleanComposer(text);
    } catch { return false; }
  }

  function stopPresent() {
    try { return Boolean(document.querySelector('button[data-testid="stop-button"], button[data-testid="fruitjuice-stop-button"], button[aria-label="Stop generating"]')); }
    catch { return false; }
  }

  function enabledSend(node) {
    const root = node?.closest?.('form') || document;
    for (const selector of ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'button[aria-label="Send"]']) {
      let button = null;
      try { button = root.querySelector(selector) || (root !== document ? document.querySelector(selector) : null); } catch {}
      if (button && !button.disabled && button.getAttribute?.('aria-disabled') !== 'true') return button;
    }
    return null;
  }

  function waitUntil(check, root, timeoutMs) {
    const immediate = check();
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      let done = false;
      let observer = null;
      const finish = (value) => { if (done) return; done = true; observer?.disconnect(); clearTimeout(timer); resolve(value || null); };
      const inspect = () => { const value = check(); if (value) finish(value); };
      if (root && typeof MutationObserver === 'function') {
        observer = new MutationObserver(inspect);
        observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'data-testid', 'aria-label'] });
      }
      const timer = setTimeout(() => finish(check()), Math.max(0, Number(timeoutMs) || 0));
      inspect();
    });
  }

  function visibleSendError() {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll('[role="alert"], [data-testid*="error"]')).slice(-8); } catch {}
    for (const node of nodes) {
      if (node.closest?.(TURN_SELECTOR)) continue;
      const text = inline(node?.innerText || node?.textContent || '').toLowerCase();
      if (/something went wrong|try again|unable to|failed|error|rate limit/.test(text)) return text.slice(0, 160);
    }
    return '';
  }

  function exactIdentityMatches(kind, current, expected) {
    if (!current || !expected) return false;
    if (current.conversationId !== expected.conversationId) return false;
    if (current.documentId !== expected.documentId) return false;
    if (current.promptKey !== expected.promptKey) return false;
    if (String(current.promptRevision || '') !== String(expected.promptRevision || '')) return false;
    if (kind === 'format-repair') {
      return Boolean(
        current.assistantKey &&
        current.assistantKey === expected.assistantKey &&
        String(current.assistantRevision || '') === String(expected.assistantRevision || '') &&
        !current.statusCode &&
        current.stableTerminal === true
      );
    }
    if (kind === 'continue') {
      return Boolean(!current.assistantKey && Number(current.silentIdleConfirmations || 0) >= 2);
    }
    return false;
  }

  function matchingNewUserTurn(previousKey, expectedText) {
    const user = latestUserTurn();
    return user && user.key !== previousKey && cleanComposer(user.text) === cleanComposer(expectedText) ? user : null;
  }

  async function perform(kind, expected) {
    if (!['continue', 'format-repair'].includes(kind)) return { ok: false, clicked: false, reason: 'unsupported-recovery-command' };
    const initial = monitorSnapshot();
    if (!exactIdentityMatches(kind, initial, expected)) return { ok: false, clicked: false, reason: 'recovery-identity-changed', documentId: initial?.documentId || '' };
    if (stopPresent()) return { ok: false, clicked: false, reason: 'response-still-generating', documentId: initial?.documentId || '' };

    const composer = composerElement();
    if (!composer) return { ok: false, clicked: false, reason: 'composer-not-found', documentId: initial?.documentId || '' };
    const blocked = activeUserBlockReason(composer);
    if (blocked) return { ok: false, clicked: false, reason: blocked, documentId: initial?.documentId || '' };

    const text = kind === 'continue' ? AUTO_CONTINUE_TEXT : FORMAT_REPAIR_TEXT;
    const previousUserKey = latestUserTurn()?.key || '';
    if (!writeComposer(composer, text)) return { ok: false, clicked: false, reason: 'composer-write-failed', documentId: initial?.documentId || '' };

    const sendButton = await waitUntil(() => !stopPresent() && enabledSend(composer), composer.closest?.('form') || document.body || document.documentElement, READY_WAIT_MS);
    if (!sendButton) {
      if (composerText(composer) === cleanComposer(text)) writeComposer(composer, '');
      return { ok: false, clicked: false, reason: 'send-button-not-ready', documentId: initial?.documentId || '' };
    }

    const before = monitorSnapshot();
    if (!exactIdentityMatches(kind, before, expected) || stopPresent()) {
      if (composerText(composer) === cleanComposer(text)) writeComposer(composer, '');
      return { ok: false, clicked: false, reason: 'recovery-identity-changed-before-send', documentId: before?.documentId || '' };
    }
    if (composerText(composer) !== cleanComposer(text)) return { ok: false, clicked: false, reason: 'composer-changed-before-send', documentId: before?.documentId || '' };
    const beforeBlock = activeUserBlockReason(composer);
    if (beforeBlock && beforeBlock !== 'composer-not-empty') {
      writeComposer(composer, '');
      return { ok: false, clicked: false, reason: `${beforeBlock}-before-send`, documentId: before?.documentId || '' };
    }

    try { sendButton.click(); }
    catch {
      if (composerText(composer) === cleanComposer(text)) writeComposer(composer, '');
      return { ok: false, clicked: false, reason: 'send-click-failed', documentId: before?.documentId || '' };
    }

    const root = document.querySelector('main') || document.body || document.documentElement;
    const observed = await waitUntil(() => visibleSendError() || matchingNewUserTurn(previousUserKey, text), root, USER_TURN_WAIT_MS);
    if (typeof observed === 'string') return { ok: false, clicked: true, reason: 'page-send-error', pageError: observed, documentId: before?.documentId || '' };
    const user = observed || matchingNewUserTurn(previousUserKey, text);
    if (!user) return { ok: false, clicked: true, reason: 'recovery-user-turn-not-confirmed', documentId: before?.documentId || '' };
    return { ok: true, clicked: true, reason: `${kind}-user-turn-confirmed`, newPromptKey: user.key, documentId: before?.documentId || '' };
  }

  const messageListener = (message, _sender, sendResponse) => {
    if (message?.type === 'CHATGPT_BOUNDED_RECOVERY_COMMAND') {
      perform(String(message.kind || ''), message.expected || null)
        .then((result) => sendResponse?.(result))
        .catch((error) => sendResponse?.({ ok: false, clicked: false, reason: 'bounded-recovery-command-error', error: String(error?.message || error) }));
      return true;
    }
    if (message?.type === 'CHATGPT_BOUNDED_RECOVERY_PING') {
      sendResponse?.({ ok: true, runtimeVersion: RUNTIME_VERSION, documentId: monitorSnapshot()?.documentId || '' });
      return true;
    }
    return false;
  };

  chrome.runtime.onMessage.addListener(messageListener);
  const runtime = {
    version: RUNTIME_VERSION,
    formatRepairText: FORMAT_REPAIR_TEXT,
    autoContinueText: AUTO_CONTINUE_TEXT,
    dispose() {
      try { abortController.abort(); } catch {}
      try { chrome.runtime.onMessage.removeListener(messageListener); } catch {}
      if (globalThis.__chatgptNotifierBoundedRecoveryRuntime === runtime) delete globalThis.__chatgptNotifierBoundedRecoveryRuntime;
    }
  };
  globalThis.__chatgptNotifierBoundedRecoveryRuntime = runtime;
})();
