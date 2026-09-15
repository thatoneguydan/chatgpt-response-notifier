'use strict';

(() => {
  if (globalThis.__chatgptNotifierResponseStreamStatus) return;

  const DB_NAME = 'chatgpt-response-notifier-response-stream-status';
  const DB_VERSION = 1;
  const STORE_NAME = 'deliveries';
  const CONTEXT_TTL_MS = 5 * 60 * 1000;
  const LATE_DOM_DEDUPE_MS = 10 * 60 * 1000;
  const MAX_RECORD_AGE_MS = 14 * 24 * 60 * 60 * 1000;
  const REQUEST_FILTER = {
    urls: [
      'https://chatgpt.com/backend-api/f/conversation*',
      'https://chatgpt.com/backend-api/conversation*'
    ]
  };

  let databasePromise = null;
  const requestContexts = new Map();
  const latestRequestByDocument = new Map();

  function delivery() {
    return globalThis.__chatgptNotifierDeliveryReliability || null;
  }

  function monitor() {
    return globalThis.__chatgptNotifierMonitorBackground || null;
  }

  function coordinatorState() {
    return globalThis.__chatgptNotifierCoordinator || null;
  }

  function normalizePathname(url) {
    try { return new URL(String(url || '')).pathname.replace(/\/+$/, ''); } catch { return ''; }
  }

  function isAnswerStreamRequest(details) {
    if (!Number.isInteger(details?.tabId) || details.tabId < 0 || details.method !== 'POST') return false;
    const path = normalizePathname(details.url);
    return path === '/backend-api/f/conversation' || path === '/backend-api/conversation';
  }

  function conversationFromUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''));
      if (!['chatgpt.com', 'www.chatgpt.com'].includes(url.hostname)) return null;
      const parts = url.pathname.split('/').filter(Boolean);
      for (let index = parts.length - 2; index >= 0; index -= 1) {
        if (parts[index] !== 'c') continue;
        const id = decodeURIComponent(parts[index + 1] || '').trim();
        if (id) return { id, url: `https://chatgpt.com${url.pathname.replace(/\/+$/, '')}` };
      }
    } catch {}
    return null;
  }

  function contextKey(tabId, documentId) {
    return `${Number(tabId)}|${String(documentId || '')}`;
  }

  function requestKey(details) {
    return `${Number(details?.tabId)}|${String(details?.requestId || '')}`;
  }

  function recordDiagnostic(status, fields = {}) {
    try { delivery()?.record?.(status, fields); } catch {}
  }

  async function queryMonitorSnapshot(tabId, documentId) {
    if (!Number.isInteger(tabId) || !documentId) return null;
    try {
      const response = await chrome.tabs.sendMessage(
        tabId,
        { type: 'CHATGPT_MONITOR_QUERY' },
        { documentId: String(documentId) }
      );
      return response?.snapshot || response || null;
    } catch {
      return null;
    }
  }

  function pruneContexts(now = Date.now()) {
    for (const [key, context] of requestContexts) {
      if (now - Number(context?.startedAt || 0) <= CONTEXT_TTL_MS) continue;
      requestContexts.delete(key);
      const docKey = contextKey(context?.tabId, context?.chromeDocumentId);
      if (latestRequestByDocument.get(docKey) === key) latestRequestByDocument.delete(docKey);
    }
  }

  async function captureRequestContext(details) {
    if (!isAnswerStreamRequest(details)) return;
    const chromeDocumentId = String(details.documentId || '');
    if (!chromeDocumentId) {
      recordDiagnostic('response-stream-request-unroutable', {
        tabId: details.tabId,
        reason: 'chrome-document-id-missing'
      });
      return;
    }

    pruneContexts();
    const key = requestKey(details);
    const context = {
      key,
      tabId: details.tabId,
      requestId: String(details.requestId || ''),
      chromeDocumentId,
      startedAt: Date.now(),
      completedAt: 0,
      failed: false,
      snapshot: null,
      capturePromise: null
    };
    requestContexts.set(key, context);
    latestRequestByDocument.set(contextKey(details.tabId, chromeDocumentId), key);

    context.capturePromise = queryMonitorSnapshot(details.tabId, chromeDocumentId)
      .then((snapshot) => {
        if (requestContexts.get(key) !== context) return null;
        context.snapshot = snapshot || null;
        return context.snapshot;
      })
      .catch(() => null);
  }

  function noteRequestSettled(details, failed = false) {
    if (!isAnswerStreamRequest(details)) return;
    const context = requestContexts.get(requestKey(details));
    if (!context) return;
    context.completedAt = Date.now();
    context.failed = failed === true || Number(details.statusCode || 0) < 200 || Number(details.statusCode || 0) >= 300;
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: 'deliveryKey' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open response-stream delivery database.'));
      request.onblocked = () => reject(new Error('Response-stream delivery database upgrade was blocked.'));
    });
    databasePromise.catch(() => { databasePromise = null; });
    return databasePromise;
  }

  function clone(value) {
    return value ? structuredClone(value) : value;
  }

  function deliveryKey(conversationId, requestId) {
    const conversation = String(conversationId || '');
    const request = String(requestId || '');
    return conversation && request ? `${conversation}|${request}` : '';
  }

  async function listDeliveries() {
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve((Array.isArray(request.result) ? request.result : []).map(clone));
      request.onerror = () => reject(request.error || new Error('Could not list response-stream deliveries.'));
    });
  }

  async function getEarlyDelivery({ conversationId = '', requestId = '', promptKey = '' } = {}) {
    const conversation = String(conversationId || '');
    if (!conversation) return null;

    const exactKey = deliveryKey(conversation, requestId);
    if (exactKey) {
      const database = await openDatabase();
      const exact = await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).get(exactKey);
        request.onsuccess = () => resolve(clone(request.result) || null);
        request.onerror = () => reject(request.error || new Error('Could not read response-stream delivery.'));
      });
      if (exact?.state === 'queued') return exact;
    }

    const prompt = String(promptKey || '');
    if (!prompt) return null;
    const cutoff = Date.now() - LATE_DOM_DEDUPE_MS;
    const candidates = (await listDeliveries())
      .filter((item) => item?.state === 'queued')
      .filter((item) => String(item?.conversationId || '') === conversation)
      .filter((item) => String(item?.promptKey || '') === prompt)
      .filter((item) => Number(item?.createdAt || 0) >= cutoff)
      .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
    return candidates[0] || null;
  }

  async function reserveDelivery(identity) {
    const key = deliveryKey(identity?.conversationId, identity?.requestId);
    if (!key) return { reserved: false, record: null };
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);
      let result = null;
      request.onsuccess = () => {
        if (request.result) {
          result = { reserved: false, record: clone(request.result) };
          return;
        }
        const now = Date.now();
        const deliveryRecord = {
          deliveryKey: key,
          conversationId: String(identity.conversationId || ''),
          requestId: String(identity.requestId || ''),
          promptKey: String(identity.promptKey || ''),
          statusCode: String(identity.statusCode || ''),
          notificationId: crypto.randomUUID(),
          state: 'reserved',
          createdAt: now,
          updatedAt: now
        };
        store.add(deliveryRecord);
        result = { reserved: true, record: clone(deliveryRecord) };
      };
      request.onerror = () => reject(request.error || new Error('Could not inspect response-stream delivery.'));
      transaction.oncomplete = () => resolve(result || { reserved: false, record: null });
      transaction.onerror = () => reject(transaction.error || new Error('Response-stream delivery reservation failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Response-stream delivery reservation was aborted.'));
    });
  }

  async function updateDelivery(key, patch) {
    if (!key) return null;
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);
      let updated = null;
      request.onsuccess = () => {
        if (!request.result) return;
        updated = { ...request.result, ...(patch || {}), deliveryKey: key, updatedAt: Date.now() };
        store.put(updated);
      };
      request.onerror = () => reject(request.error || new Error('Could not update response-stream delivery.'));
      transaction.oncomplete = () => resolve(clone(updated));
      transaction.onerror = () => reject(transaction.error || new Error('Response-stream delivery update failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Response-stream delivery update was aborted.'));
    });
  }

  async function releaseDelivery(key) {
    if (!key) return;
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not release response-stream delivery.'));
      transaction.onabort = () => reject(transaction.error || new Error('Response-stream delivery release was aborted.'));
    });
  }

  async function pruneDeliveries(now = Date.now()) {
    const all = await listDeliveries();
    const stale = all.filter((item) => now - Number(item?.updatedAt || item?.createdAt || 0) > MAX_RECORD_AGE_MS);
    if (!stale.length) return;
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      for (const item of stale) store.delete(item.deliveryKey);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not prune response-stream deliveries.'));
      transaction.onabort = () => reject(transaction.error || new Error('Response-stream delivery prune was aborted.'));
    });
  }

  async function currentContext(sender) {
    const tabId = sender?.tab?.id;
    const chromeDocumentId = String(sender?.documentId || '');
    if (!Number.isInteger(tabId) || !chromeDocumentId) return null;
    pruneContexts();
    const key = latestRequestByDocument.get(contextKey(tabId, chromeDocumentId));
    const context = key ? requestContexts.get(key) : null;
    if (!context || context.failed) return null;
    try { await context.capturePromise; } catch {}
    return context;
  }

  async function identityForStreamEvent(message, sender) {
    const context = await currentContext(sender);
    if (!context) return null;
    const tab = sender?.tab || null;
    const conversation = conversationFromUrl(tab?.url || '');
    if (!conversation) return null;

    const current = await queryMonitorSnapshot(context.tabId, context.chromeDocumentId);
    const first = context.snapshot || {};
    const promptKey = String(first.promptKey || current?.promptKey || '');
    const promptRevision = String(first.promptRevision || current?.promptRevision || '');
    const monitorRuntimeId = String(current?.documentId || first.documentId || '');
    const requestId = String(context.requestId || current?.requestId || '');
    if (!requestId) return null;
    if (promptKey && !promptKey.startsWith(`${conversation.id}|`)) return null;

    return {
      conversationId: conversation.id,
      conversationUrl: conversation.url,
      promptKey,
      promptRevision,
      requestId,
      monitorRuntimeId,
      chromeDocumentId: context.chromeDocumentId,
      tabId: context.tabId,
      statusCode: String(message?.statusCode || ''),
      transport: String(message?.transport || '')
    };
  }

  async function queueEarlyNotification(identity, sender) {
    const enrollment = await monitor()?.getEnrollment?.(identity.conversationId);
    if (enrollment?.enabled !== true || enrollment?.userPaused === true) {
      recordDiagnostic('response-stream-status-not-enrolled', {
        tabId: identity.tabId,
        reason: 'build-automation-not-enabled',
        conversationId: identity.conversationId,
        chromeDocumentId: identity.chromeDocumentId,
        monitorRuntimeId: identity.monitorRuntimeId
      });
      return null;
    }

    const reservation = await reserveDelivery(identity);
    if (!reservation.reserved) {
      recordDiagnostic('response-stream-status-duplicate', {
        tabId: identity.tabId,
        reason: 'request-already-notified',
        conversationId: identity.conversationId,
        notificationId: reservation.record?.notificationId,
        chromeDocumentId: identity.chromeDocumentId,
        monitorRuntimeId: identity.monitorRuntimeId
      });
      return reservation.record?.notificationId || null;
    }

    const deliveryRecord = reservation.record;
    const state = coordinatorState();
    if (!state || typeof state.queueNotification !== 'function') {
      await releaseDelivery(deliveryRecord.deliveryKey).catch(() => {});
      return null;
    }

    const notification = {
      id: deliveryRecord.notificationId,
      conversationId: identity.conversationId,
      conversationUrl: identity.conversationUrl,
      title: String(sender?.tab?.title || 'ChatGPT').trim() || 'ChatGPT',
      preview: 'Response finished.',
      statusCode: identity.statusCode,
      completedAt: new Date().toISOString()
    };
    const fingerprint = `stream|${identity.conversationId}|${identity.requestId}|${identity.statusCode}`;

    try {
      await state.queueNotification('', notification, fingerprint);
      if (typeof rememberNotificationHistory === 'function') {
        await rememberNotificationHistory(notification, fingerprint);
      }
      if (typeof finalizeRecovery === 'function') await finalizeRecovery(identity.conversationId);
      await updateDelivery(deliveryRecord.deliveryKey, { state: 'queued' });
      recordDiagnostic('response-stream-notification-queued', {
        tabId: identity.tabId,
        reason: `status=${identity.statusCode};transport=${identity.transport}`,
        conversationId: identity.conversationId,
        notificationId: notification.id,
        chromeDocumentId: identity.chromeDocumentId,
        monitorRuntimeId: identity.monitorRuntimeId
      });
      if (typeof flushNotificationOutbox === 'function') flushNotificationOutbox().catch(() => {});
      return notification.id;
    } catch {
      await releaseDelivery(deliveryRecord.deliveryKey).catch(() => {});
      recordDiagnostic('response-stream-notification-error', {
        tabId: identity.tabId,
        reason: 'durable-notification-queue-failed',
        conversationId: identity.conversationId,
        chromeDocumentId: identity.chromeDocumentId,
        monitorRuntimeId: identity.monitorRuntimeId
      });
      return null;
    }
  }

  async function handleTerminalStatus(message, sender) {
    const statusCode = String(message?.statusCode || '');
    if (!globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(statusCode)) return null;
    const identity = await identityForStreamEvent(message, sender);
    if (!identity) {
      recordDiagnostic('response-stream-status-unroutable', {
        tabId: sender?.tab?.id,
        reason: 'request-identity-missing',
        chromeDocumentId: sender?.documentId
      });
      return null;
    }

    recordDiagnostic('response-stream-terminal-status-seen', {
      tabId: identity.tabId,
      reason: `status=${identity.statusCode};transport=${identity.transport}`,
      conversationId: identity.conversationId,
      chromeDocumentId: identity.chromeDocumentId,
      monitorRuntimeId: identity.monitorRuntimeId
    });
    return await queueEarlyNotification(identity, sender);
  }

  function installLateDomNotificationDedupe() {
    const original = globalThis.queueDurableNotification;
    if (typeof original !== 'function' || original.__responseStreamDedupeWrapped === true) return;

    const wrapped = async function responseStreamAwareQueueDurableNotification(turnRecord, reason = '') {
      const conversationId = String(turnRecord?.conversationId || '');
      const promptKey = String(turnRecord?.promptKey || '');
      if (conversationId && promptKey) {
        let early = null;
        try { early = await getEarlyDelivery({ conversationId, promptKey }); } catch {}
        if (early?.notificationId) {
          const state = coordinatorState();
          if (turnRecord?.turnKey && state?.updateTurn) {
            try {
              await state.updateTurn(turnRecord.turnKey, {
                state: 'notification-queued',
                actionReason: reason
                  ? `${String(reason)};response-stream-notification-already-present`
                  : 'response-stream-notification-already-present'
              });
            } catch {}
          }
          try { if (typeof finalizeRecovery === 'function') await finalizeRecovery(conversationId); } catch {}
          recordDiagnostic('response-stream-late-dom-notification-suppressed', {
            tabId: Number.isInteger(turnRecord?.ownerTabId) ? turnRecord.ownerTabId : undefined,
            reason: 'same-prompt-stream-notification-already-present',
            conversationId,
            notificationId: early.notificationId
          });
          return early.notificationId;
        }
      }
      return await original.apply(this, arguments);
    };
    Object.defineProperty(wrapped, '__responseStreamDedupeWrapped', { value: true });
    Object.defineProperty(wrapped, '__responseStreamDedupeOriginal', { value: original });
    globalThis.queueDurableNotification = wrapped;
  }

  async function attachExistingTabs() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); } catch { return; }
    for (const tab of tabs) {
      if (!Number.isInteger(tab?.id) || tab.discarded === true || tab.frozen === true) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['response-stream-status-main.js'],
          world: 'MAIN'
        });
      } catch {}
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['status-code.js', 'response-stream-status-bridge.js']
        });
      } catch {}
    }
  }

  chrome.webRequest.onBeforeRequest.addListener((details) => {
    captureRequestContext(details).catch(() => {});
  }, REQUEST_FILTER);

  chrome.webRequest.onCompleted.addListener((details) => {
    noteRequestSettled(details, false);
  }, REQUEST_FILTER);

  chrome.webRequest.onErrorOccurred.addListener((details) => {
    noteRequestSettled(details, true);
  }, REQUEST_FILTER);

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === 'CHATGPT_RESPONSE_STREAM_DIAGNOSTIC') {
      recordDiagnostic(`response-stream-${String(message?.state || 'diagnostic')}`, {
        tabId: sender?.tab?.id,
        reason: `transport=${String(message?.transport || '')}`,
        chromeDocumentId: sender?.documentId
      });
      return false;
    }
    if (message?.type !== 'CHATGPT_RESPONSE_STREAM_TERMINAL_STATUS') return false;
    handleTerminalStatus(message, sender).catch(() => {});
    return false;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    for (const [key, context] of requestContexts) {
      if (context?.tabId !== tabId) continue;
      requestContexts.delete(key);
      const docKey = contextKey(context.tabId, context.chromeDocumentId);
      if (latestRequestByDocument.get(docKey) === key) latestRequestByDocument.delete(docKey);
    }
  });

  installLateDomNotificationDedupe();
  attachExistingTabs().catch(() => {});

  globalThis.__chatgptNotifierResponseStreamStatus = Object.freeze({
    version: 1,
    getEarlyDelivery,
    handleTerminalStatus,
    pruneDeliveries,
    attachExistingTabs
  });

  pruneDeliveries().catch(() => {});
})();
