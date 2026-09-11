'use strict';

(() => {
  if (globalThis.__chatgptNotifierRecoveryInstalled) return;
  globalThis.__chatgptNotifierRecoveryInstalled = true;

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

  function latestStatusSnapshot() {
    try {
      return globalThis.__chatgptNotifierStatusDom?.latestAssistantSnapshot?.() || null;
    } catch {
      return null;
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
    if (recoveryCompleted || recoverySignalInFlight || !snapshot?.statusCode) return;
    recoverySignalInFlight = true;
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'CHATGPT_RECOVERY_STATUS_READY',
        conversationUrl: location.href,
        assistantKey: snapshot.assistantKey,
        statusCode: snapshot.statusCode
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
    const snapshot = latestStatusSnapshot();
    if (snapshot?.statusCode) sendRecoveredCompletion(snapshot).catch(() => {});
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
      observer.observe(root, { childList: true, subtree: true, characterData: true });
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
    // Pre-typing can make ChatGPT visually replace the Stop affordance with a
    // send arrow. Never infer completion from this control, and do not treat a
    // click while a draft exists as cancellation of the in-flight response.
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
