'use strict';

(() => {
  if (globalThis.__chatgptNotifierDeliveryDedupeHook) return;

  const coordinator = globalThis.__chatgptNotifierCoordinator;
  if (!coordinator?.claimTurn) return;

  const DB_NAME = 'chatgpt-response-notifier-delivery-dedupe';
  const DB_VERSION = 1;
  const STORE_NAME = 'claims';
  const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
  const PENDING_LEASE_MS = 30_000;
  const TITLE_SETTLE_ATTEMPTS = 5;
  const TITLE_SETTLE_DELAY_MS = 250;
  let databasePromise = null;

  const originalClaimTurn = coordinator.claimTurn.bind(coordinator);

  function logicalDeliveryKey(snapshot) {
    const conversationId = String(snapshot?.conversationId || '');
    const promptKey = String(snapshot?.promptKey || '');
    const assistantKey = String(snapshot?.assistantKey || '');
    if (!conversationId || !promptKey || !assistantKey) return '';
    return `${conversationId}|${promptKey}|${assistantKey}`;
  }

  function meaningfulTitle(value) {
    const title = String(value || '').trim();
    if (!title) return false;
    const normalized = title.toLowerCase();
    return normalized !== 'chatgpt' && normalized !== 'new chat';
  }

  function sleep(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(delayMs) || 0)));
  }

  async function settleOwnerTitle(owner) {
    const current = String(owner?.notificationTitle || '').trim();
    if (meaningfulTitle(current) || !Number.isInteger(owner?.tabId)) return owner;

    for (let attempt = 0; attempt < TITLE_SETTLE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(TITLE_SETTLE_DELAY_MS);
      try {
        const tab = await chrome.tabs.get(owner.tabId);
        const title = String(tab?.title || '').trim();
        if (meaningfulTitle(title)) return { ...owner, notificationTitle: title };
      } catch {
        break;
      }
    }
    return owner;
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'deliveryKey' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open delivery dedupe database.'));
      request.onblocked = () => reject(new Error('Delivery dedupe database upgrade was blocked.'));
    });
    databasePromise.catch(() => { databasePromise = null; });
    return databasePromise;
  }

  async function reserveDelivery(deliveryKey, snapshot, owner) {
    const database = await openDatabase();
    const now = Date.now();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(deliveryKey);
      let result = null;

      request.onsuccess = () => {
        const existing = request.result || null;
        const existingAt = Number(existing?.updatedAt || existing?.createdAt || 0);
        const pendingIsStale = existing?.state === 'pending' && (existingAt <= 0 || now - existingAt > PENDING_LEASE_MS);
        if (existing && !pendingIsStale) {
          result = { reserved: false, reason: existing.state === 'committed' ? 'already-delivered-logical-turn' : 'logical-turn-in-flight', record: existing };
          return;
        }

        const record = {
          deliveryKey,
          conversationId: String(snapshot?.conversationId || ''),
          promptKey: String(snapshot?.promptKey || ''),
          assistantKey: String(snapshot?.assistantKey || ''),
          revision: String(snapshot?.revision || ''),
          fingerprint: String(owner?.fingerprint || ''),
          state: 'pending',
          createdAt: existing?.createdAt || now,
          updatedAt: now
        };
        store.put(record);
        result = { reserved: true, reason: pendingIsStale ? 'reclaimed-stale-pending' : 'reserved', record };
      };
      request.onerror = () => reject(request.error || new Error('Could not inspect delivery dedupe state.'));
      transaction.oncomplete = () => resolve(result || { reserved: false, reason: 'reservation-transaction-empty', record: null });
      transaction.onerror = () => reject(transaction.error || new Error('Delivery dedupe reservation failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Delivery dedupe reservation was aborted.'));
    });
  }

  async function finalizeReservation(deliveryKey, state) {
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(deliveryKey);
      request.onsuccess = () => {
        const current = request.result;
        if (!current) return;
        if (state === 'release') store.delete(deliveryKey);
        else store.put({ ...current, state: 'committed', updatedAt: Date.now() });
      };
      request.onerror = () => reject(request.error || new Error('Could not finalize delivery dedupe state.'));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Delivery dedupe finalization failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Delivery dedupe finalization was aborted.'));
    });
  }

  async function pruneOldClaims(now = Date.now()) {
    const database = await openDatabase();
    const records = await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => reject(request.error || new Error('Could not list delivery dedupe claims.'));
    });
    const stale = records.filter((record) => {
      const updatedAt = Number(record?.updatedAt || record?.createdAt || 0);
      return updatedAt > 0 && now - updatedAt > MAX_AGE_MS;
    });
    if (!stale.length) return;
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      for (const record of stale) store.delete(record.deliveryKey);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not prune delivery dedupe claims.'));
      transaction.onabort = () => reject(transaction.error || new Error('Delivery dedupe prune was aborted.'));
    });
  }

  async function claimTurn(snapshot, owner = {}) {
    const deliveryKey = logicalDeliveryKey(snapshot);
    if (!deliveryKey) return await originalClaimTurn(snapshot, owner);

    const settledOwner = await settleOwnerTitle(owner);
    const reservation = await reserveDelivery(deliveryKey, snapshot, settledOwner);
    if (!reservation.reserved) {
      return { claimed: false, reason: reservation.reason, record: null };
    }

    try {
      const result = await originalClaimTurn(snapshot, settledOwner);
      if (result?.claimed === true || result?.reason === 'already-claimed') {
        await finalizeReservation(deliveryKey, 'commit');
        return result;
      }
      await finalizeReservation(deliveryKey, 'release');
      return result;
    } catch (error) {
      await finalizeReservation(deliveryKey, 'release').catch(() => {});
      throw error;
    }
  }

  globalThis.__chatgptNotifierCoordinator = Object.freeze({
    ...coordinator,
    claimTurn
  });

  globalThis.__chatgptNotifierDeliveryDedupeHook = Object.freeze({
    version: 1,
    logicalDeliveryKey,
    meaningfulTitle,
    pruneOldClaims
  });

  pruneOldClaims().catch(() => {});
})();
