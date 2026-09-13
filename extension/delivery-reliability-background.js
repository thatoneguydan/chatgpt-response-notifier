'use strict';

(() => {
  if (globalThis.__chatgptNotifierDeliveryReliability) return;

  const DB_NAME = 'chatgpt-response-notifier-delivery-reliability';
  const DB_VERSION = 1;
  const OBSERVATION_STORE = 'terminal-observations';
  const OBSERVATION_ALARM = 'chatgpt-notifier-terminal-observation-retry';
  const OUTBOX_ALARM = 'chatgpt-notifier-outbox-retry';
  const MAX_OBSERVATION_ATTEMPTS = 4;
  const OBSERVATION_RETRY_BASE_MS = 750;
  const OUTBOX_RETRY_BASE_MS = 1500;
  const OUTBOX_RETRY_MAX_MS = 30_000;
  const MAX_OUTBOX_ALARM_FAILURES = 6;

  let databasePromise = null;
  let extensionVersion = '';
  let outboxDrainPromise = null;
  let outboxWakeRequested = false;
  let outboxFailureCount = 0;

  try { extensionVersion = String(chrome.runtime.getManifest().version || ''); } catch {}

  function suffix(value) {
    const text = String(value || '').trim();
    return text.length <= 8 ? text : text.slice(-8);
  }

  function safeReason(value) {
    return String(value || '').replace(/[\r\n\t]+/g, ' ').slice(0, 160);
  }

  function record(status, fields = {}) {
    const diagnostic = {
      source: 'delivery-pipeline',
      status: String(status || 'unknown'),
      observedAt: new Date().toISOString(),
      extensionVersion,
      correlationId: fields.correlationId ? String(fields.correlationId).slice(0, 80) : undefined,
      tabId: Number.isInteger(fields.tabId) ? fields.tabId : undefined,
      attempt: Number.isInteger(fields.attempt) ? fields.attempt : undefined,
      reason: fields.reason ? safeReason(fields.reason) : undefined,
      conversationSuffix: suffix(fields.conversationId),
      notificationSuffix: suffix(fields.notificationId),
      chromeDocumentSuffix: suffix(fields.chromeDocumentId),
      statusRuntimeSuffix: suffix(fields.statusRuntimeId),
      monitorRuntimeSuffix: suffix(fields.monitorRuntimeId),
      presentationState: fields.presentationState ? String(fields.presentationState).slice(0, 48) : undefined,
      presented: typeof fields.presented === 'boolean' ? fields.presented : undefined
    };
    try {
      if (typeof sendNative === 'function') sendNative({ type: 'diagnostics.event', diagnostic });
    } catch {}
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(OBSERVATION_STORE)) {
          database.createObjectStore(OBSERVATION_STORE, { keyPath: 'observationKey' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open delivery reliability database.'));
      request.onblocked = () => reject(new Error('Delivery reliability database upgrade was blocked.'));
    });
    databasePromise.catch(() => { databasePromise = null; });
    return databasePromise;
  }

  function requestResult(request, message) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(message));
    });
  }

  function clone(value) {
    return value ? structuredClone(value) : value;
  }

  function observationKey(expected) {
    const tabId = Number.isInteger(expected?.tabId) ? expected.tabId : '';
    const chromeDocumentId = String(expected?.chromeDocumentId || '');
    const conversationId = String(expected?.conversationId || '');
    const promptKey = String(expected?.promptKey || '');
    const assistantKey = String(expected?.assistantKey || '');
    const revision = String(expected?.assistantRevision || '');
    const statusCode = String(expected?.statusCode || '');
    if (tabId === '' || !chromeDocumentId || !conversationId || !promptKey || !assistantKey || !revision || !statusCode) return '';
    return [tabId, chromeDocumentId, conversationId, promptKey, assistantKey, revision, statusCode].join('|');
  }

  async function enqueueObservation(expected) {
    const key = observationKey(expected);
    if (!key) return null;
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(OBSERVATION_STORE, 'readwrite');
      const store = transaction.objectStore(OBSERVATION_STORE);
      const request = store.get(key);
      let result = null;

      request.onsuccess = () => {
        const existing = request.result || null;
        if (existing) {
          result = existing;
          return;
        }
        const now = Date.now();
        result = {
          observationKey: key,
          correlationId: crypto.randomUUID(),
          tabId: expected.tabId,
          chromeDocumentId: String(expected.chromeDocumentId || ''),
          monitorRuntimeId: String(expected.monitorRuntimeId || ''),
          statusRuntimeId: '',
          conversationId: String(expected.conversationId || ''),
          conversationUrl: String(expected.conversationUrl || ''),
          promptKey: String(expected.promptKey || ''),
          promptRevision: String(expected.promptRevision || ''),
          assistantKey: String(expected.assistantKey || ''),
          assistantRevision: String(expected.assistantRevision || ''),
          statusCode: String(expected.statusCode || ''),
          state: 'pending',
          attempts: 0,
          reason: '',
          nextAttemptAt: now,
          createdAt: now,
          updatedAt: now
        };
        store.add(result);
      };
      request.onerror = () => reject(request.error || new Error('Could not inspect terminal observation state.'));
      transaction.oncomplete = () => resolve(clone(result));
      transaction.onerror = () => reject(transaction.error || new Error('Terminal observation enqueue failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Terminal observation enqueue was aborted.'));
    });
  }

  async function getObservation(key) {
    if (!key) return null;
    const database = await openDatabase();
    const transaction = database.transaction(OBSERVATION_STORE, 'readonly');
    return clone(await requestResult(transaction.objectStore(OBSERVATION_STORE).get(key), 'Could not read terminal observation.')) || null;
  }

  async function listPendingObservations(tabId = null) {
    const database = await openDatabase();
    const transaction = database.transaction(OBSERVATION_STORE, 'readonly');
    const all = await requestResult(transaction.objectStore(OBSERVATION_STORE).getAll(), 'Could not list terminal observations.');
    return (Array.isArray(all) ? all : [])
      .filter((item) => ['pending', 'in-flight'].includes(String(item?.state || '')))
      .filter((item) => !Number.isInteger(tabId) || item?.tabId === tabId)
      .sort((left, right) => Number(left?.createdAt || 0) - Number(right?.createdAt || 0))
      .map(clone);
  }

  async function updateObservation(key, patch) {
    if (!key) return null;
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(OBSERVATION_STORE, 'readwrite');
      const store = transaction.objectStore(OBSERVATION_STORE);
      const request = store.get(key);
      let updated = null;

      request.onsuccess = () => {
        const current = request.result;
        if (!current) return;
        updated = {
          ...current,
          ...(patch && typeof patch === 'object' ? patch : {}),
          observationKey: key,
          updatedAt: Date.now()
        };
        store.put(updated);
      };
      request.onerror = () => reject(request.error || new Error('Could not read terminal observation for update.'));
      transaction.oncomplete = () => resolve(clone(updated));
      transaction.onerror = () => reject(transaction.error || new Error('Terminal observation update failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Terminal observation update was aborted.'));
    });
  }

  async function noteObservationAttempt(key) {
    const current = await getObservation(key);
    if (!current || !['pending', 'in-flight'].includes(String(current.state || ''))) return current;
    const attempts = Number(current.attempts || 0) + 1;
    const updated = await updateObservation(key, { state: 'in-flight', attempts, reason: '' });
    if (updated) {
      record('observation-attempt', {
        correlationId: updated.correlationId,
        tabId: updated.tabId,
        attempt: attempts,
        conversationId: updated.conversationId,
        chromeDocumentId: updated.chromeDocumentId,
        monitorRuntimeId: updated.monitorRuntimeId
      });
    }
    return updated;
  }

  async function resolveObservation(key, reason, fields = {}) {
    const existing = await getObservation(key);
    if (!existing) return null;
    const current = await updateObservation(key, {
      state: 'resolved',
      reason: safeReason(reason),
      statusRuntimeId: String(fields.statusRuntimeId || existing.statusRuntimeId || '')
    });
    if (current) {
      record('observation-resolved', {
        correlationId: current.correlationId,
        tabId: current.tabId,
        attempt: Number(current.attempts || 0),
        reason,
        conversationId: current.conversationId,
        chromeDocumentId: current.chromeDocumentId,
        statusRuntimeId: current.statusRuntimeId,
        monitorRuntimeId: current.monitorRuntimeId
      });
    }
    return current;
  }

  function observationRetryDelay(attempts) {
    return Math.min(12_000, OBSERVATION_RETRY_BASE_MS * (2 ** Math.max(0, Number(attempts || 1) - 1)));
  }

  async function scheduleObservationAlarm() {
    const pending = await listPendingObservations();
    if (!pending.length) {
      try { await chrome.alarms.clear(OBSERVATION_ALARM); } catch {}
      return;
    }
    const next = Math.min(...pending.map((item) => Number(item.nextAttemptAt || Date.now())));
    try { chrome.alarms.create(OBSERVATION_ALARM, { when: Math.max(Date.now() + 250, next) }); } catch {}
  }

  async function deferObservation(key, reason, fields = {}) {
    const current = await getObservation(key);
    if (!current) return null;
    const attempts = Number(current.attempts || 0);
    if (attempts >= MAX_OBSERVATION_ATTEMPTS) {
      const attention = await updateObservation(key, {
        state: 'attention',
        reason: safeReason(reason),
        statusRuntimeId: String(fields.statusRuntimeId || current.statusRuntimeId || '')
      });
      record('observation-attention', {
        correlationId: current.correlationId,
        tabId: current.tabId,
        attempt: attempts,
        reason,
        conversationId: current.conversationId,
        chromeDocumentId: current.chromeDocumentId,
        statusRuntimeId: fields.statusRuntimeId || current.statusRuntimeId,
        monitorRuntimeId: current.monitorRuntimeId
      });
      return attention;
    }

    const delay = observationRetryDelay(attempts);
    const updated = await updateObservation(key, {
      state: 'pending',
      reason: safeReason(reason),
      statusRuntimeId: String(fields.statusRuntimeId || current.statusRuntimeId || ''),
      nextAttemptAt: Date.now() + delay
    });
    record('observation-retry-scheduled', {
      correlationId: current.correlationId,
      tabId: current.tabId,
      attempt: attempts,
      reason,
      conversationId: current.conversationId,
      chromeDocumentId: current.chromeDocumentId,
      statusRuntimeId: fields.statusRuntimeId || current.statusRuntimeId,
      monitorRuntimeId: current.monitorRuntimeId
    });
    await scheduleObservationAlarm();
    return updated;
  }

  function recordEvent(status, notification, fields = {}) {
    record(status, {
      ...fields,
      conversationId: notification?.conversationId,
      notificationId: notification?.id
    });
  }

  async function drainOutboxPass() {
    const state = typeof coordinator === 'function' ? coordinator() : null;
    if (!state) return { blocked: true, reason: 'coordinator-unavailable' };
    const records = await state.listOutbox();
    if (!records.length) return { blocked: false, pending: false };

    for (const outboxRecord of records) {
      if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) {
        return { blocked: true, reason: 'helper-disconnected' };
      }

      const notification = outboxRecord?.notification;
      if (!notification?.id) continue;
      const attemptRecord = await state.noteOutboxAttempt(notification.id);
      const attempt = Number(attemptRecord?.attempts || outboxRecord?.attempts || 0);
      let turn = null;
      try { turn = outboxRecord?.turnKey ? await state.getTurn?.(outboxRecord.turnKey) : null; } catch {}
      const correlationId = String(turn?.deliveryCorrelationId || `notification-${suffix(notification.id)}`);

      recordEvent('outbox-send-attempt', notification, { correlationId, attempt });
      const response = await sendNativeRequest(
        { type: 'toast.show', notification },
        ['toast.accepted'],
        5000,
        { queueIfDisconnected: false }
      );
      if (!response || response.accepted !== true || String(response.notificationId || '') !== String(notification.id)) {
        recordEvent('helper-ack-missing', notification, {
          correlationId,
          attempt,
          reason: response ? 'mismatched-or-rejected-ack' : 'ack-timeout-or-disconnect'
        });
        return { blocked: true, reason: response ? 'helper-ack-rejected' : 'helper-ack-missing' };
      }

      await state.acknowledgeNotification(notification.id);
      recordEvent('helper-durable-accepted', notification, {
        correlationId,
        attempt,
        presented: response.presented === true,
        presentationState: response.presentationState || ''
      });
    }

    const remaining = await state.listOutbox();
    return { blocked: false, pending: remaining.length > 0 };
  }

  async function clearOutboxAlarm() {
    try { await chrome.alarms.clear(OUTBOX_ALARM); } catch {}
  }

  function scheduleOutboxRetry(reason) {
    outboxFailureCount += 1;
    if (outboxFailureCount > MAX_OUTBOX_ALARM_FAILURES) {
      clearOutboxAlarm().catch(() => {});
      if (outboxFailureCount === MAX_OUTBOX_ALARM_FAILURES + 1) {
        record('outbox-attention', {
          attempt: outboxFailureCount,
          reason: `${safeReason(reason)}; durable entries retained until an explicit wake/reconnect/restart`
        });
      }
      return;
    }

    const delay = Math.min(
      OUTBOX_RETRY_MAX_MS,
      OUTBOX_RETRY_BASE_MS * (2 ** Math.min(5, outboxFailureCount - 1))
    );
    try { chrome.alarms.create(OUTBOX_ALARM, { when: Date.now() + delay }); } catch {}
    record('outbox-retry-scheduled', { attempt: outboxFailureCount, reason });
  }

  async function wakeSafeFlushNotificationOutbox() {
    outboxWakeRequested = true;
    if (outboxDrainPromise) return await outboxDrainPromise;

    outboxDrainPromise = (async () => {
      while (outboxWakeRequested) {
        outboxWakeRequested = false;
        let outcome;
        try {
          outcome = await drainOutboxPass();
        } catch (error) {
          outcome = { blocked: true, reason: `drain-error:${safeReason(error?.message || error)}` };
        }

        if (outcome?.blocked) {
          scheduleOutboxRetry(outcome.reason || 'delivery-blocked');
          break;
        }

        outboxFailureCount = 0;
        await clearOutboxAlarm();
        if (outcome?.pending) outboxWakeRequested = true;
      }
    })().finally(() => {
      outboxDrainPromise = null;
      if (outboxWakeRequested) {
        queueMicrotask(() => wakeSafeFlushNotificationOutbox()
          .catch((error) => console.warn('Deferred outbox drain failed', error)));
      }
    });

    return await outboxDrainPromise;
  }

  const baseCoordinator = globalThis.__chatgptNotifierCoordinator;
  if (baseCoordinator?.listUnresolvedTurns) {
    globalThis.__chatgptNotifierCoordinator = Object.freeze({
      ...baseCoordinator,
      async listUnresolvedTurns() {
        const records = await baseCoordinator.listUnresolvedTurns();
        return (Array.isArray(records) ? records : [])
          .filter((item) => !['closed-by-user', 'superseded'].includes(String(item?.state || '')));
      }
    });
  }

  async function ownerTabStillExists(turnRecord) {
    const tabId = turnRecord?.ownerTabId;
    if (!Number.isInteger(tabId)) return true;
    try {
      await chrome.tabs.get(tabId);
      return true;
    } catch {
      return false;
    }
  }

  const originalQueueDurableNotification = globalThis.queueDurableNotification;
  if (typeof originalQueueDurableNotification === 'function') {
    globalThis.queueDurableNotification = async function reliableQueueDurableNotification(turnRecord, reason = '') {
      const correlationId = String(turnRecord?.deliveryCorrelationId || `turn-${suffix(turnRecord?.turnKey)}`);
      const ownerExists = await ownerTabStillExists(turnRecord);
      if (!ownerExists) {
        try {
          await coordinator()?.updateTurn?.(turnRecord?.turnKey, {
            state: 'closed-by-user',
            actionReason: 'owner-tab-closed-before-notification'
          });
        } catch {}
        record('notification-suppressed-owner-tab-closed', {
          correlationId,
          tabId: turnRecord?.ownerTabId,
          reason,
          conversationId: turnRecord?.conversationId,
          notificationId: turnRecord?.notificationId,
          chromeDocumentId: turnRecord?.ownerChromeDocumentId,
          statusRuntimeId: turnRecord?.statusRuntimeId || turnRecord?.documentId,
          monitorRuntimeId: turnRecord?.monitorRuntimeId
        });
        return turnRecord?.notificationId || null;
      }

      record('notification-queue-start', {
        correlationId,
        tabId: Number.isInteger(turnRecord?.ownerTabId) ? turnRecord.ownerTabId : undefined,
        reason,
        conversationId: turnRecord?.conversationId,
        notificationId: turnRecord?.notificationId,
        chromeDocumentId: turnRecord?.ownerChromeDocumentId,
        statusRuntimeId: turnRecord?.statusRuntimeId || turnRecord?.documentId,
        monitorRuntimeId: turnRecord?.monitorRuntimeId
      });

      try {
        const notificationId = await originalQueueDurableNotification(turnRecord, reason);
        record('notification-durable-queued', {
          correlationId,
          reason,
          conversationId: turnRecord?.conversationId,
          notificationId,
          chromeDocumentId: turnRecord?.ownerChromeDocumentId,
          statusRuntimeId: turnRecord?.statusRuntimeId || turnRecord?.documentId,
          monitorRuntimeId: turnRecord?.monitorRuntimeId
        });
        wakeSafeFlushNotificationOutbox().catch((error) => console.warn('Queued notification drain failed', error));
        return notificationId;
      } catch (error) {
        record('notification-queue-error', {
          correlationId,
          reason: error?.message || error,
          conversationId: turnRecord?.conversationId,
          notificationId: turnRecord?.notificationId
        });
        throw error;
      }
    };
  }

  globalThis.flushNotificationOutbox = wakeSafeFlushNotificationOutbox;

  const originalHandleNativeMessage = globalThis.handleNativeMessage;
  if (typeof originalHandleNativeMessage === 'function') {
    globalThis.handleNativeMessage = async function reliableHandleNativeMessage(message) {
      const result = await originalHandleNativeMessage(message);
      const type = String(message?.type || '');
      if (type === 'pong' || type === 'host.ready') {
        wakeSafeFlushNotificationOutbox().catch((error) => console.warn('Native wake outbox drain failed', error));
      }

      if (type === 'toast.dismissed') {
        record('helper-toast-dismissed', {
          conversationId: message?.conversationId,
          notificationId: message?.notificationId,
          reason: 'user-dismissed'
        });
      } else if (type === 'toast.clicked') {
        record('helper-toast-clicked', {
          conversationId: message?.conversationId,
          notificationId: message?.notificationId,
          reason: 'user-clicked'
        });
      }
      return result;
    };
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === OUTBOX_ALARM) {
      wakeSafeFlushNotificationOutbox().catch((error) => console.warn('Outbox retry alarm failed', error));
      return;
    }
    if (alarm?.name === OBSERVATION_ALARM) {
      globalThis.__chatgptNotifierNormalContinuationBudgetHook?.resumePendingObservations?.()
        ?.catch?.((error) => console.warn('Observation retry alarm failed', error));
    }
  });

  try {
    chrome.runtime.onStartup?.addListener?.(() => {
      wakeSafeFlushNotificationOutbox().catch(() => {});
      globalThis.__chatgptNotifierNormalContinuationBudgetHook?.resumePendingObservations?.()?.catch?.(() => {});
    });
  } catch {}

  globalThis.__chatgptNotifierDeliveryReliability = Object.freeze({
    version: 1,
    observationKey,
    enqueueObservation,
    getObservation,
    listPendingObservations,
    noteObservationAttempt,
    resolveObservation,
    deferObservation,
    scheduleObservationAlarm,
    flushNotificationOutbox: wakeSafeFlushNotificationOutbox,
    record
  });

  queueMicrotask(() => wakeSafeFlushNotificationOutbox().catch(() => {}));
})();