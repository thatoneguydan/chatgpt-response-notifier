'use strict';

(() => {
  if (globalThis.__chatgptNotifierStatusDomInstalled) return;
  globalThis.__chatgptNotifierStatusDomInstalled = true;

  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const DEFAULT_WAIT_MS = 30000;
  const CHECK_THROTTLE_MS = 100;

  const normalizeInline = (value) => String(value || '').replace(/\s+/g, ' ').trim();

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

  function assistantTextPreservingLines(turn) {
    if (!turn) return '';
    try {
      const roleNode = turn.matches?.('[data-message-author-role="assistant"]')
        ? turn
        : turn.querySelector('[data-message-author-role="assistant"]');
      if (!roleNode) return '';
      const rendered = roleNode.querySelector('.markdown, [class*="prose"]');
      const node = rendered || roleNode;
      return String(node.innerText || node.textContent || '').replace(/\r\n?/g, '\n').trimEnd();
    } catch {
      return '';
    }
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
    waitForTerminalStatus
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'CHATGPT_STATUS_CODE_QUERY') return false;

    waitForTerminalStatus(message?.timeoutMs).then((snapshot) => {
      sendResponse?.({
        ok: true,
        statusCode: snapshot?.statusCode || '',
        statusLine: snapshot?.statusLine || '',
        responseText: snapshot?.responseText || '',
        responseBody: snapshot?.responseBody || '',
        promptKey: snapshot?.promptKey || '',
        assistantKey: snapshot?.assistantKey || ''
      });
    }).catch((error) => {
      sendResponse?.({ ok: false, statusCode: '', error: String(error?.message || error) });
    });
    return true;
  });
})();
