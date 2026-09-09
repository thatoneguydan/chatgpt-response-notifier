'use strict';

(() => {
  if (globalThis.__chatgptNativeNotifierInstalled) return;
  globalThis.__chatgptNativeNotifierInstalled = true;

  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const FINAL_TURN_WAIT_MS = 30000;
  const ANSWER_CHECK_THROTTLE_MS = 150;
  const VIEW_SIGNAL_DELAY_MS = 80;
  const VIEW_SIGNAL_DEDUPE_MS = 750;
  let watchToken = 0;
  let lastSentFingerprint = '';
  let suppressUntilEpoch = 0;
  let viewSignalTimer = null;
  let lastViewedUrl = '';
  let lastViewedAt = 0;

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
    for (let index = 0; index < turns.length; index += 1) {
      if (roleOf(turns[index]) === 'user') latestUserIndex = index;
    }
    if (latestUserIndex < 0) return null;

    let assistantIndex = -1;
    let response = '';
    for (let index = latestUserIndex + 1; index < turns.length; index += 1) {
      if (roleOf(turns[index]) !== 'assistant') continue;
      const text = assistantText(turns[index]);
      if (!text) continue;
      assistantIndex = index;
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

  function conversationObserverRoot() {
    const turns = turnNodes();
    const latestTurn = turns[turns.length - 1];
    if (latestTurn) return latestTurn.closest?.('main') || latestTurn.parentElement;
    return document.querySelector('main') || document.body || document.documentElement;
  }

  function waitForLatestAnswer() {
    const immediate = latestPromptSnapshot();
    if (immediate?.response) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      let settled = false;
      let observer = null;
      let timeoutId = null;
      let throttleId = null;
      let frameId = null;
      let lastCheckAt = 0;

      const cleanup = () => {
        observer?.disconnect();
        if (timeoutId !== null) clearTimeout(timeoutId);
        if (throttleId !== null) clearTimeout(throttleId);
        if (frameId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameId);
      };

      const finish = (snapshot) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(snapshot || latestPromptSnapshot() || { promptKey: '', assistantKey: '', response: 'Response finished.' });
      };

      const check = () => {
        if (settled) return;
        lastCheckAt = performance.now();
        const snapshot = latestPromptSnapshot();
        if (snapshot?.response) finish(snapshot);
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
          if (typeof requestAnimationFrame === 'function') frameId = requestAnimationFrame(run);
          else run();
        }, delay);
      };

      const root = conversationObserverRoot();
      if (root && typeof MutationObserver === 'function') {
        observer = new MutationObserver(scheduleCheck);
        observer.observe(root, { childList: true, subtree: true, characterData: true });
      }

      timeoutId = setTimeout(() => finish(latestPromptSnapshot()), FINAL_TURN_WAIT_MS);
      check();
    });
  }

  function sendCompletion(snapshot) {
    const fingerprint = `${snapshot.promptKey}|${snapshot.assistantKey}|${snapshot.response.slice(0, 1000)}`;
    if (fingerprint === lastSentFingerprint) return;
    lastSentFingerprint = fingerprint;
    chrome.runtime.sendMessage({
      type: 'CHATGPT_RESPONSE_COMPLETE',
      conversationUrl: location.href,
      sessionTitle: document.title,
      response: snapshot.response,
      fingerprint
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
    waitForLatestAnswer().then((resolved) => {
      if (token !== watchToken) return;
      sendCompletion(resolved);
    }).catch(() => {});
  }

  function isStopButton(node) {
    if (!(node instanceof Element)) return false;
    return Boolean(node.closest('button[data-testid="stop-button"], button[data-testid="fruitjuice-stop-button"]'));
  }

  function scheduleViewedSignal() {
    if (viewSignalTimer !== null) clearTimeout(viewSignalTimer);
    viewSignalTimer = setTimeout(() => {
      viewSignalTimer = null;
      if (document.visibilityState !== 'visible') return;
      if (typeof document.hasFocus === 'function' && !document.hasFocus()) return;

      const conversationUrl = location.href;
      const now = Date.now();
      if (conversationUrl === lastViewedUrl && now - lastViewedAt < VIEW_SIGNAL_DEDUPE_MS) return;
      lastViewedUrl = conversationUrl;
      lastViewedAt = now;

      chrome.runtime.sendMessage({
        type: 'CHATGPT_CONVERSATION_VIEWED',
        conversationUrl
      }).catch(() => {});
    }, VIEW_SIGNAL_DELAY_MS);
  }

  document.addEventListener('click', (event) => {
    if (!isStopButton(event.target)) return;
    watchToken += 1;
    suppressUntilEpoch = Date.now() + 1500;
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleViewedSignal();
  }, true);
  window.addEventListener('focus', scheduleViewedSignal, true);
  window.addEventListener('pageshow', scheduleViewedSignal, true);
  document.addEventListener('DOMContentLoaded', scheduleViewedSignal, { once: true });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'CHATGPT_CONVERSATION_REQUEST_COMPLETED') armForCurrentPrompt();
  });

  scheduleViewedSignal();
})();
