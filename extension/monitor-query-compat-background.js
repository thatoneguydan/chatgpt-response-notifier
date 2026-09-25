'use strict';

(() => {
  if (globalThis.__chatgptNotifierMonitorQueryCompat) return;
  const originalSendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
  const MONITOR_QUERY = 'CHATGPT_MONITOR_QUERY';
  const HARD_DEADLINE_IDENTITY_BYPASS = 'hard-deadline-identity-bypass';

  function normalizeMonitorQueryResult(result) {
    if (!result?.snapshot || result.conversationId) return result;
    return { ...result.snapshot, ...result, snapshot: result.snapshot };
  }

  async function applyHardDeadlineIdentityBypass(result, now = Date.now()) {
    const snapshot = result?.snapshot && typeof result.snapshot === 'object'
      ? result.snapshot
      : result;
    if (!snapshot || snapshot.applicationStateIdentityMatched !== false) return result;

    const conversationId = String(snapshot.conversationId || result?.conversationId || '');
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    if (
      !conversationId
      || typeof monitor?.readCodeWatchdog !== 'function'
      || typeof monitor?.getEnrollment !== 'function'
    ) return result;

    let watchdog = null;
    let enrollment = null;
    try {
      [watchdog, enrollment] = await Promise.all([
        monitor.readCodeWatchdog(conversationId),
        monitor.getEnrollment(conversationId)
      ]);
    } catch {
      return result;
    }

    const deadlineAt = Math.max(0, Number(watchdog?.deadlineAt || 0));
    if (
      !watchdog
      || watchdog.stopped === true
      || deadlineAt <= 0
      || deadlineAt > Number(now)
      || enrollment?.enabled !== true
      || enrollment?.userPaused === true
    ) return result;

    // The 30-minute watchdog is a hard continuation deadline. Once it expires,
    // page-response identity lag must not turn that deadline into a wait state.
    // Keep the conversation binding, but intentionally clear the stale prompt
    // binding so the page-side watchdog targets the conversation's current turn.
    const adjusted = {
      ...snapshot,
      promptKey: '',
      applicationStateIdentityMatched: true,
      applicationStateReason: HARD_DEADLINE_IDENTITY_BYPASS
    };
    if (result?.snapshot && typeof result.snapshot === 'object') {
      return { ...result, ...adjusted, snapshot: adjusted };
    }
    return adjusted;
  }

  chrome.tabs.sendMessage = async function normalizedMonitorSendMessage(tabId, message, ...rest) {
    const rawResult = await originalSendMessage(tabId, message, ...rest);
    if (message?.type !== MONITOR_QUERY) return rawResult;
    const normalized = normalizeMonitorQueryResult(rawResult);
    return await applyHardDeadlineIdentityBypass(normalized);
  };

  globalThis.__chatgptNotifierMonitorQueryCompat = Object.freeze({
    version: 2,
    normalizeMonitorQueryResult,
    applyHardDeadlineIdentityBypass
  });
})();
