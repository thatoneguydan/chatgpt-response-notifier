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
  const RENDER_GRACE_MS = 650;
  const VIEW_SIGNAL_DELAY_MS = 80;
  const VIEW_SIGNAL_DEDUPE_MS = 750;
  let watchToken = 0;
  let lastSentFingerprint = '';
  let suppressUntilEpoch = 0;
  let viewSignalTimer = null;
  let lastViewedUrl = '';
  let lastViewedAt = 0;
  let completionTimer = null;

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
      const nodes = Array.from(document.querySelectorAll(
        'article[data-testid*="conversation-turn"], [data-testid^="conversation-turn-"]'
      ));
      return nodes.filter((node, index) => nodes.findIndex((candidate) => candidate === node) === index);
    } catch {
      return [];
    }
  }

  function roleOf(turn) {
    if (!turn) return '';
    try {
      const direct = normalize(
        turn.getAttribute('data-turn') ||
        turn.getAttribute('data-message-author-role') ||
        turn.getAttribute('data-author') ||
        ''
      ).toLowerCase();
      if (direct === 'user' || direct === 'assistant') return direct;

      const roleNode = turn.querySelector('[data-message-author-role], [data-author]');
      const nested = normalize(
        roleNode?.getAttribute('data-message-author-role') ||
        roleNode?.getAttribute('data-author') ||
        ''
      ).toLowerCase();
      if (nested === 'user' || nested === 'assistant') return nested;

      const labelText = normalize(Array.from(turn.querySelectorAll('h1, h2, h3, h4, h5, h6, [aria-label]'))
        .slice(0, 8)
        .map((node) => `${node.getAttribute?.('aria-label') || ''} ${node.textContent || ''}`)
        .join(' ')).toLowerCase();
      if (/\b(chatgpt|assistant)\s+said\b/.test(labelText)) return 'assistant';
      if (/\b(you|user)\s+said\b/.test(labelText)) return 'user';

      if (turn.querySelector('.markdown, [class*="prose"]')) return 'assistant';
    } catch {}
    return '';
  }

  function readableNodeText(node) {
    if (!node) return '';
    try {
      return normalize(node.innerText || node.textContent || '');
    } catch {
      return '';
    }
  }

  function assistantText(turn) {
    if (!turn) return '';
    try {
      const directAssistant = turn.matches?.('[data-message-author-role="assistant"], [data-author="assistant"]')
        ? turn
        : turn.querySelector('[data-message-author-role="assistant"], [data-author="assistant"]');
      const scope = directAssistant || turn;

      const renderedNodes = Array.from(scope.querySelectorAll('.markdown, [class*="prose"]'));
      if (renderedNodes.length > 0) {
        const rendered = normalize(renderedNodes.map(readableNodeText).filter(Boolean).join(' '));
        if (rendered) return rendered;
      }

      if (directAssistant || roleOf(turn) === 'assistant') {
        const fallback = readableNodeText(scope)
          .replace(/^\s*(ChatGPT|Assistant)\s+said:\s*/i, '')
          .replace(/\s+(Copy|Good response|Bad response|Read aloud|Share|Regenerate)\s*$/i, '')
          .trim();
        return normalize(fallback);
      }
    } catch {}
    return '';
  }

  function latestPromptSnapshot() {
    const turns = turnNodes();
    if (turns.length === 0) return null;

    let assistantIndex = -1;
    let response = '';
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const text = assistantText(turns[index]);
      if (!text) continue;
      assistantIndex = index;
      response = text;
      break;
    }

    let latestUserIndex = -1;
    const userSearchEnd = assistantIndex >= 0 ? assistantIndex - 1 : turns.length - 1;
    for (let index = userSearchEnd; index >= 0; index -= 1) {
      if (roleOf(turns[index]) === 'user') {
        latestUserIndex = index;
        break;
      }
    }

    if (latestUserIndex < 0 && assistantIndex > 0) {
      for (let index = assistantIndex - 1; index >= 0; index -= 1) {
        if (roleOf(turns[index]) !== 'assistant') {
          latestUserIndex = index;
          break;
        }
      }
    }

    const userTurn = latestUserIndex >= 0 ? turns[latestUserIndex] : null;
    const promptKey = [
      location.pathname,
      userTurn?.getAttribute('data-testid') || `prompt-before-${assistantIndex}`
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
        observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      }

      timeoutId = setTimeout(() => finish(answerBoundToLatestPrompt()), FINAL_TURN_WAIT_MS);
      check();
    });
  }

  function currentProjectId() {
    try {
      const segments = location.pathname.split('/').filter(Boolean);
      for (let index = 0; index < segments.length - 1; index += 1) {
        if (segments[index] === 'g' && segments[index + 1]?.startsWith('g-p-')) return segments[index + 1];
      }
    } catch {}
    return '';
  }

  function currentProjectTitle() {
    const projectId = currentProjectId();
    if (!projectId) return '';
    try {
      const wantedPath = `/g/${projectId}/project`;
      let best = '';
      for (const node of document.querySelectorAll('[href]')) {
        const href = node.getAttribute('href') || '';
        let path = '';
        try { path = new URL(href, location.origin).pathname.replace(/\/+$/, ''); } catch { continue; }
        if (path !== wantedPath) continue;
        const label = normalize(
          node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || ''
        ).replace(/^Open project options for\s+/i, '').trim();
        if (label && label.length > best.length) best = label;
      }
      return best;
    } catch {
      return '';
    }
  }

  function sendCompletion(snapshot) {
    if (!isCurrentGeneration() || !snapshot?.response) return;
    const fingerprint = `${snapshot.promptKey}|${snapshot.assistantKey}|${snapshot.response.slice(0, 1000)}`;
    if (fingerprint === lastSentFingerprint) return;

    lastSentFingerprint = fingerprint;
    safeRuntimeSendMessage({
      type: 'CHATGPT_RESPONSE_COMPLETE',
      conversationUrl: location.href,
      projectTitle: currentProjectTitle(),
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
    waitForAnswerBoundToLatestPrompt().then(() => {
      if (!isCurrentGeneration() || token !== watchToken) return;
      const resolved = latestPromptSnapshot();
      if (resolved?.response) sendCompletion(resolved);
    }).catch(() => {});
  }

  function scheduleCompletionFromRequest() {
    if (completionTimer !== null) clearTimeout(completionTimer);
    completionTimer = setTimeout(() => {
      completionTimer = null;
      armForCurrentPrompt();
    }, RENDER_GRACE_MS);
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

      safeRuntimeSendMessage({ type: 'CHATGPT_CONVERSATION_VIEWED', conversationUrl });
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
      if (message?.type === 'CHATGPT_CONVERSATION_REQUEST_COMPLETED') scheduleCompletionFromRequest();
    });
  } catch {}

  scheduleViewedSignal();
})();
