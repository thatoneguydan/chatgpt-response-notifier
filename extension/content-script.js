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
  const ANSWER_STABLE_AFTER_UNOBSERVED_FINAL_ACTION_MS = 3000;
  const ANSWER_STABLE_AFTER_GENERATION_MS = 1200;
  const ANSWER_STABLE_WITHOUT_GENERATION_MARKER_MS = 45000;
  const MIN_TRUSTED_MARKERLESS_RESPONSE_CHARS = 80;
  const ANSWER_CHECK_THROTTLE_MS = 100;
  const REQUEST_RENDER_GRACE_MS = 100;
  const INTERACTION_SIGNAL_DEDUPE_MS = 750;
  const CAPTURE_DIAGNOSTIC_HISTORY_LIMIT = 8;
  const CAPTURE_DIAGNOSTIC_HISTORY_KEY = '__chatgptNativeNotifierCaptureHistoryV1';
  const RECOVERY_REQUEST_EVENT = 'chatgpt-native-notifier-recovery-needed';
  let watchToken = 0;
  let completionGeneration = 0;
  let lastSentFingerprint = '';
  let suppressUntilEpoch = 0;
  let lastInteractionUrl = '';
  let lastInteractionAt = 0;
  let completionTimer = null;
  let cancelActiveCompletionWait = null;
  let captureDiagnosticHistory = readCaptureDiagnosticHistory();
  let lastCaptureDiagnostic = captureDiagnosticHistory[0] || null;

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

  function readCaptureDiagnosticHistory() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(CAPTURE_DIAGNOSTIC_HISTORY_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((entry) => entry && typeof entry === 'object')
        .slice(0, CAPTURE_DIAGNOSTIC_HISTORY_LIMIT);
    } catch {
      return [];
    }
  }

  function persistCaptureDiagnosticHistory() {
    try {
      sessionStorage.setItem(
        CAPTURE_DIAGNOSTIC_HISTORY_KEY,
        JSON.stringify(captureDiagnosticHistory.slice(0, CAPTURE_DIAGNOSTIC_HISTORY_LIMIT))
      );
    } catch {}
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

  function topLevelRenderedNodes(nodes) {
    return nodes.filter((node, index) => !nodes.some((other, otherIndex) => (
      otherIndex !== index && other !== node && other.contains?.(node)
    )));
  }

  function joinedUniqueNodeText(nodes) {
    const texts = [];
    const seen = new Set();
    for (const node of nodes) {
      const text = readableNodeText(node);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      texts.push(text);
    }
    return normalize(texts.join(' '));
  }

  function cleanTurnFallbackText(text) {
    return normalize(text)
      .replace(/^\s*(ChatGPT|Assistant)\s+said:?\s*/i, '')
      .replace(/(?:\s+(?:Copy|Copy response|Good response|Bad response|Read aloud|Share|Regenerate|Retry|More))+\s*$/i, '')
      .trim();
  }

  function assistantCapture(turn) {
    const empty = {
      text: '',
      source: 'none',
      turnTextLength: 0,
      responseSurfaceCount: 0,
      responseSurfaceTextLength: 0,
      assistantRoleNodeCount: 0,
      assistantRoleTextLength: 0
    };
    if (!turn) return empty;

    try {
      if (roleOf(turn) === 'user') return empty;

      const responseSurfaceNodes = topLevelRenderedNodes(
        Array.from(turn.querySelectorAll('.markdown, [class*="prose"]'))
          .filter(isRenderedElement)
      );
      const responseSurfaceText = joinedUniqueNodeText(responseSurfaceNodes);

      const assistantRoleNodes = topLevelRenderedNodes([
        ...(turn.matches?.('[data-message-author-role="assistant"], [data-author="assistant"]') ? [turn] : []),
        ...Array.from(turn.querySelectorAll('[data-message-author-role="assistant"], [data-author="assistant"]'))
          .filter(isRenderedElement)
      ]);
      const assistantRoleText = joinedUniqueNodeText(assistantRoleNodes);
      const turnText = cleanTurnFallbackText(readableNodeText(turn));

      const candidates = [
        { source: 'rendered-surfaces', text: responseSurfaceText },
        { source: 'assistant-role-nodes', text: assistantRoleText },
        { source: 'whole-turn', text: turnText }
      ].filter((candidate) => candidate.text);
      candidates.sort((left, right) => right.text.length - left.text.length);
      const best = candidates[0] || { source: 'none', text: '' };

      return {
        text: best.text,
        source: best.source,
        turnTextLength: turnText.length,
        responseSurfaceCount: responseSurfaceNodes.length,
        responseSurfaceTextLength: responseSurfaceText.length,
        assistantRoleNodeCount: assistantRoleNodes.length,
        assistantRoleTextLength: assistantRoleText.length
      };
    } catch {
      return empty;
    }
  }

  function finalResponseActionKind(turn) {
    if (!turn) return '';
    try {
      const buttons = Array.from(turn.querySelectorAll([
        'button[data-testid="good-response-turn-action-button"]',
        'button[data-testid="bad-response-turn-action-button"]',
        'button[data-testid="copy-turn-action-button"]',
        'button[data-testid="read-aloud-turn-action-button"]',
        'button[aria-label*="Good response" i]',
        'button[aria-label*="Bad response" i]',
        'button[aria-label*="Copy response" i]',
        'button[aria-label*="Read aloud" i]'
      ].join(', '))).filter((button) => !button.disabled);

      for (const button of buttons) {
        const testId = normalize(button.getAttribute('data-testid')).toLowerCase();
        const ariaLabel = normalize(button.getAttribute('aria-label')).toLowerCase();
        if (testId.includes('good-response') || ariaLabel.includes('good response')) return 'good-response';
        if (testId.includes('bad-response') || ariaLabel.includes('bad response')) return 'bad-response';
        if (testId.includes('copy-turn') || ariaLabel.includes('copy response')) return 'copy-response';
        if (testId.includes('read-aloud') || ariaLabel.includes('read aloud')) return 'read-aloud';
      }
    } catch {}
    return '';
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
      if (turn.getAttribute?.('aria-busy') === 'true') return true;
      return Boolean(turn.querySelector?.('[aria-busy="true"]'));
    } catch {
      return false;
    }
  }

  function hasResultStreamingSignal(turn) {
    if (!turn) return false;
    try {
      if (turn.matches?.('.result-streaming') && isRenderedElement(turn)) return true;
      return Array.from(turn.querySelectorAll('.result-streaming'))
        .some((node) => isRenderedElement(node));
    } catch {
      return false;
    }
  }

  function responseRenderSignature(turn, response) {
    if (!turn) return String(response || '');
    try {
      const contentNodes = Array.from(turn.querySelectorAll(
        '.markdown, [class*="prose"], p, pre, code, strong, b, em, i, ul, ol, li, table, thead, tbody, tr, th, td, blockquote, h1, h2, h3, h4, h5, h6, hr'
      ));
      const structure = contentNodes.map((node) => [
        node.tagName,
        node.childElementCount,
        String(node.innerHTML || '').length,
        readableNodeText(node).length
      ].join(':')).join('|');
      return `${String(response || '')}::${contentNodes.length}::${structure}`;
    } catch {
      return String(response || '');
    }
  }

  function completionSettleSignature(snapshot) {
    if (!snapshot) return '';
    return [
      snapshot.renderSignature || '',
      `final=${snapshot.finalActionKind || 'none'}`,
      `generation=${snapshot.generationActive ? 'active' : 'idle'}`
    ].join('::');
  }

  function hasTrustworthyMarkerlessCapture(snapshot) {
    if (!snapshot?.response || snapshot.response.length < MIN_TRUSTED_MARKERLESS_RESPONSE_CHARS) return false;
    if (snapshot.captureSource === 'whole-turn') return false;
    const authoredSurfaceLength = Math.max(
      Number(snapshot.responseSurfaceTextLength || 0),
      Number(snapshot.assistantRoleTextLength || 0)
    );
    return authoredSurfaceLength >= MIN_TRUSTED_MARKERLESS_RESPONSE_CHARS;
  }

  function latestPromptSnapshot() {
    const turns = turnNodes();
    if (turns.length === 0) return null;

    const assistantIndex = turns.length - 1;
    const assistantTurn = turns[assistantIndex];
    const capture = assistantCapture(assistantTurn);
    const response = capture.text;
    const promptTurn = assistantIndex > 0 ? turns[assistantIndex - 1] : null;
    const stopButtonActive = hasVisibleStopButton();
    const assistantBusy = hasBusyAssistantSignal(assistantTurn);
    const resultStreamingActive = hasResultStreamingSignal(assistantTurn);
    const finalActionKind = finalResponseActionKind(assistantTurn);
    const renderSignature = responseRenderSignature(assistantTurn, response);

    return {
      promptKey: [location.pathname, promptTurn?.getAttribute('data-testid') || `prompt-before-${assistantIndex}`].join('|'),
      assistantKey: assistantTurn?.getAttribute('data-testid') || `assistant-${assistantIndex}`,
      response,
      captureSource: capture.source,
      turnTextLength: capture.turnTextLength,
      responseSurfaceCount: capture.responseSurfaceCount,
      responseSurfaceTextLength: capture.responseSurfaceTextLength,
      assistantRoleNodeCount: capture.assistantRoleNodeCount,
      assistantRoleTextLength: capture.assistantRoleTextLength,
      renderSignature,
      finalActionKind,
      finalActionReady: Boolean(finalActionKind),
      stopButtonActive,
      assistantBusy,
      resultStreamingActive,
      generationActive: stopButtonActive || assistantBusy || resultStreamingActive
    };
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

  function captureDiagnostic(status, snapshot, requestObservedAt, generationObserved = false) {
    const diagnostic = {
      status,
      responseLength: Number(snapshot?.response?.length || 0),
      captureSource: String(snapshot?.captureSource || 'none'),
      turnTextLength: Number(snapshot?.turnTextLength || 0),
      responseSurfaceCount: Number(snapshot?.responseSurfaceCount || 0),
      responseSurfaceTextLength: Number(snapshot?.responseSurfaceTextLength || 0),
      assistantRoleNodeCount: Number(snapshot?.assistantRoleNodeCount || 0),
      assistantRoleTextLength: Number(snapshot?.assistantRoleTextLength || 0),
      renderSignatureLength: Number(snapshot?.renderSignature?.length || 0),
      finalActionKind: String(snapshot?.finalActionKind || ''),
      finalActionReady: Boolean(snapshot?.finalActionReady),
      generationActive: Boolean(snapshot?.generationActive),
      generationObserved: Boolean(generationObserved),
      stopButtonActive: Boolean(snapshot?.stopButtonActive),
      assistantBusy: Boolean(snapshot?.assistantBusy),
      resultStreamingActive: Boolean(snapshot?.resultStreamingActive),
      elapsedMs: Math.max(0, Date.now() - requestObservedAt),
      extensionVersion: scriptVersion,
      observedAt: new Date().toISOString(),
      projectContext: Boolean(currentProjectId())
    };
    lastCaptureDiagnostic = diagnostic;
    captureDiagnosticHistory = [diagnostic, ...captureDiagnosticHistory].slice(0, CAPTURE_DIAGNOSTIC_HISTORY_LIMIT);
    persistCaptureDiagnosticHistory();
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
      let lastSettleSignature = '';
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
        if (snapshot?.finalActionReady) {
          return generationObserved ? ANSWER_STABLE_AFTER_FINAL_ACTION_MS : ANSWER_STABLE_AFTER_UNOBSERVED_FINAL_ACTION_MS;
        }
        if (generationObserved) return ANSWER_STABLE_AFTER_GENERATION_MS;
        return ANSWER_STABLE_WITHOUT_GENERATION_MARKER_MS;
      };

      const scheduleStableFinish = (settleSignature, delayMs) => {
        resetStableTimer();
        stableId = setTimeout(() => {
          stableId = null;
          if (!isCurrentGeneration()) return finish(null, 'superseded-extension-generation');
          const finalSnapshot = latestPromptSnapshot();
          if (!finalSnapshot?.response) return;
          const finalSettleSignature = completionSettleSignature(finalSnapshot);
          if (finalSnapshot.generationActive && !finalSnapshot.finalActionReady) {
            generationObserved = true;
            lastSettleSignature = finalSettleSignature;
            return;
          }
          if (finalSettleSignature !== settleSignature) {
            lastSettleSignature = finalSettleSignature;
            scheduleStableFinish(lastSettleSignature, stableDelayFor(finalSnapshot));
            return;
          }
          if (!finalSnapshot.finalActionReady && !generationObserved && !hasTrustworthyMarkerlessCapture(finalSnapshot)) {
            finish(finalSnapshot, 'markerless-capture-untrusted');
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
        const settleSignature = completionSettleSignature(snapshot);
        if (snapshot?.generationActive && !snapshot.finalActionReady) {
          generationObserved = true;
          lastSettleSignature = settleSignature;
          resetStableTimer();
          return;
        }
        if (!text) {
          lastSettleSignature = '';
          resetStableTimer();
          return;
        }
        if (settleSignature === lastSettleSignature && stableId !== null) return;
        lastSettleSignature = settleSignature;
        scheduleStableFinish(settleSignature, stableDelayFor(snapshot));
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
          finalSnapshot?.response && (!finalSnapshot.generationActive || finalSnapshot.finalActionReady) ? finalSnapshot : null,
          finalSnapshot?.response && (!finalSnapshot.generationActive || finalSnapshot.finalActionReady)
            ? 'completion-timeout-idle-verified'
            : 'timeout-still-generating-or-empty'
        );
      }, COMPLETION_TIMEOUT_MS);
      check();
    });
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

  function requestRecoveryForUntrustedCapture() {
    try {
      document.dispatchEvent(new CustomEvent(RECOVERY_REQUEST_EVENT, { detail: { reason: 'markerless-capture-untrusted' } }));
    } catch {}
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
        const status = result?.status || 'unknown';
        captureDiagnostic(status, result?.snapshot || latestPromptSnapshot(), requestObservedAt, result?.generationObserved);
        if (status === 'markerless-capture-untrusted') {
          requestRecoveryForUntrustedCapture();
          return;
        }
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

  function signalConversationInteraction(event) {
    if (!isCurrentGeneration() || event?.isTrusted === false) return;
    const conversationUrl = location.href;
    const now = Date.now();
    if (conversationUrl === lastInteractionUrl && now - lastInteractionAt < INTERACTION_SIGNAL_DEDUPE_MS) return;
    lastInteractionUrl = conversationUrl;
    lastInteractionAt = now;
    safeRuntimeSendMessage({ type: 'CHATGPT_CONVERSATION_INTERACTED', conversationUrl });
  }

  document.addEventListener('pointerdown', signalConversationInteraction, true);
  document.addEventListener('keydown', signalConversationInteraction, true);
  document.addEventListener('wheel', signalConversationInteraction, { capture: true, passive: true });

  document.addEventListener('click', (event) => {
    if (!isCurrentGeneration() || !isStopButton(event.target)) return;
    watchToken += 1;
    completionGeneration += 1;
    if (cancelActiveCompletionWait) cancelActiveCompletionWait();
    suppressUntilEpoch = Date.now() + 1500;
  }, true);

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!isCurrentGeneration()) return false;
      if (message?.type === 'CHATGPT_CONVERSATION_REQUEST_COMPLETED') {
        scheduleCompletionFromRequest();
        return false;
      }
      if (message?.type === 'GET_CHATGPT_CAPTURE_DIAGNOSTIC') {
        sendResponse?.({ ok: true, capture: lastCaptureDiagnostic, history: captureDiagnosticHistory });
        return false;
      }
      return false;
    });
  } catch {}
})();
