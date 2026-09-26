'use strict';

(() => {
  if (globalThis.__chatgptNotifierWatchdogSoleContinuationAuthority) return;

  const VERSION = 1;
  const DB_NAME = 'chatgpt-response-notifier-monitor';
  const DB_VERSION = 1;
  const PROFILE_STORE = 'profile';
  const RECORD_PREFIX = 'code-watchdog:';
  const ALARM_PREFIX = 'chatgpt-notifier-code-watchdog:';
  const WATCHDOG_DELAY_MS = 30 * 60_000;
  const RETIRED_SHORT_RETRY_REASON = 'incomplete-awaiting-continuation';

  const originalHandleContinuationClaim = globalThis.handleContinuationClaim;

  function alarmName(conversationId) {
    return `${ALARM_PREFIX}${encodeURIComponent(String(conversationId || ''))}`;
  }

  function requestResult(request, errorMessage) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(errorMessage));
    });
  }

  async function openDatabase() {
    return await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open watchdog database.'));
      request.onblocked = () => reject(new Error('Watchdog database is blocked.'));
    });
  }

  async function writeRecord(database, record) {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(PROFILE_STORE, 'readwrite');
      transaction.objectStore(PROFILE_STORE).put(record);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not migrate watchdog state.'));
      transaction.onabort = () => reject(transaction.error || new Error('Watchdog migration was aborted.'));
    });
  }

  async function retireShortCadenceState(now = Date.now()) {
    let database = null;
    try { database = await openDatabase(); } catch { return 0; }

    let records = [];
    try {
      const transaction = database.transaction(PROFILE_STORE, 'readonly');
      records = await requestResult(transaction.objectStore(PROFILE_STORE).getAll(), 'Could not read watchdog records.');
    } catch {
      try { database.close(); } catch {}
      return 0;
    }

    let migrated = 0;
    for (const current of records) {
      if (!String(current?.key || '').startsWith(RECORD_PREFIX)) continue;
      if (String(current?.retryReason || '') !== RETIRED_SHORT_RETRY_REASON) continue;

      const conversationId = String(current?.conversationId || String(current.key).slice(RECORD_PREFIX.length));
      if (!conversationId) continue;
      try { await chrome.alarms.clear(alarmName(conversationId)); } catch {}

      const lastAutomaticSentAt = Math.max(0, Number(current?.lastAutomaticSentAt || 0));
      const existingDeadlineAt = Math.max(0, Number(current?.deadlineAt || 0));
      const restoredDeadlineAt = existingDeadlineAt > 0
        ? existingDeadlineAt
        : (lastAutomaticSentAt > 0 ? lastAutomaticSentAt + WATCHDOG_DELAY_MS : 0);
      const next = {
        ...current,
        deadlineAt: restoredDeadlineAt,
        retryAt: 0,
        retryReason: '',
        retiredShortCadenceAt: now
      };
      try {
        await writeRecord(database, next);
        migrated += 1;
      } catch {
        continue;
      }

      if (next.stopped !== true && restoredDeadlineAt > 0) {
        try {
          chrome.alarms.create(alarmName(conversationId), {
            when: Math.max(now + 1000, restoredDeadlineAt)
          });
        } catch {}
      }
    }

    try { database.close(); } catch {}
    return migrated;
  }

  // Legacy coded-completion and observation paths used this primitive to send
  // Continue immediately. Automatic Continue now has exactly one send primitive:
  // CHATGPT_WATCHDOG_CONTINUE_COMMAND from monitor-background's watchdog alarm.
  if (typeof globalThis.requestContinuation === 'function') {
    globalThis.requestContinuation = async function watchdogOnlyContinuationAuthority() {
      return {
        ok: false,
        clicked: false,
        reason: 'watchdog-only-continuation-authority'
      };
    };
  }

  // Both legacy coded-completion paths converge here before their old send.
  // Resolve those claims without sending or notifying; the watchdog retains the
  // timer and decides when the next automatic Continue is actually due.
  if (typeof originalHandleContinuationClaim === 'function') {
    globalThis.handleContinuationClaim = async function watchdogOwnedContinuationClaim(record, status, tabId, senderDocumentId) {
      const statusCode = String(status?.statusCode || record?.statusCode || '');
      const autoContinue = globalThis.ChatGPTNotifierContinuationPolicy?.isAutoContinueStatusCode?.(statusCode) === true;
      if (!autoContinue) {
        return await originalHandleContinuationClaim(record, status, tabId, senderDocumentId);
      }

      try {
        const state = typeof globalThis.coordinator === 'function' ? globalThis.coordinator() : null;
        if (record?.turnKey && state?.updateTurn) {
          await state.updateTurn(record.turnKey, {
            state: 'superseded',
            actionReason: 'watchdog-owned-continuation'
          });
        }
      } catch {}
      return null;
    };
  }

  retireShortCadenceState().catch(() => {});

  globalThis.__chatgptNotifierWatchdogSoleContinuationAuthority = Object.freeze({
    version: VERSION,
    retireShortCadenceState
  });
})();
