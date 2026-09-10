'use strict';

(() => {
  let scriptVersion = '';
  try { scriptVersion = String(chrome.runtime.getManifest().version || ''); } catch {}
  if (!scriptVersion || globalThis.__chatgptNotifierRecoveryVersion === scriptVersion) return;
  globalThis.__chatgptNotifierRecoveryVersion = scriptVersion;

  const STORAGE_KEY = 'chatgptResponseNotifierRecoveryV1';
  const RETRY_INTERVAL_MS = 60000;
  const HARD_ERROR_GRACE_MS = 8000;
  const SLOW_ERROR_GRACE_MS = 60000;
  const MAX_AUTO_RELOADS = 5;
  const MAX_RECOVERY_WINDOW_MS = 6 * 60 * 1000;
  const CHECK_THROTTLE_MS = 250;

  const FAILURE_PATTERNS = [
    { id: 'connection-interrupted', label: 'Connection interrupted', needle: 'connection interrupted', initialDelayMs: HARD_ERROR_GRACE_MS },
    { id: 'delivery-failed', label: 'Delivery failed', needle: 'delivery failed', initialDelayMs: HARD_ERROR_GRACE_MS },
    { id: 'systems-taking-longer', label: 'Our systems are taking longer', needle: 'our systems are taking longer', initialDelayMs: SLOW_ERROR_GRACE_MS }
  ];

  let reloadTimer = null;
  let checkTimer = null;
  let observer = null;

  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const conversationKey = () => `${location.origin}${location.pathname}`;

  function loadState() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
      if (!parsed || parsed.conversationKey !== conversationKey()) return null;
      if (!Number.isFinite(parsed.startedAt) || Date.now() - parsed.startedAt > MAX_RECOVERY_WINDOW_MS * 2) {
        sessionStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function saveState(state) {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  }

  function clearState() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
    if (reloadTimer !== null) clearTimeout(reloadTimer);
    reloadTimer = null;
  }

  function roleOfTurn(turn) {
    if (!turn) return '';
    const direct = normalize(
      turn.getAttribute?.('data-turn') ||
      turn.getAttribute?.('data-message-author-role') ||
      turn.getAttribute?.('data-author') ||
      ''
    );
    if (direct === 'user' || direct === 'assistant') return direct;
    const roleNode = turn.querySelector?.('[data-message-author-role], [data-author]');
    const nested = normalize(
      roleNode?.getAttribute?.('data-message-author-role') ||
      roleNode?.getAttribute?.('data-author') ||
      ''
    );
    if (nested === 'user' || nested === 'assistant') return nested;
    if (turn.querySelector?.('.markdown, [class*="prose"]')) return 'assistant';
    return '';
  }

  function newestTurn() {
    try {
      const turns = Array.from(document.querySelectorAll('main [data-testid^="conversation-turn-"]'));
      return turns.length ? turns[turns.length - 1] : null;
    } catch {
      return null;
    }
  }

  function finalActionKind() {
    const turn = newestTurn();
    if (!turn || roleOfTurn(turn) === 'user') return '';
    try {
      const selectors = [
        'button[data-testid="good-response-turn-action-button"]',
        'button[data-testid="bad-response-turn-action-button"]',
        'button[data-testid="copy-turn-action-button"]',
        'button[data-testid="read-aloud-turn-action-button"]',
        'button[aria-label*="Good response" i]',
        'button[aria-label*="Bad response" i]',
        'button[aria-label*="Copy response" i]',
        'button[aria-label*="Read aloud" i]'
      ];
      return turn.querySelector(selectors.join(', ')) ? 'final-action' : '';
    } catch {
      return '';
    }
  }

  function textNodesUnder(root) {
    if (!root) return [];
    const nodes = [];
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && nodes.length < 12000) {
        nodes.push(node);
        node = walker.nextNode();
      }
    } catch {}
    return nodes;
  }

  function isAssistantAuthoredText(textNode) {
    const parent = textNode?.parentElement;
    if (!parent) return false;
    return Boolean(parent.closest('.markdown, [class*="prose"]'));
  }

  function failureFromRoot(root, requireNewestTurn = false) {
    if (!root) return null;
    const turn = root.closest?.('[data-testid^="conversation-turn-"]') || (root.matches?.('[data-testid^="conversation-turn-"]') ? root : null);
    if (turn && roleOfTurn(turn) === 'user') return null;
    if (requireNewestTurn && turn !== newestTurn()) return null;

    for (const textNode of textNodesUnder(root)) {
      if (isAssistantAuthoredText(textNode)) continue;
      const value = normalize(textNode.nodeValue);
      if (!value) continue;
      for (const pattern of FAILURE_PATTERNS) {
        if (value.includes(pattern.needle)) return pattern;
      }
    }
    return null;
  }

  function findKnownFailure() {
    const turn = newestTurn();
    if (turn && roleOfTurn(turn) !== 'user') {
      const fromTurn = failureFromRoot(turn, true);
      if (fromTurn) return fromTurn;
    }

    try {
      const globalStatusNodes = Array.from(document.querySelectorAll('[role="alert"], [aria-live="assertive"], [aria-live="polite"]'));
      for (const node of globalStatusNodes) {
        if (node.closest?.('[data-testid^="conversation-turn-"]')) continue;
        const failure = failureFromRoot(node, false);
        if (failure) return failure;
      }
    } catch {}
    return null;
  }

  function responseStillIncomplete() {
    if (finalActionKind()) return false;
    const turn = newestTurn();
    if (!turn) return true;
    if (roleOfTurn(turn) === 'user') return true;
    try {
      const text = normalize(turn.innerText || turn.textContent || '');
      return text.length < 1 || !finalActionKind();
    } catch {
      return true;
    }
  }

  function attentionPreview(state, failure) {
    if (failure) {
      return `Automatic recovery tried ${state.attempts} refresh${state.attempts === 1 ? '' : 'es'}, but this chat still shows “${failure.label}”. Open the chat to intervene.`;
    }
    const minutes = Math.max(1, Math.round((Date.now() - state.startedAt) / 60000));
    return `This chat still appears incomplete after ${state.attempts} automatic refresh${state.attempts === 1 ? '' : 'es'} over about ${minutes} minute${minutes === 1 ? '' : 's'}. Open the chat to intervene.`;
  }

  function notifyAttention(state, failure) {
    if (state.attentionSent) return;
    state.attentionSent = true;
    state.lastReason = failure?.id || state.lastReason || 'still-incomplete';
    saveState(state);
    try {
      chrome.runtime.sendMessage({
        type: 'CHATGPT_RECOVERY_ATTENTION',
        conversationUrl: location.href,
        sessionTitle: document.title,
        preview: attentionPreview(state, failure)
      }).catch?.(() => {});
    } catch {}
  }

  function exhausted(state) {
    return state.attempts >= MAX_AUTO_RELOADS || Date.now() - state.startedAt >= MAX_RECOVERY_WINDOW_MS;
  }

  function reloadForRecovery(state, reason) {
    if (state.attentionSent) return;
    if (exhausted(state)) {
      notifyAttention(state, findKnownFailure());
      return;
    }
    state.attempts += 1;
    state.lastReloadAt = Date.now();
    state.lastReason = reason || state.lastReason || 'still-incomplete';
    saveState(state);
    location.reload();
  }

  function scheduleReload(state, delayMs, reason) {
    if (reloadTimer !== null || state.attentionSent) return;
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      const current = loadState() || state;
      const failure = findKnownFailure();
      if (!failure && finalActionKind()) {
        clearState();
        return;
      }
      if (exhausted(current)) {
        notifyAttention(current, failure);
        return;
      }
      if (failure || responseStillIncomplete()) reloadForRecovery(current, failure?.id || reason);
      else clearState();
    }, delayMs);
  }

  function beginOrContinueRecovery(failure) {
    let state = loadState();
    if (!state) {
      state = {
        conversationKey: conversationKey(),
        startedAt: Date.now(),
        attempts: 0,
        lastReloadAt: 0,
        lastReason: failure?.id || 'still-incomplete',
        attentionSent: false
      };
      saveState(state);
    }

    if (state.attentionSent) return;
    if (!failure && finalActionKind()) {
      clearState();
      return;
    }
    if (exhausted(state)) {
      notifyAttention(state, failure);
      return;
    }

    const firstAttempt = state.attempts === 0;
    const delayMs = firstAttempt && failure ? failure.initialDelayMs : RETRY_INTERVAL_MS;
    scheduleReload(state, delayMs, failure?.id || 'still-incomplete');
  }

  function checkPage() {
    checkTimer = null;
    const failure = findKnownFailure();
    const state = loadState();

    if (failure) {
      beginOrContinueRecovery(failure);
      return;
    }
    if (finalActionKind()) {
      if (state) clearState();
      return;
    }
    if (state && !state.attentionSent) beginOrContinueRecovery(null);
  }

  function scheduleCheck() {
    if (checkTimer !== null) return;
    checkTimer = setTimeout(checkPage, CHECK_THROTTLE_MS);
  }

  function signalDeliberateInteraction(event) {
    if (event?.isTrusted === false) return;
    if (loadState()) clearState();
    try {
      chrome.runtime.sendMessage({
        type: 'CHATGPT_CONVERSATION_USER_INTERACTED',
        conversationUrl: location.href
      }).catch?.(() => {});
    } catch {}
  }

  document.addEventListener('pointerdown', signalDeliberateInteraction, true);
  document.addEventListener('keydown', signalDeliberateInteraction, true);

  try {
    observer = new MutationObserver(scheduleCheck);
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-testid', 'aria-label', 'aria-live', 'role', 'class']
    });
  } catch {}

  scheduleCheck();
})();
