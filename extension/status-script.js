'use strict';

(() => {
  const RUNTIME_VERSION = 16;
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const AUTO_CONTINUE_PROMPT = 'Continue until you finish or need something from me.';
  const DEFAULT_WAIT_MS = 30000;
  const READY_WAIT_MS = 5000;
  const USER_TURN_WAIT_MS = 3500;
  const ACTIVE_GUARD_MS = 3000;

  try { globalThis.__chatgptNotifierStatusRuntime?.dispose?.(); } catch {}
  const abortController = new AbortController();
  const documentId = (() => { try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random()}`; } })();
  let lastTrustedInteractionAt = 0;
  let stickyTerminalPromptKey = '';
  let stickyTerminalStatusCode = '';

  const inline = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const cleanComposer = (value) => inline(String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, ''));

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

  function timestampedContinueText(date = new Date()) {
    return `[${formatPromptTimestamp(date)}] ${AUTO_CONTINUE_PROMPT}`;
  }

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
      if (turn?.querySelector?.('[data-message-author-role="user"], [data-turn="user"]')) return 'user';
      if (turn?.querySelector?.('[data-message-author-role="assistant"], [data-turn="assistant"]')) return 'assistant';
    } catch {}
    return '';
  }
  function turnId(turn, role, index) {
    return String(turn?.getAttribute?.('data-testid') || turn?.getAttribute?.('data-message-id') || turn?.getAttribute?.('data-turn-id') || turn?.id || `${role}-${index}`).trim();
  }
  function roleRoot(turn, role) {
    try {
      const selector = `[data-message-author-role="${role}"], [data-turn="${role}"]`;
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
  function terminalStatusCodeFromRenderedText(value) {
    const api = globalThis.ChatGPTNotifierStatusCode;
    if (typeof api?.isStatusCode !== 'function') return '';
    const lines = String(value || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return '';
    const finalMatch = lines[lines.length - 1].match(/^\[GITHUB_STATUS: ([A-Z][A-Z0-9_]*)\]$/);
    if (!finalMatch || !api.isStatusCode(finalMatch[1])) return '';

    const validCodes = [];
    for (const line of lines) {
      const match = line.match(/^\[GITHUB_STATUS: ([A-Z][A-Z0-9_]*)\]$/);
      if (match && api.isStatusCode(match[1])) validCodes.push(match[1]);
    }
    const distinctCodes = new Set(validCodes);
    return distinctCodes.size === 1 && distinctCodes.has(finalMatch[1]) ? finalMatch[1] : '';
  }

  function terminalStatusCodeAnywhereInRenderedText(value) {
    const api = globalThis.ChatGPTNotifierStatusCode;
    if (typeof api?.isStatusCode !== 'function') return '';
    const lines = String(value || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const validCodes = [];
    for (const line of lines) {
      const match = line.match(/^\[GITHUB_STATUS: ([A-Z][A-Z0-9_]*)\]$/);
      if (match && api.isStatusCode(match[1])) validCodes.push(match[1]);
    }
    const distinctCodes = new Set(validCodes);
    return distinctCodes.size === 1 ? validCodes[validCodes.length - 1] : '';
  }

  function assistantStatusCodeFromDom(turn) {
    try {
      const sources = Array.from(new Set([
        roleRoot(turn, 'assistant'),
        ...renderedBlocks(turn),
        turn
      ].filter(Boolean)));
      for (const source of sources) {
        const copy = source.cloneNode(true);
        for (const excluded of copy.querySelectorAll?.('pre, code, blockquote, ul, ol, li, button, svg, [role="button"], [aria-hidden="true"], [hidden], [inert], [data-message-author-role="tool"], [data-tool]') || []) excluded.remove();

        const renderedText = copy.innerText || copy.textContent || '';
        const direct = terminalStatusCodeFromRenderedText(renderedText);
        if (direct) return direct;

        if (source === turn) {
          const turnScoped = terminalStatusCodeAnywhereInRenderedText(renderedText);
          if (turnScoped) return turnScoped;
        }

        const blocks = Array.from(copy.querySelectorAll?.('p, div') || [])
          .filter((node) => {
            const text = inline(node?.textContent || '');
            if (!text) return false;
            const childBlocks = Array.from(node?.querySelectorAll?.('p, div') || [])
              .filter((child) => child !== node && inline(child?.textContent || ''));
            return childBlocks.length === 0;
          });
        const terminalBlocks = blocks
          .map((node) => ({ node, code: terminalStatusCodeFromRenderedText(node?.textContent || '') }))
          .filter((entry) => entry.code);
        if (!terminalBlocks.length) continue;
        const distinctCodes = new Set(terminalBlocks.map((entry) => entry.code));
        if (distinctCodes.size !== 1) continue;
        const meaningfulBlocks = blocks.filter((node) => inline(node?.textContent || ''));
        const lastBlock = meaningfulBlocks[meaningfulBlocks.length - 1] || null;
        const terminalLastBlock = terminalBlocks.find((entry) => entry.node === lastBlock) || null;
        if (terminalLastBlock?.code) return terminalLastBlock.code;
      }
    } catch {}
    return '';
  }
  function terminalStatusForPromptKey(promptKey) {
    const api = globalThis.ChatGPTNotifierStatusCode;
    const identity = conversationIdentity();
    const expectedPrompt = String(promptKey || '');
    if (!api || !identity || !expectedPrompt) return '';
    const nodes = turns();
    let userIndex = -1;
    for (let index = 0; index < nodes.length; index += 1) {
      if (roleOf(nodes[index]) !== 'user') continue;
      const candidatePromptKey = `${identity.id}|${turnId(nodes[index], 'user', index)}`;
      if (candidatePromptKey === expectedPrompt) {
        userIndex = index;
        break;
      }
    }
    if (userIndex < 0) return '';

    let statusCode = '';
    for (let index = userIndex + 1; index < nodes.length; index += 1) {
      const role = roleOf(nodes[index]);
      if (role === 'user') break;
      if (role !== 'assistant') continue;
      const responseText = turnText(nodes[index], 'assistant');
      const parsed = responseText ? api.parseTerminalStatus(responseText) : null;
      const domStatusCode = assistantStatusCodeFromDom(nodes[index]);
      const candidate = String(parsed?.statusCode || domStatusCode || '');
      if (candidate) statusCode = candidate;
    }
    return statusCode;
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
    const userId = turnId(nodes[userIndex], 'user', userIndex);
    const userText = turnText(nodes[userIndex], 'user');
    const promptKey = `${identity.id}|${userId}`;
    let statusCode = String(parsed.statusCode || domStatusCode || '');
    if (statusCode) {
      stickyTerminalPromptKey = promptKey;
      stickyTerminalStatusCode = statusCode;
    } else if (stickyTerminalPromptKey === promptKey && stickyTerminalStatusCode) {
      statusCode = stickyTerminalStatusCode;
    } else if (stickyTerminalPromptKey && stickyTerminalPromptKey !== promptKey) {
      stickyTerminalPromptKey = '';
      stickyTerminalStatusCode = '';
    }
    const statusLine = statusCode ? `[GITHUB_STATUS: ${statusCode}]` : '';
    return {
      conversationId: identity.id,
      conversationUrl: identity.url,
      documentId,
      promptKey,
      promptTurnId: userId,
      promptRevision: revisionOf(userText),
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
  function waitForWatchdogSendButton(node) {
    return waitUntil(() => enabledSend(node), node?.closest?.('form') || document.body || document.documentElement, READY_WAIT_MS,
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
  function matchingContinuationUserTurn(previousKey, expectedText) {
    const user = latestUserSnapshot();
    return user && user.key !== previousKey && user.conversationId === conversationIdentity()?.id && cleanComposer(user.text) === cleanComposer(expectedText) ? user : null;
  }
  async function waitForContinuationUserTurn(previousKey, expectedText) {
    const result = await waitUntil(() => visibleSendError() || matchingContinuationUserTurn(previousKey, expectedText), observerRoot(), USER_TURN_WAIT_MS);
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
    const text = timestampedContinueText();
    const previousUserKey = latestUserSnapshot()?.key || '';
    if (!writeComposer(composer, text)) return { ok: false, clicked: false, reason: 'composer-write-failed', documentId };
    const sendButton = await waitForSendButton(composer);
    if (!sendButton) { if (composerText(composer) === cleanComposer(text)) writeComposer(composer, ''); return { ok: false, clicked: false, reason: 'send-button-not-ready', documentId }; }
    if (!matchesExpected(latestAssistantSnapshot(), expected) || stopPresent()) { if (composerText(composer) === cleanComposer(text)) writeComposer(composer, ''); return { ok: false, clicked: false, reason: 'response-changed-before-send', documentId }; }
    if (composerText(composer) !== cleanComposer(text)) return { ok: false, clicked: false, reason: 'composer-changed-before-send', documentId };
    const beforeSendBlock = activeUserBlockReason(composer);
    if (beforeSendBlock && beforeSendBlock !== 'composer-not-empty') { writeComposer(composer, ''); return { ok: false, clicked: false, reason: `${beforeSendBlock}-before-send`, documentId }; }
    try { sendButton.click(); } catch { if (composerText(composer) === cleanComposer(text)) writeComposer(composer, ''); return { ok: false, clicked: false, reason: 'send-click-failed', documentId }; }
    const observed = await waitForContinuationUserTurn(previousUserKey, text);
    if (observed.errorText) {
      if (composerText(composer) === cleanComposer(text)) writeComposer(composer, '');
      return { ok: false, clicked: true, reason: 'page-send-error', pageError: observed.errorText, documentId };
    }
    if (!observed.userTurn) {
      if (composerText(composer) === cleanComposer(text)) writeComposer(composer, '');
      return { ok: false, clicked: true, reason: 'continuation-user-turn-not-confirmed', documentId };
    }
    return { ok: true, clicked: true, reason: 'continuation-user-turn-confirmed', documentId, continuationUserKey: observed.userTurn.key };
  }

  async function performWatchdogContinuation(expectedConversationId = '', expectedPromptKey = '') {
    const expectedId = String(expectedConversationId || '');
    const expectedPrompt = String(expectedPromptKey || '');
    const identity = conversationIdentity();
    if (!identity?.id || (expectedId && identity.id !== expectedId)) {
      return { ok: false, clicked: false, reason: 'watchdog-conversation-changed', documentId };
    }
    const initialPromptKey = latestAssistantSnapshot()?.promptKey || latestUserSnapshot()?.key || '';
    if (expectedPrompt && initialPromptKey !== expectedPrompt) {
      return { ok: false, clicked: false, reason: 'watchdog-prompt-changed', documentId };
    }

    const observed = latestAssistantSnapshot();
    const observedStatusCode = String(observed?.statusCode || '');
    let watchdogStatusCode = '';
    if (observedStatusCode) {
      if (globalThis.ChatGPTNotifierContinuationPolicy?.isAutoContinueStatusCode?.(observedStatusCode) !== true) {
        return {
          ok: false,
          clicked: false,
          reason: 'terminal-status-observed',
          statusCode: observedStatusCode,
          watchdogDisposition: 'stop',
          documentId
        };
      }
      watchdogStatusCode = observedStatusCode;
    }

    const composer = composerElement();
    if (!composer) return { ok: false, clicked: false, reason: 'composer-not-found', documentId };
    const initialBlock = activeUserBlockReason(composer);
    if (initialBlock) return { ok: false, clicked: false, reason: initialBlock, documentId };
    const text = timestampedContinueText();
    const previousUserKey = latestUserSnapshot()?.key || '';
    if (!writeComposer(composer, text)) return { ok: false, clicked: false, reason: 'composer-write-failed', documentId };

    const sendButton = await waitForWatchdogSendButton(composer);
    if (!sendButton) {
      if (composerText(composer) === cleanComposer(text)) writeComposer(composer, '');
      return { ok: false, clicked: false, reason: 'watchdog-send-button-not-ready', documentId };
    }

    const beforeSendIdentity = conversationIdentity();
    if (!beforeSendIdentity?.id || (expectedId && beforeSendIdentity.id !== expectedId)) {
      if (composerText(composer) === cleanComposer(text)) writeComposer(composer, '');
      return { ok: false, clicked: false, reason: 'watchdog-conversation-changed-before-send', documentId };
    }
    const beforeSendPromptKey = latestAssistantSnapshot()?.promptKey || latestUserSnapshot()?.key || '';
    if (expectedPrompt && beforeSendPromptKey !== expectedPrompt) {
      if (composerText(composer) === cleanComposer(text)) writeComposer(composer, '');
      return { ok: false, clicked: false, reason: 'watchdog-prompt-changed-before-send', documentId };
    }

    const beforeSendStatusCode = String(latestAssistantSnapshot()?.statusCode || '');
    if (beforeSendStatusCode) {
      if (globalThis.ChatGPTNotifierContinuationPolicy?.isAutoContinueStatusCode?.(beforeSendStatusCode) !== true) {
        if (composerText(composer) === cleanComposer(text)) writeComposer(composer, '');
        return {
          ok: false,
          clicked: false,
          reason: 'terminal-status-observed',
          statusCode: beforeSendStatusCode,
          watchdogDisposition: 'stop',
          documentId
        };
      }
      watchdogStatusCode = beforeSendStatusCode;
    }

    if (composerText(composer) !== cleanComposer(text)) return { ok: false, clicked: false, reason: 'composer-changed-before-send', documentId };
    const beforeSendBlock = activeUserBlockReason(composer);
    if (beforeSendBlock && beforeSendBlock !== 'composer-not-empty') {
      writeComposer(composer, '');
      return { ok: false, clicked: false, reason: `${beforeSendBlock}-before-send`, documentId };
    }

    try {
      sendButton.click();
    } catch {
      if (composerText(composer) === cleanComposer(text)) writeComposer(composer, '');
      return { ok: false, clicked: false, reason: 'send-click-failed', documentId };
    }

    const sent = await waitForContinuationUserTurn(previousUserKey, text);
    if (sent.errorText) {
      if (composerText(composer) === cleanComposer(text)) writeComposer(composer, '');
      return { ok: false, clicked: true, reason: 'page-send-error', pageError: sent.errorText, documentId };
    }
    if (!sent.userTurn) {
      if (composerText(composer) === cleanComposer(text)) writeComposer(composer, '');
      return { ok: false, clicked: true, reason: 'continuation-user-turn-not-confirmed', documentId };
    }

    const postSendStatusCode = expectedPrompt ? terminalStatusForPromptKey(expectedPrompt) : '';
    if (postSendStatusCode) watchdogStatusCode = postSendStatusCode;
    const terminalAfterSend = watchdogStatusCode
      && globalThis.ChatGPTNotifierContinuationPolicy?.isAutoContinueStatusCode?.(watchdogStatusCode) !== true;
    return {
      ok: true,
      clicked: true,
      reason: terminalAfterSend ? 'terminal-status-observed-after-send' : 'watchdog-continuation-user-turn-confirmed',
      statusCode: watchdogStatusCode,
      watchdogDisposition: terminalAfterSend ? 'stop' : (watchdogStatusCode ? 'incomplete-reset' : 'retry-sent'),
      documentId,
      continuationUserKey: sent.userTurn.key
    };
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
        promptRevision: snapshot?.promptRevision || '', assistantKey: snapshot?.assistantKey || '', revision: snapshot?.revision || '',
        autoContinued: false, autoContinueReason: 'read-only-observation'
      })).catch((error) => sendResponse?.({ ok: false, statusCode: '', error: String(error?.message || error), documentId }));
      return true;
    }
    if (message?.type === 'CHATGPT_STATUS_FOR_PROMPT_QUERY') {
      const expectedId = String(message?.conversationId || '');
      const promptKey = String(message?.promptKey || '');
      const identity = conversationIdentity();
      if (!identity?.id || (expectedId && identity.id !== expectedId)) {
        sendResponse?.({ ok: false, statusCode: '', reason: 'status-query-conversation-changed', documentId });
        return false;
      }
      const statusCode = terminalStatusForPromptKey(promptKey);
      sendResponse?.({
        ok: true,
        conversationId: identity.id,
        promptKey,
        statusCode,
        documentId
      });
      return false;
    }
    if (message?.type === 'CHATGPT_WATCHDOG_CONTINUE_COMMAND') {
      performWatchdogContinuation(message?.conversationId || '', message?.promptKey || '').then((result) => sendResponse?.(result))
        .catch((error) => sendResponse?.({ ok: false, clicked: false, reason: 'watchdog-continuation-command-error', error: String(error?.message || error), documentId }));
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
    version: RUNTIME_VERSION,
    documentId,
    latestAssistantSnapshot,
    waitForTerminalStatus,
    performContinuation,
    performWatchdogContinuation,
    terminalStatusForPromptKey,
    timestampedContinueText,
    dispose() {
      try { abortController.abort(); } catch {}
      try { chrome.runtime.onMessage.removeListener(messageListener); } catch {}
      if (globalThis.__chatgptNotifierStatusRuntime === runtime) delete globalThis.__chatgptNotifierStatusRuntime;
    }
  };
  globalThis.__chatgptNotifierStatusRuntime = runtime;
  globalThis.__chatgptNotifierStatusDom = Object.freeze({ latestAssistantSnapshot, waitForTerminalStatus, performContinuation, performWatchdogContinuation, timestampedContinueText });
  globalThis.__chatgptNotifierStatusDomInstalled = true;
})();