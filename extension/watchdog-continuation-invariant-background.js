'use strict';

(() => {
  if (globalThis.__chatgptNotifierWatchdogContinuationInvariant) return;

  const VERSION = 1;
  const PROFILE_STORE = 'profile';
  const RECORD_PREFIX = 'code-watchdog:';
  const ALARM_PREFIX = 'chatgpt-notifier-code-watchdog:';
  const FALLBACK_RETRY_MS = 60_000;
  const shadow = new Map();

  const originalGet = IDBObjectStore.prototype.get;
  const originalPut = IDBObjectStore.prototype.put;

  const clone = (value) => {
    if (!value || typeof value !== 'object') return value;
    try { return structuredClone(value); } catch { return { ...value }; }
  };

  const recordKey = (value) => String(value?.key || '');
  const isWatchdogKey = (value) => String(value || '').startsWith(RECORD_PREFIX);
  const conversationIdFromKey = (key) => String(key || '').slice(RECORD_PREFIX.length);
  const alarmName = (conversationId) => `${ALARM_PREFIX}${encodeURIComponent(String(conversationId || ''))}`;
  const number = (value) => Math.max(0, Number(value || 0));

  function explicitOperatorReset(previous, next) {
    return number(next?.budgetResetAt) > number(previous?.budgetResetAt)
      || number(next?.operatorPromptArmedAt) > number(previous?.operatorPromptArmedAt)
      || number(next?.manualActivatedAt) > number(previous?.manualActivatedAt);
  }

  function shouldPreserve(previous, next) {
    if (!previous || !next || next.stopped === true || explicitOperatorReset(previous, next)) return false;
    const autoStatus = globalThis.ChatGPTNotifierContinuationPolicy?.isAutoContinueStatusCode?.(next.lastStatusCode) === true;
    const automaticRequestStarted = previous.waitingForRequestStart === true && next.waitingForRequestStart !== true;
    return autoStatus || automaticRequestStarted;
  }

  function preserveContinuationState(previous, next) {
    if (!shouldPreserve(previous, next)) return next;

    next.sendCount = Math.max(number(next.sendCount), number(previous.sendCount));

    let deadlineAt = number(next.deadlineAt);
    let retryAt = number(next.retryAt);
    if (deadlineAt <= 0 && retryAt <= 0) {
      const previousDeadlineAt = number(previous.deadlineAt);
      const previousRetryAt = number(previous.retryAt);
      if (previousDeadlineAt > 0) {
        deadlineAt = previousDeadlineAt;
        next.deadlineAt = previousDeadlineAt;
      } else if (previousRetryAt > 0) {
        retryAt = previousRetryAt;
        next.retryAt = previousRetryAt;
        next.retryReason = String(previous.retryReason || '');
      } else {
        retryAt = Date.now() + FALLBACK_RETRY_MS;
        next.retryAt = retryAt;
        next.retryReason = 'incomplete-awaiting-continuation';
      }
    }

    const when = deadlineAt > 0 ? deadlineAt : retryAt;
    if (when > 0) {
      const conversationId = String(next.conversationId || conversationIdFromKey(recordKey(next)));
      if (conversationId) {
        try { chrome.alarms.create(alarmName(conversationId), { when: Math.max(Date.now() + 1000, when) }); } catch {}
      }
    }
    return next;
  }

  IDBObjectStore.prototype.get = function watchdogInvariantGet(key) {
    const request = originalGet.call(this, key);
    if (String(this?.name || '') === PROFILE_STORE && isWatchdogKey(key)) {
      try {
        request.addEventListener('success', () => {
          const result = clone(request.result);
          if (result) shadow.set(String(key), result);
        }, { once: true });
      } catch {}
    }
    return request;
  };

  IDBObjectStore.prototype.put = function watchdogInvariantPut(value, key) {
    if (String(this?.name || '') !== PROFILE_STORE || !isWatchdogKey(recordKey(value))) {
      return arguments.length > 1 ? originalPut.call(this, value, key) : originalPut.call(this, value);
    }

    const next = clone(value);
    const storageKey = recordKey(next);
    const previous = shadow.get(storageKey) || null;
    preserveContinuationState(previous, next);
    shadow.set(storageKey, clone(next));
    return arguments.length > 1 ? originalPut.call(this, next, key) : originalPut.call(this, next);
  };

  globalThis.__chatgptNotifierWatchdogContinuationInvariant = Object.freeze({
    version: VERSION,
    preserveContinuationState,
    shouldPreserve
  });
})();
