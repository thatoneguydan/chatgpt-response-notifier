'use strict';

(() => {
  if (globalThis.__chatgptNotifierRecoveryInstalled) return;
  globalThis.__chatgptNotifierRecoveryInstalled = true;

  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const FINISHED_ACTION_SELECTOR = [
    '[data-testid="more-turn-action-button"]',
    '[data-test-id="more-menu-button"]',
    '[data-testid="copy-turn-action-button"]',
    '[data-test-id="copy-button"]',
    '[data-testid="good-response-turn-action-button"]',
    '[data-test-id="rate-up-button"]',
    '[data-testid="bad-response-turn-action-button"]',
    '[data-test-id="rate-down-button"]',
    '[data-testid="voice-play-turn-action-button"]',
    'button[aria-label="More actions" i]',
    'button[aria-label="More" i]',
    'button[aria-label="Copy response" i]',
    'button[aria-label="Copy" i]',
    'button[aria-label="Read aloud" i]'
  ].join(', ');
  const MANUAL_STOP_SELECTOR = 'button[data-testid="stop-button"], button[data-testid="fruitjuice-stop-button"]';
  const RECHECK_DELAY_MS = 1000;
  const MAX_RECHECKS = 12;

  let recoveryArmed = false;
  let recoveryCompleted = false;
  let recoverySignalInFlight = false;
  let observer = null;
  let scheduledCheck = null;
  let queryInFlight = false;
  let rechecksRemaining = MAX_RECHECKS;

  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function conversationIdFromUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''));
      if (url.hostname !== 'chatgpt.com' && url.hostname !== 'www.chatgpt.com') return '';
      const segments = url.pathname.split('/').filter(Boolean);
      for (let index = segments.length - 2; index >= 0; index -= 1) {
        if (segments[index] !== 'c') continue;
        return decodeURIComponent(segments[index + 1] || '').trim();
      }
    } catch {}
    return '';
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

  function latestPromptAndAssistant() {
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
    if (assistantIndex < 0 || !response) return null;

    const userTurn = turns[latestUserIndex];
    const assistantTurn = turns[assistantIndex];
    return {
      promptKey: [
        location.pathname,
        userTurn?.getAttribute('data-testid') || `user-${latestUserIndex}`
      ].join('|'),
      assistantKey: assistantTurn?.getAttribute('data-testid') || `assistant-${assistantIndex}`,
      response,
      assistantTurn
    };
  }

  function hasFinishedAction(assistantTurn) {
    if (!assistantTurn) return false;
    try {
      return Boolean(assistantTurn.querySelector(FINISHED_ACTION_SELECTOR));
    } catch {
      return false;
    }
  }

  function stopObserving() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (scheduledCheck !== null) {
      clearTimeout(scheduledCheck);
      scheduledCheck = null;
    }
  }

  async function sendRecoveredCompletion(snapshot) {
    if (recoveryCompleted || recoverySignalInFlight) return;
    recoverySignalInFlight = true;
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'CHATGPT_RECOVERY_FINISHED_UI',
        conversationUrl: location.href,
        assistantKey: snapshot.assistantKey
      });
      if (result?.armed === true) {
        recoveryCompleted = true;
        stopObserving();
      }
    } catch {}
    finally {
      recoverySignalInFlight = false;
    }
  }

  function checkForRecoveredCompletion() {
    scheduledCheck = null;
    if (!recoveryArmed || recoveryCompleted) return;
    const snapshot = latestPromptAndAssistant();
    if (!snapshot) return;

    // Recovery is intentionally permissive: any known finished-response action
    // on the latest assistant turn is enough. The composer Stop/send control is
    // never required because pre-typing can change its visual state.
    if (hasFinishedAction(snapshot.assistantTurn)) sendRecoveredCompletion(snapshot).catch(() => {});
  }

  function scheduleCompletionCheck() {
    if (scheduledCheck !== null || recoveryCompleted) return;
    scheduledCheck = setTimeout(checkForRecoveredCompletion, 100);
  }

  function armRecoveryWatcher() {
    if (recoveryArmed || recoveryCompleted) return;
    recoveryArmed = true;
    const root = document.querySelector('main') || document.body || document.documentElement;
    if (root && typeof MutationObserver === 'function') {
      observer = new MutationObserver(scheduleCompletionCheck);
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    }
    scheduleCompletionCheck();
  }

  async function queryRecoveryState() {
    if (queryInFlight || recoveryArmed || recoveryCompleted) return;
    const conversationId = conversationIdFromUrl(location.href);
    if (!conversationId) return;
    queryInFlight = true;
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'CHATGPT_RECOVERY_QUERY',
        conversationUrl: location.href
      });
      if (result?.pending === true) armRecoveryWatcher();
    } catch {}
    finally {
      queryInFlight = false;
    }
  }

  function scheduleUrlRecheck() {
    if (recoveryArmed || recoveryCompleted || rechecksRemaining <= 0) return;
    rechecksRemaining -= 1;
    setTimeout(() => {
      queryRecoveryState().catch(() => {});
      scheduleUrlRecheck();
    }, RECHECK_DELAY_MS);
  }

  function composerHasDraft() {
    try {
      const composer = document.querySelector('#prompt-textarea');
      if (!composer) return false;
      const value = 'value' in composer ? composer.value : (composer.textContent || composer.innerText || '');
      return normalize(value).length > 0;
    } catch {
      return false;
    }
  }

  function cancelPendingOnManualStop(event) {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest(MANUAL_STOP_SELECTOR)) return;
    // When the user pre-types a follow-up, ChatGPT can visually turn the Stop
    // control into a send arrow. Do not treat that state as a manual cancel.
    if (composerHasDraft()) return;
    stopObserving();
    recoveryArmed = false;
    recoveryCompleted = true;
    try {
      chrome.runtime.sendMessage({
        type: 'CHATGPT_RECOVERY_CANCEL',
        conversationUrl: location.href
      }).catch(() => {});
    } catch {}
  }

  document.addEventListener('click', cancelPendingOnManualStop, true);
  queryRecoveryState().catch(() => {});
  scheduleUrlRecheck();
})();
