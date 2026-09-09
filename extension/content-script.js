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
  const ANSWER_STABLE_MS = 900;
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

  function assistantText(turn) {
    if (!turn) return '';
    try {
      const roleNode = turn.matches?.('[data-message-author-role="assistant"]')
        ? turn
        : turn.querySelector('[data-message-author-role="assistant"]');
      if (!roleNode) return '';

      const markdownNodes = Array.from(roleNode.querySelectorAll('.markdown'));
      const renderedNodes = markdownNodes.length > 0
        ? markdownNodes
        : Array.from(roleNode.querySelectorAll('[class*="prose"]'));
      if (renderedNodes.length > 0) {
        const renderedText = renderedNodes
          .map((node) => normalize(node.textContent || node.innerText || ''))
          .filter(Boolean)
          .join(' ');
        if (renderedText) return normalize(renderedText);
      }

      return normalize(roleNode.textContent || roleNode.innerText || '');
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

  function snapshotFingerprint(snapshot) {
    if (!snapshot?.response) return '';
    return `${snapshot.promptKey}|${snapshot.assistantKey}|${snapshot.response}`;
  }

  function conversationObserverRoot() {
    const turns = turnNodes();
    const latestTurn = turns[turns.length - 1];
    if (latestTurn) return latestTurn.closest?.('main') || latestTurn.parentElement;
    return document.querySelector('main') || document.body || document.documentElement;
  }

  function waitForLatestAnswer() {
    if (!isCurrentGeneration()) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      let observer = null;
      let timeoutId = null;
      let throttleId = null;
      let frameId = null;
      let stableTimerId = null;
      let lastCheckAt = 0;
      let lastCandidateFingerprint = '';

      const cleanup = () => {
        observer?.disconnect();
        if (timeoutId !== null) clearTimeout(timeoutId);
        if (throttleId !== null) clearTimeout(throttleId);
        if (stableTimerId !== null) clearTimeout(stableTimerId);
        if (frameId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameId);
      };

      const finish = (snapshot) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!isCurrentGeneration()) {
          resolve(null);
          return;
        }
        resolve(snapshot || latestPromptSnapshot() || { promptKey: '', assistantKey: '', response: 'Response finished.' });
      };

      const armStableFinish = (candidateFingerprint) => {
        if (stableTimerId !== null) clearTimeout(stableTimerId);
        stableTimerId = setTimeout(() => {
          stableTimerId = null;
          if (!isCurrentGeneration()) {
            finish(null);
            return;
          }
          const latest = latestPromptSnapshot();
          const latestFingerprint = snapshotFingerprint(latest);
          if (latestFingerprint && latestFingerprint === candidateFingerprint) {
            finish(latest);
            return;
          }
          if (latestFingerprint) {
            lastCandidateFingerprint = latestFingerprint;
            armStableFinish(latestFingerprint);
          }
        }, ANSWER_STABLE_MS);
      };

      const check = () => {
        if (settled) return;
        if (!isCurrentGeneration()) {
          finish(null);
          return;
        }
        lastCheckAt = performance.now();
        const snapshot = latestPromptSnapshot();
        const candidateFingerprint = snapshotFingerprint(snapshot);
        if (!candidateFingerprint) return;
        if (candidateFingerprint === lastCandidateFingerprint) {
          if (stableTimerId === null) armStableFinish(candidateFingerprint);
          return;
        }
        lastCandidateFingerprint = candidateFingerprint;
        armStableFinish(candidateFingerprint);
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

      timeoutId = setTimeout(() => finish(latestPromptSnapshot()), FINAL_TURN_WAIT_MS);
      check();
    });
  }

  function sendCompletion(snapshot) {
    if (!isCurrentGeneration() || !snapshot) return;
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
    const token = watchToken;
    waitForLatestAnswer().then((resolved) => {
      if (!isCurrentGeneration() || token !== watchToken || !resolved) return;
      sendCompletion(resolved);
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
