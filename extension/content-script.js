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
  const COMPLETION_TIMEOUT_MS = 1800000;
  const ANSWER_STABLE_AFTER_FINAL_ACTION_MS = 500;
  const ANSWER_STABLE_AFTER_GENERATION_MS = 1200;
  const ANSWER_STABLE_WITHOUT_GENERATION_MARKER_MS = 2500;
  const ANSWER_CHECK_THROTTLE_MS = 100;
  const REQUEST_RENDER_GRACE_MS = 100;
  const VIEW_SIGNAL_DELAY_MS = 80;
  const VIEW_SIGNAL_DEDUPE_MS = 750;
  let watchToken = 0;
  let completionGeneration = 0;
  let lastSentFingerprint = '';
  let suppressUntilEpoch = 0;
  let viewSignalTimer = null;
  let lastViewedUrl = '';
  let lastViewedAt = 0;
  let completionTimer = null;
  let cancelActiveCompletionWait = null;
  let lastCaptureDiagnostic = null;

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

  function conversationRoot() {
    try { return document.querySelector('main'); } catch { return null; }
  }

  function turnNodes() {
    const root = conversationRoot();
    if (!root) return [];
    try {
      return Array.from(root.querySelectorAll('[data-testid^="conversation-turn-"]'))
        .filter((node) => node instanceof HTMLElement);
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

  function isRenderedElement(node) {
    if (!(node instanceof HTMLElement)) return false;
    try {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch {
      return true;
    }
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
      if (roleOf(turn) === 'user') return '';

      const directAssistant = turn.matches?.('[data-message-author-role="assistant"], [data-author="assistant"]')
        ? turn
        : turn.querySelector('[data-message-author-role="assistant"], [data-author="assistant"]');
      const scope = directAssistant || turn;

      const renderedTexts = Array.from(scope.querySelectorAll('.markdown, [class*="prose"]'))
        .filter(isRenderedElement)
        .map(readableNodeText)
        .filter(Boolean);
      if (renderedTexts.length > 0) {
        const unique = [...new Set(renderedTexts)];
        unique.sort((left, right) => right.length - left.length);
        if (unique[0]) return unique[0];
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

  function hasFinalResponseAction(turn) {
    if (!turn) return false;
    try {
      const buttons = Array.from(turn.querySelectorAll(
        'button[data-testid="copy-turn-action-button"], button[aria-label*="Copy response" i]'
      ));
      return buttons.some((button) => !button.disabled && isRenderedElement(button));
    } catch {
      return false;
    }
  }

  function hasVisibleStopButton() {
    try {
      return Array.from(document.querySelectorAll(
        'button[data-testid="stop-button"], button[data-testid="fruitjuice-stop-button"]'
      )).some((button) => !button.disabled && isRenderedElement(button));
    } catch {
      return false;
    }
  }

  function hasBusyAssistantSignal(turn) {
    if (!turn) return false;
    try {
      const directAssistant = turn.matches?.('[data-message-author-role="assistant"], [data-author="assistant"]')
        ? turn
        : turn.querySelector('[data-message-author-role="assistant"], [data-author="assistant"]');
      const scope = directAssistant || turn;
      if (scope.getAttribute?.('aria-busy') === 'true') return true;
      return Boolean(scope.querySelector?.('[aria-busy="true"]'));
    } catch {
      return false;
    }
  }

  function latestPromptSnapshot() {
    const turns = turnNodes();
    if (turns.length === 0) return null;

    // Never scan backwards to an older assistant answer. The current response
    // must live in the newest canonical conversation turn; otherwise we wait.
    const assistantIndex = turns.length - 1;
    const assistantTurn = turns[assistantIndex];
    const response = assistantText(assistantTurn);
    const promptTurn = assistantIndex > 0 ? turns[assistantIndex - 1] : null;
    const stopButtonActive = hasVisibleStopButton();
    const assistantBusy = hasBusyAssistantSignal(assistantTurn);

    return {
      promptKey: [
        location.pathname,
        promptTurn?.getAttribute('data-testid') || `prompt-before-${assistantIndex}`
      ].join('|'),
      assistantKey: assistantTurn?.getAttribute('data-testid') || `assistant-${assistantIndex}`,
      response,
      finalActionReady: hasFinalResponseAction(assistantTurn),
      stopButtonActive,
      assistantBusy,
      generationActive: stopButtonActive || assistantBusy
    };
  }

  function captureDiagnostic(status, snapshot, requestObservedAt, generationObserved = false) {
    lastCaptureDiagnostic = {
      status,
      responseLength: Number(snapshot?.response?.length || 0),
      finalActionReady: Boolean(snapshot?.finalActionReady),
      generationActive: Boolean(snapshot?.generationActive),
      generationObserved: Boolean(generationObserved),
      stopButtonActive: Boolean(snapshot?.stopButtonActive),
      assistantBusy: Boolean(snapshot?.assistantBusy),
      elapsedMs: Math.max(0, Date.now() - requestObservedAt),
      extensionVersion: scriptVersion,
      observedAt: new Date().toISOString()
    };
  }

  function waitForCompletedLatestAnswer() {
    return new Promise((resolve) => {
      const root = conversationRoot();
      const observedRoot = document.body || document.documentElement || root;
      if (!root || !observedRoot) {
        resolve({ snapshot: null, status: 'no-conversation-root', generationObserved: false });
        return;
      }

      let settled = false;
      let observer = null;
      let timeoutId = null;
      let throttleId = null;
      let stableId = null;
      let lastText = '';
      let generationObserved = false;
      let cancelThisWait = null;

      const cleanup = () => {
        observer?.disconnect();
        if (timeoutId !== null) clearTimeout(timeoutId);
        if (throttleId !== null) clearTimeout(throttleId);
        if (stableId !== null) clearTimeout(stableId);
        if (cancelActiveCompletionWait === cancelThisWait) cancelActiveCompletionWait = null;
      };

      const finish = (snapshot, status) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ snapshot: snapshot?.response ? snapshot : null, status, generationObserved });
      };

      cancelThisWait = () => finish(null, 'superseded-by-new-request');
      if (cancelActiveCompletionWait) cancelActiveCompletionWait();
      cancelActiveCompletionWait = cancelThisWait;

      const resetStableTimer = () => {
        if (stableId !== null) {
          clearTimeout(stableId);
          stableId = null;
        }
      };

      const stableDelayFor = (snapshot) => {
        if (snapshot?.finalActionReady) return ANSWER_STABLE_AFTER_FINAL_ACTION_MS;
        if (generationObserved) return ANSWER_STABLE_AFTER_GENERATION_MS;
        return ANSWER_STABLE_WITHOUT_GENERATION_MARKER_MS;
      };

      const scheduleStableFinish = (text, delayMs) => {
        resetStableTimer();
        stableId = setTimeout(() => {
          stableId = null;
          if (!isCurrentGeneration()) return finish(null, 'superseded-extension-generation');
          const finalSnapshot = latestPromptSnapshot();
          if (!finalSnapshot?.response) return;
          if (finalSnapshot.generationActive && !finalSnapshot.finalActionReady) {
            generationObserved = true;
            lastText = finalSnapshot.response;
            return;
          }
          if (finalSnapshot.response !== text) {
            lastText = finalSnapshot.response;
            scheduleStableFinish(lastText, stableDelayFor(finalSnapshot));
            return;
          }
          const status = finalSnapshot.finalActionReady
            ? 'final-action-stable'
            : generationObserved
              ? 'generation-ended-stable'
              : 'idle-stable-no-generation-marker';
          finish(finalSnapshot, status);
        }, delayMs);
      };

      const check = () => {
        throttleId = null;
        if (settled || !isCurrentGeneration()) return;
        const snapshot = latestPromptSnapshot();
        const text = snapshot?.response || '';
        if (snapshot?.generationActive && !snapshot.finalActionReady) {
          generationObserved = true;
          lastText = text;
          resetStableTimer();
          return;
        }
        if (!text) {
          lastText = '';
          resetStableTimer();
          return;
        }
        if (text === lastText && stableId !== null) return;
        lastText = text;
        scheduleStableFinish(text, stableDelayFor(snapshot));
      };

      const scheduleCheck = () => {
        if (settled || throttleId !== null) return;
        throttleId = setTimeout(check, ANSWER_CHECK_THROTTLE_MS);
      };

      observer = new MutationObserver(scheduleCheck);
      observer.observe(observedRoot, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['data-testid', 'aria-label', 'aria-busy', 'disabled', 'class', 'style']
      });
      timeoutId = setTimeout(() => {
        const finalSnapshot = latestPromptSnapshot();
        finish(
          finalSnapshot?.response && (!finalSnapshot.generationActive || finalSnapshot.finalActionReady)
            ? finalSnapshot
            : null,
          finalSnapshot?.response && (!finalSnapshot.generationActive || finalSnapshot.finalActionReady)
            ? 'completion-timeout-idle-verified'
            : 'timeout-still-generating-or-empty'
        );
      }, COMPLETION_TIMEOUT_MS);
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

  function cleanProjectLabel(rawLabel) {
    const label = normalize(rawLabel);
    if (!label) return '';
    const optionMatch = label.match(/^Open project options for\s+(.+)$/i);
    if (optionMatch?.[1]) return normalize(optionMatch[1]);
    const openProjectMatch = label.match(/^Open\s+(.+?)\s+project(?:\b.*)?$/i);
    if (openProjectMatch?.[1]) return normalize(openProjectMatch[1]);
    return label;
  }

  function currentProjectTitle() {
    const projectId = currentProjectId();
    if (!projectId) return '';
    try {
      const wantedPath = `/g/${projectId}/project`;
      const candidates = [];
      for (const node of document.querySelectorAll('[href]')) {
        const href = node.getAttribute('href') || '';
        let path = '';
        try { path = new URL(href, location.origin).pathname.replace(/\/+$/, ''); } catch { continue; }
        if (path !== wantedPath) continue;
        for (const raw of [node.getAttribute('aria-label'), node.getAttribute('title'), node.textContent]) {
          const cleaned = cleanProjectLabel(raw);
          if (cleaned) candidates.push(cleaned);
        }
      }
      candidates.sort((left, right) => left.length - right.length);
      return candidates[0] || '';
    } catch {
      return '';
    }
  }

  function sendCompletion(snapshot) {
    if (!isCurrentGeneration() || !snapshot?.response) return;
    if (snapshot.generationActive && !snapshot.finalActionReady) return;
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

  function scheduleCompletionFromRequest() {
    const requestGeneration = ++completionGeneration;
    const requestObservedAt = Date.now();
    if (completionTimer !== null) clearTimeout(completionTimer);
    if (cancelActiveCompletionWait) cancelActiveCompletionWait();
    completionTimer = setTimeout(() => {
      completionTimer = null;
      if (!isCurrentGeneration() || Date.now() < suppressUntilEpoch) return;
      const token = watchToken;
      waitForCompletedLatestAnswer().then((result) => {
        if (!isCurrentGeneration()) return;
        if (requestGeneration !== completionGeneration || token !== watchToken) return;
        captureDiagnostic(
          result?.status || 'unknown',
          result?.snapshot || latestPromptSnapshot(),
          requestObservedAt,
          result?.generationObserved
        );
        if (result?.snapshot?.response) sendCompletion(result.snapshot);
      }).catch(() => {
        captureDiagnostic('capture-error', latestPromptSnapshot(), requestObservedAt, false);
      });
    }, REQUEST_RENDER_GRACE_MS);
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
    completionGeneration += 1;
    if (cancelActiveCompletionWait) cancelActiveCompletionWait();
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
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!isCurrentGeneration()) return false;
      if (message?.type === 'CHATGPT_CONVERSATION_REQUEST_COMPLETED') {
        scheduleCompletionFromRequest();
        return false;
      }
      if (message?.type === 'GET_CHATGPT_CAPTURE_DIAGNOSTIC') {
        sendResponse?.({ ok: true, capture: lastCaptureDiagnostic });
        return false;
      }
      return false;
    });
  } catch {}

  scheduleViewedSignal();
})();
