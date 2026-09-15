'use strict';

(() => {
  const RUNTIME_VERSION = 4;
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const AUTO_CONTINUE_TEXT = 'continue until you finish or need something from me';
  const DEFAULT_WAIT_MS = 30000;
  const READY_WAIT_MS = 5000;
  const USER_TURN_WAIT_MS = 3500;
  const ACTIVE_GUARD_MS = 3000;

  try { globalThis.__chatgptNotifierStatusRuntime?.dispose?.(); } catch {}
  const abortController = new AbortController();
  const documentId = (() => { try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random()}`; } })();
  let lastTrustedInteractionAt = 0;

  const inline = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const cleanComposer = (value) => inline(String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, ''));

  function conversationIdentity() {
    try {
      const url = new URL(location.href);
      if (!['chatgpt.com', 'www.chatgpt.com'].includes(url.hostname)) return null;
      const parts = url.pathname.split('/').filter(Boolean);
      for (let index = parts.length - 2; index >= 0; index -= 1) {
        if (parts[index] !== 'c') continue;
        const id = decodeURIComponent(parts[index + 1] || '').trim();
        if (id) return { id, url: `https://chatgpt.com${url.pathname.replace(/\/+$/, '')}` };
      }
    } catch {}
    return null;
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
  function roleRoot(turn, role) {
    try {
      const selector = `[data-message-author-role="${role}"]`;
      return turn?.matches?.(selector) ? turn : turn?.querySelector?.(selector);
    } catch { return null; }
  }
  function renderedBlocks(roleNode) {
    try {
      const markdown = Array.from(roleNode?.querySelectorAll?.('.markdown') || []);
      const prose = Array.from(roleNode?.querySelectorAll?.('[class*="prose"]') || []);
      const candidates = Array.from(new Set([...markdown, ...prose]));
      return candidates.filter((node) => !candidates.some((other) => other !== node && other?.contains?.(node)));
    } catch { return []; }
  }
  function nodeText(node) {
    return String(node?.innerText || node?.textContent || '').replace(/\r\n?/g, '\n').trimEnd();
  }
  function turnText(turn, role) {
    try {
      const roleNode = roleRoot(turn, role);
      if (!roleNode) return '';
      const blocks = renderedBlocks(roleNode);
      const joined = blocks.map(nodeText).filter(Boolean).join('\n');
      return joined || nodeText(roleNode);
    } catch { return ''; }
  }
  function assistantStatusCodeFromDom(turn) {
    try {
      const api = globalThis.ChatGPTNotifierStatusCode;
      if (typeof api?.isStatusCode !== 'function') return '';
      const source = roleRoot(turn, 'assistant');
      if (!source) return '';
      const copy = source.cloneNode(true);
      for (const excluded of copy.querySelectorAll?.('pre, code, blockquote, ul, ol, li, [data-message-author-role="tool"], [data-tool]') || []) excluded.remove();
      const candidates = [copy, ...(copy.querySelectorAll?.('p, div, span') || [])];
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const value = String(candidates[index]?.textContent || '')
          .replace(/[\u200B-\u200D\uFEFF]/g, '')
          .replace(/\r\n?/g, '\n')
          .trim();
        const match = value.match(/^\[GITHUB_STATUS: ([A-Z][A-Z0-9_]*)\]$/);
        if (match && api.isStatusCode(match[1])) return match[1];
      }
    } catch {}
    return '';
  }
  function revisionOf(text) {
    const value = String(text || '');
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `${value.length}:${hash.toString(16).padStart(8, '0')}`;
  }

  function latestUserSnapshot() {
    const identity = conversationIdentity();
    const nodes = turns();
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      if (roleOf(nodes[index]) !== 'user') continue;
      const id = turnId(nodes[index], 'user', index);
      return { conversationId: identity?.id || '', documentId, key: `${identity?.id || location.pathname}|${id}`, turnId: id, text: turnText(nodes[index], 'user') };
    }
    return null;
  }

  function latestAssistantSnapshot() {
    const api = globalThis.ChatGPTNotifierStatusCode;
    const identity = conversationIdentity();
    if (!api || !identity) return null;
    const nodes = turns();
    let userIndex = -1;
    for (let index = 0; index < nodes.length; index += 1) if (roleOf(nodes[index]) === 'user') userIndex = index;
    if (userIndex < 0) return null;
    let assistantIndex = -1;
    let responseText = '';
    for (let index = userIndex + 1; index < nodes.length; index += 1) {
      if (roleOf(nodes[index]) !== 'assistant') continue;
      const text = turnText(nodes[index], 'assistant');
      if (!text) continue;
      assistantIndex = index;
      responseText = text;
    }
    if (assistantIndex < 0 || !responseText) return null;
    const parsed = api.parseTerminalStatus(responseText);
    const domStatusCode = assistantStatusCodeFromDom(nodes[assistantIndex]);
    const statusCode = parsed.statusCode || domStatusCode || '';
    const statusLine = parsed.statusLine || (statusCode ? `[GITHUB_STATUS: ${statusCode}]` : '');
    const userId = turnId(nodes[userIndex], 'user', userIndex);
    return {
      conversationId: identity.id,
      conversationUrl: identity.url,
      documentId,
      promptKey: `${identity.id}|${userId}`,
      promptTurnId: userId,
      assistantKey: turnId(nodes[assistantIndex], 'assistant', assistantIndex),
      revision: revisionOf(responseText),
      responseText,
      responseBody: parsed.body,
      statusCode,
      statusLine
    };
  }

  function observerRoot() {
    const nodes = turns();
    const last = nodes[nodes.length - 1];
    return last?.closest?.('main') || last?.parentElement || document.querySelector('main') || document.body || document.documentElement;
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
    let focused = false;
    let visible = false;
    try { focused = document.hasFocus(); visible = document.visibilityState === 'visible'; } catch {}
    try {
      return globalThis.ChatGPTNotifierContinuationPolicy?.userInteractionBlockReason?.({
        composerText: composerText(node), documentFocused: focused, documentVisible: visible,
        lastTrustedInteractionAt, now: Date.now(), guardMs: ACTIVE_GUARD_MS
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

  function waitUntil(check, root, timeoutMs, observeOptions) {
    const immediate = check();
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      let done = false;
      let observer = null;
      const finish = (value) => { if (done) return; done = true; observer?.disconnect(); clearTimeout(timer); resolve(value || null); };
      const inspect = () => { const value = check(); if (value) finish(value); };
      if (root && typeof MutationObserver === 'function') {
        observer = new MutationObserver(inspect);
        observer.observe(root, observeOptions || { childList: true, subtree: true, characterData: true });
      }
      const timer = setTimeout(() => finish(check()), Math.max(0, Number(timeoutMs) || 0));
      inspect();
    });
  }
  function waitForSendButton(node) {
    return waitUntil(() => !stopPresent() && enabledSend(node), node?.closest?.('form') || document.body || document.documentElement, READY_WAIT_MS,
      { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'data-testid', 'aria-label'] });
  }
  function matchesExpected(current, expected) {
    try { return Boolean(globalThis.ChatGPTNotifierContinuationPolicy?.identityMatches?.(current, expected)); } catch { return false; }
  }
  function visibleSendError() {
    for (const selector of ['[role="alert"]', '[data-testid*="error"]', '[class*="error"]']) {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(selector)).slice(-8); } catch {}
      for (const node of nodes) {
        const text = inline(node?.innerText || node?.textContent || '').toLowerCase();
        if (/something went wrong|try again|unable to|failed|error/.test(text)) return text.slice(0, 160);
      }
    }
    return '';
  }
  function matchingContinuationUserTurn(previousKey) {
    const user = latestUserSnapshot();
    return user && user.key !== previousKey && user.conversationId === conversationIdentity()?.id && cleanComposer(user.text) === AUTO_CONTINUE_TEXT ? user : null;
  }
  async function waitForContinuationUserTurn(previousKey) {
    const result = await waitUntil(() => visibleSendError() || matchingContinuationUserTurn(previousKey), observerRoot(), USER_TURN_WAIT_MS);
    if (typeof result === 'string') return { userTurn: null, errorText: result };
    return { userTurn: result || null, errorText: visibleSendError() };
  }

  async function performContinuation(expected) {
    if (!matchesExpected(latestAssistantSnapshot(), expected)) return { ok: false, clicked: false, reason: 'response-identity-changed', documentId };
    const composer = composerElement();
    if (!composer) return { ok: false, clicked: false, reason: 'composer-not-found', documentId };
    const initialBlock = activeUserBlockReason(composer);
    if (initialBlock) return { ok: false, clicked: false, reason: initialBlock, documentId };
    if (stopPresent()) return { ok: false, clicked: false, reason: 'response-still-generating', documentId };
    const previousUserKey = latestUserSnapshot()?.key || '';
    if (!writeComposer(composer, AUTO_CONTINUE_TEXT)) return { ok: false, clicked: false, reason: 'composer-write-failed', documentId };
    const sendButton = await waitForSendButton(composer);
    if (!sendButton) { if (composerText(composer) === AUTO_CONTINUE_TEXT) writeComposer(composer, ''); return { ok: false, clicked: false, reason: 'send-button-not-ready', documentId }; }
    if (!matchesExpected(latestAssistantSnapshot(), expected) || stopPresent()) { if (composerText(composer) === AUTO_CONTINUE_TEXT) writeComposer(composer, ''); return { ok: false, clicked: false, reason: 'response-changed-before-send', documentId }; }
    if (composerText(composer) !== AUTO_CONTINUE_TEXT) return { ok: false, clicked: false, reason: 'composer-changed-before-send', documentId };
    const beforeSendBlock = activeUserBlockReason(composer);
    if (beforeSendBlock && beforeSendBlock !== 'composer-not-empty') { writeComposer(composer, ''); return { ok: false, clicked: false, reason: `${beforeSendBlock}-before-send`, documentId }; }
    try { sendButton.click(); } catch { if (composerText(composer) === AUTO_CONTINUE_TEXT) writeComposer(composer, ''); return { ok: false, clicked: false, reason: 'send-click-failed', documentId }; }
    const observed = await waitForContinuationUserTurn(previousUserKey);
    if (observed.errorText) return { ok: false, clicked: true, reason: 'page-send-error', pageError: observed.errorText, documentId };
    if (!observed.userTurn) return { ok: false, clicked: true, reason: 'continuation-user-turn-not-confirmed', documentId };
    return { ok: true, clicked: true, reason: 'continuation-user-turn-confirmed', documentId, continuationUserKey: observed.userTurn.key };
  }

  async function waitForTerminalStatus(timeoutMs = DEFAULT_WAIT_MS) {
    const immediate = latestAssistantSnapshot();
    if (immediate?.statusCode) return immediate;
    const bounded = Math.max(0, Math.min(DEFAULT_WAIT_MS, Number(timeoutMs) || DEFAULT_WAIT_MS));
    return await waitUntil(() => latestAssistantSnapshot()?.statusCode ? latestAssistantSnapshot() : null, observerRoot(), bounded) || latestAssistantSnapshot();
  }

  const messageListener = (message, _sender, sendResponse) => {
    if (message?.type === 'CHATGPT_STATUS_CODE_QUERY') {
      waitForTerminalStatus(message?.timeoutMs).then((snapshot) => sendResponse?.({
        ok: true, statusCode: snapshot?.statusCode || '', statusLine: snapshot?.statusLine || '',
        responseText: snapshot?.responseText || '', responseBody: snapshot?.responseBody || '',
        conversationId: snapshot?.conversationId || '', conversationUrl: snapshot?.conversationUrl || '',
        documentId: snapshot?.documentId || documentId, promptKey: snapshot?.promptKey || '',
        assistantKey: snapshot?.assistantKey || '', revision: snapshot?.revision || '',
        autoContinued: false, autoContinueReason: 'read-only-observation'
      })).catch((error) => sendResponse?.({ ok: false, statusCode: '', error: String(error?.message || error), documentId }));
      return true;
    }
    if (message?.type === 'CHATGPT_CONTINUE_COMMAND') {
      performContinuation(message?.expected || null).then((result) => sendResponse?.(result))
        .catch((error) => sendResponse?.({ ok: false, clicked: false, reason: 'continuation-command-error', error: String(error?.message || error), documentId }));
      return true;
    }
    if (message?.type === 'CHATGPT_CONTINUE_VERIFY') {
      const current = latestAssistantSnapshot();
      sendResponse?.({ ok: true, matchesExpected: matchesExpected(current, message?.expected || null), documentId, current });
      return true;
    }
    if (message?.type === 'CHATGPT_STATUS_RUNTIME_PING') {
      sendResponse?.({ ok: true, runtimeVersion: RUNTIME_VERSION, documentId, conversationId: conversationIdentity()?.id || '' });
      return true;
    }
    return false;
  };

  chrome.runtime.onMessage.addListener(messageListener);
  const runtime = {
    version: RUNTIME_VERSION, documentId, latestAssistantSnapshot, waitForTerminalStatus, performContinuation,
    dispose() {
      try { abortController.abort(); } catch {}
      try { chrome.runtime.onMessage.removeListener(messageListener); } catch {}
      if (globalThis.__chatgptNotifierStatusRuntime === runtime) delete globalThis.__chatgptNotifierStatusRuntime;
    }
  };
  globalThis.__chatgptNotifierStatusRuntime = runtime;
  globalThis.__chatgptNotifierStatusDom = Object.freeze({ latestAssistantSnapshot, waitForTerminalStatus, performContinuation });
  globalThis.__chatgptNotifierStatusDomInstalled = true;
})();