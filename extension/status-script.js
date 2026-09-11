'use strict';

(() => {
  if (globalThis.__chatgptNotifierStatusDomInstalled) return;
  globalThis.__chatgptNotifierStatusDomInstalled = true;

  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const DEFAULT_WAIT_MS = 30000;
  const CHECK_THROTTLE_MS = 100;
  const AUTO_CONTINUE_TEXT = 'continue until you finish or need something from me';
  const AUTO_CONTINUE_READY_WAIT_MS = 5000;
  const AUTO_CONTINUE_SENT_WAIT_MS = 3000;
  const autoContinueInFlight = new Map();
  const autoContinueSucceeded = new Set();
  let lastAutoContinueAt = 0;

  const normalizeInline = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const normalizeComposerText = (value) => normalizeInline(String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, ''));

  function statusApi() {
    return globalThis.ChatGPTNotifierStatusCode || null;
  }

  function turnNodes() {
    try {
      return Array.from(document.querySelectorAll(TURN_SELECTOR));
    } catch {
      return [];
    }
  }

  function roleOf(turn) {
    if (!turn) return '';
    try {
      const direct = normalizeInline(
        turn.getAttribute('data-turn') || turn.getAttribute('data-message-author-role') || ''
      ).toLowerCase();
      if (direct === 'user' || direct === 'assistant') return direct;
      if (turn.querySelector('[data-message-author-role="user"]')) return 'user';
      if (turn.querySelector('[data-message-author-role="assistant"]')) return 'assistant';
    } catch {}
    return '';
  }

  function turnTextPreservingLines(turn, role) {
    if (!turn) return '';
    try {
      const selector = `[data-message-author-role="${role}"]`;
      const roleNode = turn.matches?.(selector) ? turn : turn.querySelector(selector);
      if (!roleNode) return '';
      const rendered = roleNode.querySelector('.markdown, [class*="prose"]');
      const node = rendered || roleNode;
      return String(node.innerText || node.textContent || '').replace(/\r\n?/g, '\n').trimEnd();
    } catch {
      return '';
    }
  }

  function assistantTextPreservingLines(turn) {
    return turnTextPreservingLines(turn, 'assistant');
  }

  function userTextPreservingLines(turn) {
    return turnTextPreservingLines(turn, 'user');
  }

  function latestUserSnapshot() {
    const turns = turnNodes();
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (roleOf(turns[index]) !== 'user') continue;
      return {
        index,
        key: [
          location.pathname,
          turns[index]?.getAttribute('data-testid') || `user-${index}`
        ].join('|'),
        text: userTextPreservingLines(turns[index])
      };
    }
    return null;
  }

  function latestAssistantSnapshot() {
    const api = statusApi();
    if (!api) return null;

    const turns = turnNodes();
    let latestUserIndex = -1;
    for (let index = 0; index < turns.length; index += 1) {
      if (roleOf(turns[index]) === 'user') latestUserIndex = index;
    }
    if (latestUserIndex < 0) return null;

    let assistantIndex = -1;
    let responseText = '';
    for (let index = latestUserIndex + 1; index < turns.length; index += 1) {
      if (roleOf(turns[index]) !== 'assistant') continue;
      const text = assistantTextPreservingLines(turns[index]);
      if (!text) continue;
      assistantIndex = index;
      responseText = text;
    }
    if (assistantIndex < 0 || !responseText) return null;

    const parsed = api.parseTerminalStatus(responseText);
    const userTurn = turns[latestUserIndex];
    const assistantTurn = turns[assistantIndex];
    return {
      promptKey: [
        location.pathname,
        userTurn?.getAttribute('data-testid') || `user-${latestUserIndex}`
      ].join('|'),
      assistantKey: assistantTurn?.getAttribute('data-testid') || `assistant-${assistantIndex}`,
      responseText,
      responseBody: parsed.body,
      statusCode: parsed.statusCode,
      statusLine: parsed.statusLine
    };
  }

  function observerRoot() {
    const turns = turnNodes();
    const latestTurn = turns[turns.length - 1];
    if (latestTurn) {
      const main = latestTurn.closest?.('main');
      if (main) return main;
      if (latestTurn.parentElement) return latestTurn.parentElement;
    }
    return document.querySelector('main') || document.body || document.documentElement;
  }

  function composerElement() {
    const selectors = [
      '#prompt-textarea',
      'textarea[data-testid="prompt-textarea"]',
      '[contenteditable="true"][data-testid="prompt-textarea"]'
    ];
    for (const selector of selectors) {
      let candidate = null;
      try { candidate = document.querySelector(selector); } catch {}
      if (!candidate) continue;
      if (candidate.disabled || candidate.getAttribute?.('aria-disabled') === 'true') continue;
      if (candidate instanceof HTMLTextAreaElement || candidate instanceof HTMLInputElement || candidate.isContentEditable) {
        return candidate;
      }
    }
    return null;
  }

  function composerText(composer) {
    if (!composer) return '';
    try {
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        return normalizeComposerText(composer.value);
      }
      return normalizeComposerText(composer.innerText || composer.textContent || '');
    } catch {
      return '';
    }
  }

  function dispatchComposerInput(composer, text) {
    try {
      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: text ? 'insertText' : 'deleteContentBackward',
        data: text || null
      }));
    } catch {
      try { composer.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    }
  }

  function writeComposerText(composer, text) {
    if (!composer) return false;
    try { composer.focus({ preventScroll: true }); } catch {
      try { composer.focus(); } catch {}
    }

    try {
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        const prototype = composer instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(composer, text);
        else composer.value = text;
        dispatchComposerInput(composer, text);
        return composerText(composer) === normalizeComposerText(text);
      }

      if (composer.isContentEditable) {
        const selection = window.getSelection?.();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(composer);
          selection.removeAllRanges();
          selection.addRange(range);
        }

        let changed = false;
        try {
          changed = text
            ? document.execCommand('insertText', false, text)
            : document.execCommand('delete', false, null);
        } catch {}

        if (!changed || composerText(composer) !== normalizeComposerText(text)) {
          composer.textContent = text;
          dispatchComposerInput(composer, text);
        }
        return composerText(composer) === normalizeComposerText(text);
      }
    } catch {}
    return false;
  }

  function stopButtonPresent() {
    const selectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]'
    ];
    return selectors.some((selector) => {
      try { return Boolean(document.querySelector(selector)); } catch { return false; }
    });
  }

  function enabledSendButton(composer) {
    const root = composer?.closest?.('form') || document;
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]'
    ];
    for (const selector of selectors) {
      let button = null;
      try { button = root.querySelector(selector); } catch {}
      if (!button && root !== document) {
        try { button = document.querySelector(selector); } catch {}
      }
      if (!button) continue;
      if (button.disabled || button.getAttribute?.('aria-disabled') === 'true') continue;
      return button;
    }
    return null;
  }

  function waitForSendButton(composer, timeoutMs = AUTO_CONTINUE_READY_WAIT_MS) {
    const immediate = enabledSendButton(composer);
    if (immediate && !stopButtonPresent()) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      let settled = false;
      let observer = null;
      let timeoutTimer = null;
      const finish = (button) => {
        if (settled) return;
        settled = true;
        if (observer) observer.disconnect();
        if (timeoutTimer !== null) clearTimeout(timeoutTimer);
        resolve(button || null);
      };
      const check = () => {
        const button = enabledSendButton(composer);
        if (button && !stopButtonPresent()) finish(button);
      };
      const root = composer?.closest?.('form') || document.body || document.documentElement;
      if (root && typeof MutationObserver === 'function') {
        observer = new MutationObserver(check);
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['disabled', 'aria-disabled', 'data-testid', 'aria-label']
        });
      }
      timeoutTimer = setTimeout(() => finish(null), Math.max(0, Number(timeoutMs) || 0));
      check();
    });
  }

  function autoContinueKey(snapshot) {
    return `${snapshot?.promptKey || ''}|${snapshot?.assistantKey || ''}`;
  }

  function snapshotStillMatches(snapshot) {
    const current = latestAssistantSnapshot();
    return Boolean(
      current &&
      current.statusCode === 'INCOMPLETE_LIMIT' &&
      current.promptKey === snapshot?.promptKey &&
      current.assistantKey === snapshot?.assistantKey
    );
  }

  function waitForSendAccepted(composer, previousUserKey, timeoutMs = AUTO_CONTINUE_SENT_WAIT_MS) {
    const accepted = () => {
      if (composerText(composer) === '') return true;
      const latestUser = latestUserSnapshot();
      return Boolean(
        latestUser &&
        latestUser.key !== previousUserKey &&
        normalizeComposerText(latestUser.text) === AUTO_CONTINUE_TEXT
      );
    };
    if (accepted()) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      let observer = null;
      let timeoutTimer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (observer) observer.disconnect();
        if (timeoutTimer !== null) clearTimeout(timeoutTimer);
        resolve(Boolean(value));
      };
      const check = () => {
        if (accepted()) finish(true);
      };
      const root = observerRoot();
      if (root && typeof MutationObserver === 'function') {
        observer = new MutationObserver(check);
        observer.observe(root, { childList: true, subtree: true, characterData: true });
      }
      timeoutTimer = setTimeout(() => finish(accepted()), Math.max(0, Number(timeoutMs) || 0));
      check();
    });
  }

  async function performAutoContinue(snapshot) {
    if (snapshot?.statusCode !== 'INCOMPLETE_LIMIT') {
      return { ok: false, reason: 'not-incomplete-limit' };
    }
    if (!snapshotStillMatches(snapshot)) {
      return { ok: false, reason: 'response-changed' };
    }

    const composer = composerElement();
    if (!composer) return { ok: false, reason: 'composer-not-found' };
    if (composerText(composer) !== '') return { ok: false, reason: 'composer-not-empty' };
    if (stopButtonPresent()) return { ok: false, reason: 'response-still-generating' };

    const previousUserKey = latestUserSnapshot()?.key || '';
    if (!writeComposerText(composer, AUTO_CONTINUE_TEXT)) {
      return { ok: false, reason: 'composer-write-failed' };
    }

    const sendButton = await waitForSendButton(composer);
    if (!sendButton) {
      if (composerText(composer) === AUTO_CONTINUE_TEXT) writeComposerText(composer, '');
      return { ok: false, reason: 'send-button-not-ready' };
    }

    if (!snapshotStillMatches(snapshot) || stopButtonPresent()) {
      if (composerText(composer) === AUTO_CONTINUE_TEXT) writeComposerText(composer, '');
      return { ok: false, reason: 'response-changed-before-send' };
    }
    if (composerText(composer) !== AUTO_CONTINUE_TEXT) {
      return { ok: false, reason: 'composer-changed-before-send' };
    }

    try {
      sendButton.click();
    } catch {
      if (composerText(composer) === AUTO_CONTINUE_TEXT) writeComposerText(composer, '');
      return { ok: false, reason: 'send-click-failed' };
    }

    const sent = await waitForSendAccepted(composer, previousUserKey);
    if (!sent) {
      if (composerText(composer) === AUTO_CONTINUE_TEXT) writeComposerText(composer, '');
      return { ok: false, reason: 'send-not-confirmed' };
    }

    lastAutoContinueAt = Date.now();
    return { ok: true, reason: 'sent' };
  }

  async function maybeAutoContinue(snapshot) {
    if (snapshot?.statusCode !== 'INCOMPLETE_LIMIT') {
      return { ok: false, reason: 'not-incomplete-limit' };
    }
    const key = autoContinueKey(snapshot);
    if (!key || key === '|') return { ok: false, reason: 'missing-response-key' };
    if (autoContinueSucceeded.has(key)) return { ok: true, reason: 'already-sent' };
    if (autoContinueInFlight.has(key)) return await autoContinueInFlight.get(key);

    const attempt = performAutoContinue(snapshot);
    autoContinueInFlight.set(key, attempt);
    try {
      const result = await attempt;
      if (result?.ok) autoContinueSucceeded.add(key);
      return result;
    } finally {
      autoContinueInFlight.delete(key);
    }
  }

  function pendingAutoContinueTurn() {
    if (!lastAutoContinueAt || Date.now() - lastAutoContinueAt > 30000) return false;
    const turns = turnNodes();
    const latestTurn = turns[turns.length - 1];
    if (!latestTurn || roleOf(latestTurn) !== 'user') return false;
    return normalizeComposerText(userTextPreservingLines(latestTurn)) === AUTO_CONTINUE_TEXT;
  }

  function waitForTerminalStatus(timeoutMs = DEFAULT_WAIT_MS) {
    const immediate = latestAssistantSnapshot();
    if (immediate?.statusCode) return Promise.resolve(immediate);

    const boundedTimeout = Math.max(0, Math.min(DEFAULT_WAIT_MS, Number(timeoutMs) || DEFAULT_WAIT_MS));
    return new Promise((resolve) => {
      let settled = false;
      let observer = null;
      let checkTimer = null;
      let timeoutTimer = null;

      const finish = (snapshot) => {
        if (settled) return;
        settled = true;
        if (observer) observer.disconnect();
        if (checkTimer !== null) clearTimeout(checkTimer);
        if (timeoutTimer !== null) clearTimeout(timeoutTimer);
        resolve(snapshot || latestAssistantSnapshot());
      };

      const check = () => {
        checkTimer = null;
        const snapshot = latestAssistantSnapshot();
        if (snapshot?.statusCode) finish(snapshot);
      };

      const scheduleCheck = () => {
        if (settled || checkTimer !== null) return;
        checkTimer = setTimeout(check, CHECK_THROTTLE_MS);
      };

      const root = observerRoot();
      if (root && typeof MutationObserver === 'function') {
        observer = new MutationObserver(scheduleCheck);
        observer.observe(root, { childList: true, subtree: true, characterData: true });
      }

      timeoutTimer = setTimeout(() => finish(latestAssistantSnapshot()), boundedTimeout);
      scheduleCheck();
    });
  }

  globalThis.__chatgptNotifierStatusDom = Object.freeze({
    latestAssistantSnapshot,
    waitForTerminalStatus,
    maybeAutoContinue
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'CHATGPT_STATUS_CODE_QUERY') return false;

    if (pendingAutoContinueTurn()) {
      sendResponse?.({
        ok: true,
        statusCode: '',
        statusLine: '',
        responseText: '',
        responseBody: '',
        promptKey: '',
        assistantKey: '',
        autoContinued: true,
        autoContinueReason: 'continuation-pending'
      });
      return true;
    }

    waitForTerminalStatus(message?.timeoutMs).then(async (snapshot) => {
      const autoContinue = await maybeAutoContinue(snapshot);
      const autoContinued = snapshot?.statusCode === 'INCOMPLETE_LIMIT' && autoContinue?.ok === true;
      sendResponse?.({
        ok: true,
        statusCode: autoContinued ? '' : (snapshot?.statusCode || ''),
        statusLine: autoContinued ? '' : (snapshot?.statusLine || ''),
        responseText: snapshot?.responseText || '',
        responseBody: snapshot?.responseBody || '',
        promptKey: snapshot?.promptKey || '',
        assistantKey: snapshot?.assistantKey || '',
        autoContinued,
        autoContinueReason: autoContinue?.reason || ''
      });
    }).catch((error) => {
      sendResponse?.({ ok: false, statusCode: '', error: String(error?.message || error) });
    });
    return true;
  });
})();
