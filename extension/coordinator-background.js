'use strict';

(() => {
  if (globalThis.__chatgptNotifierCoordinator) return;

  const DB_NAME = 'chatgpt-response-notifier-coordinator';
  const DB_VERSION = 1;
  const TURN_STORE = 'turns';
  const OUTBOX_STORE = 'notification-outbox';
  const MAX_RECORD_AGE_MS = 14 * 24 * 60 * 60 * 1000;
  let databasePromise = null;

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(TURN_STORE)) {
          database.createObjectStore(TURN_STORE, { keyPath: 'turnKey' });
        }
        if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
          database.createObjectStore(OUTBOX_STORE, { keyPath: 'notificationId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open notifier coordinator database.'));
      request.onblocked = () => reject(new Error('Notifier coordinator database upgrade was blocked.'));
    });
    databasePromise.catch(() => { databasePromise = null; });
    return databasePromise;
  }

  function requestResult(request, errorMessage) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(errorMessage));
    });
  }

  function makeTurnKey(snapshot) {
    const conversationId = String(snapshot?.conversationId || '');
    const promptKey = String(snapshot?.promptKey || '');
    const assistantKey = String(snapshot?.assistantKey || '');
    const revision = String(snapshot?.revision || '');
    if (!conversationId || !promptKey || !assistantKey || !revision) return '';
    return `${conversationId}|${promptKey}|${assistantKey}|${revision}`;
  }

  function cloneRecord(value) {
    return value ? structuredClone(value) : value;
  }

  async function claimTurn(snapshot, owner) {
    const turnKey = makeTurnKey(snapshot);
    if (!turnKey) return { claimed: false, reason: 'missing-turn-identity', record: null };
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(TURN_STORE, 'readwrite');
      const store = transaction.objectStore(TURN_STORE);
      const getRequest = store.get(turnKey);
      let result = null;

      getRequest.onsuccess = () => {
        const existing = getRequest.result || null;
        if (existing) {
          result = { claimed: false, reason: 'already-claimed', record: cloneRecord(existing) };
          return;
        }

        const now = Date.now();
        const record = {
          turnKey,
          conversationId: String(snapshot.conversationId || ''),
          conversationUrl: String(snapshot.conversationUrl || ''),
          documentId: String(snapshot.documentId || ''),
          promptKey: String(snapshot.promptKey || ''),
          assistantKey: String(snapshot.assistantKey || ''),
          revision: String(snapshot.revision || ''),
          statusCode: String(snapshot.statusCode || ''),
          statusLine: String(snapshot.statusLine || ''),
          responseBody: String(snapshot.responseBody || ''),
          responseText: String(snapshot.responseText || ''),
          ownerTabId: Number.isInteger(owner?.tabId) ? owner.tabId : null,
          ownerDocumentId: String(owner?.documentId || snapshot.documentId || ''),
          fingerprint: String(owner?.fingerprint || ''),
          notificationId: String(owner?.notificationId || ''),
          notificationTitle: String(owner?.notificationTitle || 'ChatGPT'),
          notificationPreview: String(owner?.notificationPreview || 'Response finished.'),
          state: 'claimed',
          actionReason: '',
          continuationUserKey: '',
          requestEvidence: '',
          createdAt: now,
          updatedAt: now
        };
        store.add(record);
        result = { claimed: true, reason: 'claimed', record: cloneRecord(record) };
      };
      getRequest.onerror = () => reject(getRequest.error || new Error('Could not read turn ownership.'));
      transaction.oncomplete = () => resolve(result || { claimed: false, reason: 'claim-transaction-empty', record: null });
      transaction.onerror = () => reject(transaction.error || new Error('Turn ownership transaction failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Turn ownership transaction was aborted.'));
    });
  }

  async function getTurn(turnKey) {
    if (!turnKey) return null;
    const database = await openDatabase();
    const transaction = database.transaction(TURN_STORE, 'readonly');
    return cloneRecord(await requestResult(transaction.objectStore(TURN_STORE).get(turnKey), 'Could not read turn record.')) || null;
  }

  async function updateTurn(turnKey, patch) {
    if (!turnKey) return null;
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(TURN_STORE, 'readwrite');
      const store = transaction.objectStore(TURN_STORE);
      const request = store.get(turnKey);
      let updated = null;
      request.onsuccess = () => {
        const current = request.result;
        if (!current) return;
        updated = {
          ...current,
          ...(patch && typeof patch === 'object' ? patch : {}),
          turnKey,
          updatedAt: Date.now()
        };
        store.put(updated);
      };
      request.onerror = () => reject(request.error || new Error('Could not read turn record for update.'));
      transaction.oncomplete = () => resolve(cloneRecord(updated));
      transaction.onerror = () => reject(transaction.error || new Error('Turn update transaction failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Turn update transaction was aborted.'));
    });
  }

  async function listUnresolvedTurns() {
    const database = await openDatabase();
    const transaction = database.transaction(TURN_STORE, 'readonly');
    const all = await requestResult(transaction.objectStore(TURN_STORE).getAll(), 'Could not list turn records.');
    const terminal = new Set(['continued', 'notification-queued', 'notification-acked']);
    return (Array.isArray(all) ? all : [])
      .filter((item) => !terminal.has(String(item?.state || '')))
      .sort((left, right) => Number(left?.createdAt || 0) - Number(right?.createdAt || 0))
      .map(cloneRecord);
  }

  async function queueNotification(turnKey, notification, fingerprint = '') {
    const notificationId = String(notification?.id || '');
    if (!notificationId) throw new Error('Notification ID is required for durable outbox storage.');
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction([OUTBOX_STORE, TURN_STORE], 'readwrite');
      const outbox = transaction.objectStore(OUTBOX_STORE);
      const turns = transaction.objectStore(TURN_STORE);
      const getRequest = outbox.get(notificationId);
      let record = null;

      getRequest.onsuccess = () => {
        record = getRequest.result || {
          notificationId,
          turnKey: String(turnKey || ''),
          notification: cloneRecord(notification),
          fingerprint: String(fingerprint || ''),
          attempts: 0,
          queuedAt: Date.now(),
          updatedAt: Date.now()
        };
        outbox.put(record);
        if (turnKey) {
          const turnRequest = turns.get(turnKey);
          turnRequest.onsuccess = () => {
            if (!turnRequest.result) return;
            turns.put({
              ...turnRequest.result,
              state: 'notification-queued',
              actionReason: String(turnRequest.result.actionReason || ''),
              updatedAt: Date.now()
            });
          };
        }
      };
      getRequest.onerror = () => reject(getRequest.error || new Error('Could not inspect notification outbox.'));
      transaction.oncomplete = () => resolve(cloneRecord(record));
      transaction.onerror = () => reject(transaction.error || new Error('Notification outbox transaction failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Notification outbox transaction was aborted.'));
    });
  }

  async function listOutbox() {
    const database = await openDatabase();
    const transaction = database.transaction(OUTBOX_STORE, 'readonly');
    const all = await requestResult(transaction.objectStore(OUTBOX_STORE).getAll(), 'Could not list notification outbox.');
    return (Array.isArray(all) ? all : [])
      .sort((left, right) => Number(left?.queuedAt || 0) - Number(right?.queuedAt || 0))
      .map(cloneRecord);
  }

  async function noteOutboxAttempt(notificationId) {
    if (!notificationId) return null;
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(OUTBOX_STORE, 'readwrite');
      const store = transaction.objectStore(OUTBOX_STORE);
      const request = store.get(notificationId);
      let updated = null;
      request.onsuccess = () => {
        if (!request.result) return;
        updated = {
          ...request.result,
          attempts: Number(request.result.attempts || 0) + 1,
          updatedAt: Date.now()
        };
        store.put(updated);
      };
      request.onerror = () => reject(request.error || new Error('Could not read notification outbox attempt.'));
      transaction.oncomplete = () => resolve(cloneRecord(updated));
      transaction.onerror = () => reject(transaction.error || new Error('Notification outbox attempt transaction failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Notification outbox attempt transaction was aborted.'));
    });
  }

  async function acknowledgeNotification(notificationId) {
    if (!notificationId) return false;
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction([OUTBOX_STORE, TURN_STORE], 'readwrite');
      const outbox = transaction.objectStore(OUTBOX_STORE);
      const turns = transaction.objectStore(TURN_STORE);
      const request = outbox.get(notificationId);
      let acknowledged = false;
      request.onsuccess = () => {
        const record = request.result;
        if (!record) return;
        acknowledged = true;
        outbox.delete(notificationId);
        if (record.turnKey) {
          const turnRequest = turns.get(record.turnKey);
          turnRequest.onsuccess = () => {
            if (!turnRequest.result) return;
            turns.put({ ...turnRequest.result, state: 'notification-acked', updatedAt: Date.now() });
          };
        }
      };
      request.onerror = () => reject(request.error || new Error('Could not read notification outbox for acknowledgment.'));
      transaction.oncomplete = () => resolve(acknowledged);
      transaction.onerror = () => reject(transaction.error || new Error('Notification acknowledgment transaction failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Notification acknowledgment transaction was aborted.'));
    });
  }

  async function pruneOldRecords(now = Date.now()) {
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(TURN_STORE, 'readwrite');
      const store = transaction.objectStore(TURN_STORE);
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const createdAt = Number(cursor.value?.createdAt || 0);
        if (createdAt > 0 && now - createdAt > MAX_RECORD_AGE_MS) cursor.delete();
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error('Could not prune turn records.'));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Turn prune transaction failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Turn prune transaction was aborted.'));
    });
  }

  globalThis.__chatgptNotifierCoordinator = Object.freeze({
    makeTurnKey,
    claimTurn,
    getTurn,
    updateTurn,
    listUnresolvedTurns,
    queueNotification,
    listOutbox,
    noteOutboxAttempt,
    acknowledgeNotification,
    pruneOldRecords
  });
})();
