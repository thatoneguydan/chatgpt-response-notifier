'use strict';

(() => {
  if (globalThis.__chatgptNotifierWatchdogContinuationInvariant) return;

  const VERSION = 4;
  const CADENCE_SCHEMA_VERSION = 1;
  const DB_NAME = 'chatgpt-response-notifier-monitor';
  const DB_VERSION = 1;
  const ENROLLMENT_STORE = 'enrollments';
  const PROFILE_STORE = 'profile';
  const RECORD_PREFIX = 'code-watchdog:';
  const ALARM_PREFIX = 'chatgpt-notifier-code-watchdog:';
  const RETIRED_SHORT_RETRY_REASON = 'incomplete-awaiting-continuation';
  const WATCHDOG_DELAY_MS = 30 * 60_000;
  const WATCHDOG_AUTHORIZATION_MS = 10_000;
  const WATCHDOG_MAX_SENDS = 3;
  const shadow = new Map();

  const originalGet = IDBObjectStore.prototype.get;
  const originalPut = IDBObjectStore.prototype.put;

  let databasePromise = null;

  const clone = (value) => {
    if (!value || typeof value !== 'object') return value;
    try { return structuredClone(value); } catch { return { ...value }; }
  };
  const number = (value) => Math.max(0, Number(value || 0));
  const recordKey = (value) => String(value?.key || '');
  const isWatchdogKey = (value) => String(value || '').startsWith(RECORD_PREFIX);
  const conversationIdFromKey = (key) => String(key || '').slice(RECORD_PREFIX.length);
  const watchdogKey = (conversationId) => `${RECORD_PREFIX}${String(conversationId || '')}`;
  const alarmName = (conversationId) => `${ALARM_PREFIX}${encodeURIComponent(String(conversationId || ''))}`;

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open watchdog database.'));
      request.onblocked = () => reject(new Error('Watchdog database is blocked.'));
    });
    databasePromise.catch(() => { databasePromise = null; });
    return databasePromise;
  }

  function conversationFromUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''));
      if (!['chatgpt.com', 'www.chatgpt.com'].includes(url.hostname)) return '';
      const parts = url.pathname.split('/').filter(Boolean);
      for (let index = parts.length - 2; index >= 0; index -= 1) {
        if (parts[index] !== 'c') continue;
        return decodeURIComponent(parts[index + 1] || '').trim();
      }
    } catch {}
    return '';
  }

  function explicitOperatorReset(previous, next) {
    return number(next?.budgetResetAt) > number(previous?.budgetResetAt)
      || number(next?.operatorPromptArmedAt) > number(previous?.operatorPromptArmedAt)
      || number(next?.manualActivatedAt) > number(previous?.manualActivatedAt);
  }

  function incompleteBudgetReset(previous, next) {
    if (number(next?.resetAt) <= number(previous?.resetAt)) return false;
    try {
      return globalThis.ChatGPTNotifierContinuationPolicy?.isAutoContinueStatusCode?.(String(next?.lastStatusCode || '')) === true;
    } catch {
      return false;
    }
  }

  function cadenceBudgetReset(previous, next) {
    return explicitOperatorReset(previous, next) || incompleteBudgetReset(previous, next);
  }

  function terminalStatusCode(record) {
    if (record?.stopped !== true) return '';
    const reason = String(record?.stopReason || '');
    if (!reason.startsWith('status:')) return '';
    return reason.slice('status:'.length);
  }

  function terminalStoppedAt(record) {
    return number(record?.terminalStoppedAt) || number(record?.updatedAt);
  }

  function clearAlarmFor(record) {
    const conversationId = String(record?.conversationId || conversationIdFromKey(recordKey(record)));
    if (!conversationId) return;
    try {
      const result = chrome.alarms.clear(alarmName(conversationId));
      result?.catch?.(() => {});
    } catch {}
  }

  function migrationFloor(record, now = Date.now()) {
    if (!record || record.stopped === true) return 0;
    const lastAutomaticSentAt = number(record.lastAutomaticSentAt);
    const deadlineAt = number(record.deadlineAt);
    const retryAt = number(record.retryAt);
    if (lastAutomaticSentAt > 0) return Math.max(lastAutomaticSentAt + WATCHDOG_DELAY_MS, deadlineAt > now ? deadlineAt : 0);
    if (deadlineAt > now) return deadlineAt;
    if (deadlineAt > 0 || retryAt > 0) return now + WATCHDOG_DELAY_MS;
    return 0;
  }

  function migrateCadenceRecord(recordValue, now = Date.now()) {
    const record = clone(recordValue);
    if (!record || Number(record.cadenceSchemaVersion || 0) >= CADENCE_SCHEMA_VERSION) return record;
    const nextSendEligibleAt = migrationFloor(record, now);
    return {
      ...record,
      cadenceSchemaVersion: CADENCE_SCHEMA_VERSION,
      cadenceEpoch: Math.max(1, number(record.cadenceEpoch) || 1),
      cadenceSendCount: number(record.sendCount),
      cadenceAttempt: null,
      nextSendEligibleAt,
      cadenceMigratedAt: now,
      cadenceMigrationDisposition: record.stopped === true
        ? 'preserved-stopped'
        : nextSendEligibleAt > now
          ? (number(record.deadlineAt) > now ? 'preserved-future-deadline' : 'conservative-uncertain-floor')
          : 'no-send-authority'
    };
  }

  function applyTerminalInvariant(previous, next) {
    if (!next) return next;

    const nextCode = terminalStatusCode(next);
    if (nextCode) {
      const previousCode = terminalStatusCode(previous);
      const inheritedStopAt = previousCode === nextCode ? terminalStoppedAt(previous) : 0;
      next.terminalStoppedAt = number(next.terminalStoppedAt) || inheritedStopAt || Date.now();
      next.sendCount = 0;
      next.cadenceSendCount = 0;
      next.waitingForRequestStart = false;
      next.lastAutomaticSentAt = 0;
      next.lastAutomaticPromptKey = '';
      next.lastAutomaticParentPromptKey = '';
      next.deadlineAt = 0;
      next.retryAt = 0;
      next.retryReason = '';
      next.nextSendEligibleAt = 0;
      next.cadenceAttempt = null;
      next.cadenceEpoch = Math.max(1, number(previous?.cadenceEpoch), number(next.cadenceEpoch))
        + (previousCode === nextCode ? 0 : 1);
      clearAlarmFor(next);
      return next;
    }

    const previousCode = terminalStatusCode(previous);
    if (!previousCode) return next;
    if (explicitOperatorReset(previous, next)) {
      next.terminalStoppedAt = 0;
      next.cadenceEpoch = Math.max(1, number(previous?.cadenceEpoch), number(next.cadenceEpoch)) + 1;
      next.cadenceAttempt = null;
      return next;
    }

    next.stopped = true;
    next.stopReason = String(previous.stopReason || `status:${previousCode}`);
    next.lastStatusCode = String(previous.lastStatusCode || previousCode);
    next.terminalStoppedAt = terminalStoppedAt(previous) || Date.now();
    next.sendCount = 0;
    next.cadenceSendCount = 0;
    next.waitingForRequestStart = false;
    next.lastAutomaticSentAt = 0;
    next.lastAutomaticPromptKey = '';
    next.lastAutomaticParentPromptKey = '';
    next.deadlineAt = 0;
    next.retryAt = 0;
    next.retryReason = '';
    next.nextSendEligibleAt = 0;
    next.cadenceAttempt = null;
    next.cadenceEpoch = Math.max(1, number(previous.cadenceEpoch), number(next.cadenceEpoch));
    clearAlarmFor(next);
    return next;
  }

  function shouldPreserve(previous, next) {
    if (!previous || !next || next.stopped === true || explicitOperatorReset(previous, next)) return false;
    const autoStatus = globalThis.ChatGPTNotifierContinuationPolicy?.isAutoContinueStatusCode?.(next.lastStatusCode) === true;
    const automaticRequestStarted = previous.waitingForRequestStart === true && next.waitingForRequestStart !== true;
    return autoStatus || automaticRequestStarted;
  }

  function clearRetiredShortRetry(record) {
    if (!record || String(record.retryReason || '') !== RETIRED_SHORT_RETRY_REASON) return record;
    record.retryAt = 0;
    record.retryReason = '';
    return record;
  }

  function preserveContinuationState(previous, next) {
    clearRetiredShortRetry(next);
    if (!shouldPreserve(previous, next)) return next;

    next.sendCount = Math.max(number(next.sendCount), number(previous.sendCount));

    const deadlineAt = number(next.deadlineAt);
    const retryAt = number(next.retryAt);
    if (deadlineAt <= 0 && retryAt <= 0) {
      const previousDeadlineAt = number(previous.deadlineAt);
      const previousRetryAt = number(previous.retryAt);
      const previousRetryReason = String(previous.retryReason || '');
      if (previousDeadlineAt > 0) {
        next.deadlineAt = previousDeadlineAt;
      } else if (previousRetryAt > 0 && previousRetryReason !== RETIRED_SHORT_RETRY_REASON) {
        next.retryAt = previousRetryAt;
        next.retryReason = previousRetryReason;
      }
    }
    return next;
  }

  function applyCadenceInvariant(previousValue, nextValue, now = Date.now()) {
    let next = migrateCadenceRecord(nextValue, now);
    const previous = previousValue ? migrateCadenceRecord(previousValue, now) : null;
    if (!next) return next;

    if (next.stopped === true) {
      const stopChanged = previous?.stopped !== true || String(previous?.stopReason || '') !== String(next.stopReason || '');
      next.cadenceEpoch = Math.max(1, number(next.cadenceEpoch), number(previous?.cadenceEpoch)) + (stopChanged ? 1 : 0);
      next.sendCount = 0;
      next.cadenceSendCount = 0;
      next.cadenceAttempt = null;
      next.nextSendEligibleAt = 0;
      next.deadlineAt = 0;
      next.retryAt = 0;
      next.retryReason = '';
      return next;
    }

    if (cadenceBudgetReset(previous, next)) {
      next.cadenceSendCount = number(next.sendCount);
      next.cadenceEpoch = Math.max(1, number(previous?.cadenceEpoch), number(next.cadenceEpoch)) + 1;
      next.cadenceAttempt = null;
    } else {
      next.cadenceSendCount = Math.max(number(next.cadenceSendCount), number(previous?.cadenceSendCount));
      next.sendCount = Math.max(number(next.sendCount), number(next.cadenceSendCount));
      next.cadenceEpoch = Math.max(1, number(next.cadenceEpoch), number(previous?.cadenceEpoch));
      if (!next.cadenceAttempt && previous?.cadenceAttempt) next.cadenceAttempt = clone(previous.cadenceAttempt);
      next.nextSendEligibleAt = Math.max(number(next.nextSendEligibleAt), number(previous?.nextSendEligibleAt));
    }

    const floor = number(next.nextSendEligibleAt);
    if (floor > now) {
      if (number(next.deadlineAt) <= 0 || number(next.deadlineAt) < floor) next.deadlineAt = floor;
      if (number(next.retryAt) > 0 && number(next.retryAt) < floor) {
        next.retryAt = 0;
        next.retryReason = '';
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

    let next = clone(value);
    const storageKey = recordKey(next);
    const previous = shadow.get(storageKey) || null;
    applyTerminalInvariant(previous, next);
    preserveContinuationState(previous, next);
    next = applyCadenceInvariant(previous, next);
    shadow.set(storageKey, clone(next));
    return arguments.length > 1 ? originalPut.call(this, next, key) : originalPut.call(this, next);
  };

  async function readWatchdog(conversationId) {
    if (!conversationId) return null;
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(PROFILE_STORE, 'readonly');
      const request = transaction.objectStore(PROFILE_STORE).get(watchdogKey(conversationId));
      request.onsuccess = () => resolve(clone(request.result) || null);
      request.onerror = () => reject(request.error || new Error('Could not read watchdog cadence state.'));
    });
  }

  function authorizePageDispatch(message, sender) {
    const conversationId = String(message?.conversationId || '');
    const promptKey = String(message?.promptKey || '');
    const documentId = String(message?.documentId || '');
    const tabId = Number(sender?.tab?.id);
    const senderConversationId = conversationFromUrl(sender?.tab?.url || '');
    if (!conversationId || !promptKey || !documentId || !Number.isInteger(tabId)) {
      return Promise.resolve({ ok: false, granted: false, reason: 'cadence-target-incomplete' });
    }
    if (senderConversationId && senderConversationId !== conversationId) {
      return Promise.resolve({ ok: false, granted: false, reason: 'cadence-conversation-changed' });
    }

    const now = Date.now();
    const attemptId = (() => { try { return crypto.randomUUID(); } catch { return `${now}-${Math.random()}`; } })();
    const authorizationExpiresAt = now + WATCHDOG_AUTHORIZATION_MS;
    const conservativeFloor = authorizationExpiresAt + WATCHDOG_DELAY_MS;

    return openDatabase().then((database) => new Promise((resolve, reject) => {
      let outcome = { ok: false, granted: false, reason: 'cadence-transaction-incomplete' };
      const transaction = database.transaction([PROFILE_STORE, ENROLLMENT_STORE], 'readwrite');
      const profile = transaction.objectStore(PROFILE_STORE);
      const enrollments = transaction.objectStore(ENROLLMENT_STORE);
      const watchdogRequest = profile.get(watchdogKey(conversationId));

      watchdogRequest.onerror = () => {
        outcome = { ok: false, granted: false, reason: 'cadence-watchdog-read-failed' };
      };
      watchdogRequest.onsuccess = () => {
        let current = migrateCadenceRecord(watchdogRequest.result || null, now);
        if (!current) {
          outcome = { ok: false, granted: false, reason: 'cadence-watchdog-missing' };
          return;
        }

        const enrollmentRequest = enrollments.get(conversationId);
        enrollmentRequest.onerror = () => {
          outcome = { ok: false, granted: false, reason: 'cadence-enrollment-read-failed' };
        };
        enrollmentRequest.onsuccess = () => {
          const enrollment = enrollmentRequest.result || null;
          const persistAndReturn = (next, response) => {
            profile.put(next);
            outcome = response;
          };

          if (enrollment?.enabled !== true || enrollment?.userPaused === true) {
            persistAndReturn(current, { ok: false, granted: false, reason: 'cadence-automation-inactive' });
            return;
          }
          if (current.stopped === true) {
            persistAndReturn(current, { ok: false, granted: false, reason: 'cadence-watchdog-stopped' });
            return;
          }

          const floor = number(current.nextSendEligibleAt);
          const attempt = current.cadenceAttempt || null;
          const syntheticSuccess = Boolean(attempt?.attemptId && number(current.cadenceSendCount) > 0 && floor > now);
          if (floor > now) {
            persistAndReturn(current, {
              ok: true,
              granted: false,
              syntheticSuccess,
              reason: attempt?.attemptId ? 'cadence-attempt-already-consumed' : 'cadence-floor-active',
              attemptId: String(attempt?.attemptId || ''),
              nextSendEligibleAt: floor
            });
            return;
          }

          const deadlineAt = number(current.deadlineAt);
          if (deadlineAt <= 0 || deadlineAt > now) {
            persistAndReturn(current, {
              ok: false,
              granted: false,
              reason: deadlineAt > now ? 'cadence-deadline-not-due' : 'cadence-no-positive-deadline',
              nextSendEligibleAt: Math.max(deadlineAt, floor)
            });
            return;
          }
          if (Number.isInteger(current.ownerTabId) && Number(current.ownerTabId) !== tabId) {
            persistAndReturn(current, { ok: false, granted: false, reason: 'cadence-owner-tab-changed' });
            return;
          }
          if (String(current.lastPromptKey || '') && String(current.lastPromptKey) !== promptKey) {
            persistAndReturn(current, { ok: false, granted: false, reason: 'cadence-prompt-changed' });
            return;
          }

          const consumed = Math.max(number(current.sendCount), number(current.cadenceSendCount));
          if (consumed >= WATCHDOG_MAX_SENDS) {
            const stopped = applyCadenceInvariant(current, {
              ...current,
              stopped: true,
              stopReason: 'retry-cap-reached',
              sendCount: consumed,
              cadenceSendCount: consumed,
              deadlineAt: 0,
              retryAt: 0,
              retryReason: ''
            }, now);
            persistAndReturn(stopped, { ok: false, granted: false, reason: 'cadence-retry-cap-reached' });
            return;
          }

          const epoch = Math.max(1, number(current.cadenceEpoch));
          const nextCount = consumed + 1;
          const next = applyCadenceInvariant(current, {
            ...current,
            cadenceSchemaVersion: CADENCE_SCHEMA_VERSION,
            cadenceEpoch: epoch,
            cadenceSendCount: nextCount,
            sendCount: nextCount,
            lastAutomaticSentAt: Math.max(number(current.lastAutomaticSentAt), now),
            lastAutomaticParentPromptKey: promptKey,
            waitingForRequestStart: false,
            nextSendEligibleAt: conservativeFloor,
            deadlineAt: conservativeFloor,
            retryAt: 0,
            retryReason: '',
            cadenceAttempt: {
              attemptId,
              epoch,
              tabId,
              documentId,
              promptKey,
              reservedAt: now,
              authorizationExpiresAt,
              outcome: 'reserved',
              nextSendEligibleAt: conservativeFloor
            },
            cadenceLastReservationAt: now
          }, now);
          persistAndReturn(next, {
            ok: true,
            granted: true,
            attemptId,
            epoch,
            authorizationExpiresAt,
            nextSendEligibleAt: conservativeFloor,
            sendCount: nextCount
          });
        };
      };

      transaction.oncomplete = () => {
        if (outcome?.granted === true && number(outcome.nextSendEligibleAt) > 0) {
          try { chrome.alarms.create(alarmName(conversationId), { when: number(outcome.nextSendEligibleAt) }); } catch {}
        }
        resolve(clone(outcome));
      };
      transaction.onerror = () => reject(transaction.error || new Error('Watchdog cadence authorization failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Watchdog cadence authorization was aborted.'));
    })).catch((error) => ({ ok: false, granted: false, reason: 'cadence-authorization-error', error: String(error?.message || error) }));
  }

  function finalizePageDispatch(message, sender) {
    const conversationId = String(message?.conversationId || '');
    const attemptId = String(message?.attemptId || '');
    const documentId = String(message?.documentId || '');
    const promptKey = String(message?.promptKey || '');
    const tabId = Number(sender?.tab?.id);
    if (!conversationId || !attemptId || !documentId || !promptKey || !Number.isInteger(tabId)) {
      return Promise.resolve({ ok: false, finalized: false, reason: 'cadence-finalize-target-incomplete' });
    }

    const now = Date.now();
    return openDatabase().then((database) => new Promise((resolve, reject) => {
      let outcome = { ok: false, finalized: false, reason: 'cadence-finalize-incomplete' };
      let wakeAt = 0;
      const transaction = database.transaction(PROFILE_STORE, 'readwrite');
      const profile = transaction.objectStore(PROFILE_STORE);
      const request = profile.get(watchdogKey(conversationId));
      request.onerror = () => {
        outcome = { ok: false, finalized: false, reason: 'cadence-finalize-read-failed' };
      };
      request.onsuccess = () => {
        const current = migrateCadenceRecord(request.result || null, now);
        const attempt = current?.cadenceAttempt || null;
        if (!current || !attempt || String(attempt.attemptId || '') !== attemptId) {
          outcome = { ok: false, finalized: false, reason: 'cadence-attempt-superseded' };
          return;
        }
        if (number(attempt.epoch) !== number(current.cadenceEpoch)
          || Number(attempt.tabId) !== tabId
          || String(attempt.documentId || '') !== documentId
          || String(attempt.promptKey || '') !== promptKey) {
          outcome = { ok: false, finalized: false, reason: 'cadence-attempt-identity-changed' };
          return;
        }
        if (current.stopped === true) {
          outcome = { ok: false, finalized: false, reason: 'cadence-watchdog-stopped' };
          return;
        }

        const clicked = message?.clicked === true;
        const reportedClickedAt = number(message?.clickedAt);
        const validClickedAt = clicked
          && reportedClickedAt >= number(attempt.reservedAt)
          && reportedClickedAt <= number(attempt.authorizationExpiresAt)
          && reportedClickedAt <= now + 1000;
        const confirmed = clicked && message?.ok === true && validClickedAt;
        const finalFloor = confirmed
          ? reportedClickedAt + WATCHDOG_DELAY_MS
          : Math.max(number(attempt.nextSendEligibleAt), number(attempt.authorizationExpiresAt) + WATCHDOG_DELAY_MS);
        const outcomeName = clicked ? (confirmed ? 'confirmed' : 'unknown') : 'definitively-not-clicked';
        const next = applyCadenceInvariant(current, {
          ...current,
          lastAutomaticSentAt: validClickedAt
            ? Math.max(number(current.lastAutomaticSentAt), reportedClickedAt)
            : number(current.lastAutomaticSentAt),
          lastAutomaticPromptKey: String(message?.continuationUserKey || current.lastAutomaticPromptKey || ''),
          lastAutomaticParentPromptKey: promptKey,
          nextSendEligibleAt: finalFloor,
          deadlineAt: finalFloor,
          retryAt: 0,
          retryReason: '',
          cadenceAttempt: {
            ...attempt,
            outcome: outcomeName,
            clickedAt: validClickedAt ? reportedClickedAt : 0,
            finalizedAt: now,
            nextSendEligibleAt: finalFloor,
            pageReason: String(message?.reason || '').slice(0, 96)
          },
          cadenceLastOutcome: outcomeName,
          cadenceLastFinalizedAt: now
        }, now);
        profile.put(next);
        wakeAt = finalFloor;
        outcome = {
          ok: true,
          finalized: true,
          outcome: outcomeName,
          nextSendEligibleAt: finalFloor,
          sendCount: number(next.cadenceSendCount)
        };
      };
      transaction.oncomplete = () => {
        if (wakeAt > 0) {
          try { chrome.alarms.create(alarmName(conversationId), { when: wakeAt }); } catch {}
        }
        resolve(clone(outcome));
      };
      transaction.onerror = () => reject(transaction.error || new Error('Watchdog cadence finalization failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Watchdog cadence finalization was aborted.'));
    })).catch((error) => ({ ok: false, finalized: false, reason: 'cadence-finalize-error', error: String(error?.message || error) }));
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'AUTHORIZE_WATCHDOG_DISPATCH_V1') {
      authorizePageDispatch(message, sender).then((result) => sendResponse?.(result));
      return true;
    }
    if (message?.type === 'FINALIZE_WATCHDOG_DISPATCH_V1') {
      finalizePageDispatch(message, sender).then((result) => sendResponse?.(result));
      return true;
    }
    if (message?.type === 'WATCHDOG_CADENCE_OWNER_PING') {
      sendResponse?.({ ok: true, version: VERSION, cadenceSchemaVersion: CADENCE_SCHEMA_VERSION });
      return false;
    }
    return false;
  });

  globalThis.__chatgptNotifierWatchdogContinuationInvariant = Object.freeze({
    version: VERSION,
    cadenceSchemaVersion: CADENCE_SCHEMA_VERSION,
    applyTerminalInvariant,
    preserveContinuationState,
    applyCadenceInvariant,
    migrateCadenceRecord,
    shouldPreserve,
    terminalStatusCode,
    authorizePageDispatch,
    finalizePageDispatch,
    readWatchdog
  });
})();
