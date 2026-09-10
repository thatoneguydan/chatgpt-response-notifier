'use strict';

(() => {
  let scriptVersion = '';
  try { scriptVersion = String(chrome.runtime.getManifest().version || ''); } catch {}
  if (!scriptVersion || globalThis.__chatgptNativeNotifierVersion === scriptVersion) return;

  const generation = (Number(globalThis.__chatgptNativeNotifierGeneration) || 0) + 1;
  globalThis.__chatgptNativeNotifierVersion = scriptVersion;
  globalThis.__chatgptNativeNotifierGeneration = generation;
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

  function isCurrentGeneration() {
    return globalThis.__chatgptNativeNotifierGeneration === generation;
  }

  function safeRuntimeSendMessage(message) {
    if (!isCurrentGeneration()) return Promise.resolve(null);
    try {
      if (!chrome.runtime?.id) return Promise.resolve(null);
      const result = chrome.runtime.sendMessage(message);
      return result && typeof result.then === 'function'
        ? result.catch(() => null)
        : Promise.resolve(result ?? null);
    } catch {
      return Promise.resolve(null);
    }
  }

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

  // Keep this extraction path aligned with upstream v1.0.8, commit
  // cbe00dcfcff8a571f407c6109ed4d5f97cef60a9. That implementation is the
  // workstation-proven baseline for meaningful response previews.
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
        if (settled || !isCurrentGeneration()) return;
        lastCheckAt = performance.now();
        const text = answerBoundToLatestPrompt();
        if (text) finish(text);
      };

      const scheduleCheck = () => {
        if (settled || !isCurrentGeneration() || throttleId !== null || frameId !== null) return;
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

      timeoutId = setTimeout(() => {
        finish(answerBoundToLatestPrompt() || 'Response finished.');
      }, FINAL_TURN_WAIT_MS);

      check();
    });
  }

  function sendCompletion(snapshot) {
    if (!isCurrentGeneration() || !snapshot?.response) return;
    const fingerprint = `${snapshot.promptKey}|${snapshot.assistantKey}|${snapshot.response.slice(0, 1000)}`;
    if (fingerprint === lastSentFingerprint) return;

    lastSentFingerprint = fingerprint;
    safeRuntimeSendMessage({
      type: 'CHATGPT_RESPONSE_COMPLETE',
      conversationUrl: location.href,
      sessionTitle: document.title,
      response: snapshot.response,
      fingerprint
    });
  }

  function armForCurrentPrompt() {
    if (!isCurrentGeneration() || Date.now() < suppressUntilEpoch) return;
    const snapshot = latestPromptSnapshot();
    if (snapshot?.response) {
      sendCompletion(snapshot);
      return;
    }

    const token = watchToken;
    waitForAnswerBoundToLatestPrompt().then((text) => {
      if (!isCurrentGeneration() || token !== watchToken) return;
      const resolved = latestPromptSnapshot();
      if (resolved?.response) {
        sendCompletion(resolved);
      } else {
        sendCompletion({ promptKey: '', assistantKey: '', response: text });
      }
    }).catch(() => {});
  }

  function isStopButton(node) {
    if (!(node instanceof Element)) return false;
    return Boolean(node.closest('button[data-testid="stop-button"], button[data-testid="fruitjuice-stop-button"]'));
  }

  function scheduleViewedSignal() {
    if (!isCurrentGeneration()) return;
    if (viewSignalTimer !== null) clearTimeout(viewSignalTimer);
    viewSignalTimer = setTimeout(() => {
      viewSignalTimer = null;
      if (!isCurrentGeneration()) return;
      if (document.visibilityState !== 'visible') return;
      if (typeof document.hasFocus === 'function' && !document.hasFocus()) return;

      const conversationUrl = location.href;
      const now = Date.now();
      if (conversationUrl === lastViewedUrl && now - lastViewedAt < VIEW_SIGNAL_DEDUPE_MS) return;
      lastViewedUrl = conversationUrl;
      lastViewedAt = now;

      safeRuntimeSendMessage({
        type: 'CHATGPT_CONVERSATION_VIEWED',
        conversationUrl
      });
    }, VIEW_SIGNAL_DELAY_MS);
  }

  document.addEventListener('click', (event) => {
    if (!isCurrentGeneration() || !isStopButton(event.target)) return;
    watchToken += 1;
    suppressUntilEpoch = Date.now() + 1500;
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (!isCurrentGeneration()) return;
    if (document.visibilityState === 'visible') scheduleViewedSignal();
  }, true);
  window.addEventListener('focus', () => {
    if (isCurrentGeneration()) scheduleViewedSignal();
  }, true);
  window.addEventListener('pageshow', () => {
    if (isCurrentGeneration()) scheduleViewedSignal();
  }, true);
  document.addEventListener('DOMContentLoaded', () => {
    if (isCurrentGeneration()) scheduleViewedSignal();
  }, { once: true });

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (!isCurrentGeneration()) return;
      if (message?.type === 'CHATGPT_CONVERSATION_REQUEST_COMPLETED') armForCurrentPrompt();
    });
  } catch {}

  scheduleViewedSignal();
})();
