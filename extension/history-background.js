'use strict';

(() => {
  if (globalThis.__chatgptNotifierHistoryBackgroundInstalled) return;
  globalThis.__chatgptNotifierHistoryBackgroundInstalled = true;

  const DB_NAME = 'chatgpt-response-notifier-history';
  const DB_VERSION = 1;
  const STORE_NAME = 'notifications';
  const MAX_HISTORY = 10;
  let databasePromise = null;

  function conversationFromUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''));
      if (url.hostname !== 'chatgpt.com' && url.hostname !== 'www.chatgpt.com') return null;
      const segments = url.pathname.split('/').filter(Boolean);
      for (let index = segments.length - 2; index >= 0; index -= 1) {
        if (segments[index] !== 'c') continue;
        const id = decodeURIComponent(segments[index + 1] || '').trim();
        if (!id) continue;
        return {
          id,
          url: `https://chatgpt.com${url.pathname.replace(/\/+$/, '')}`
        };
      }
    } catch {}
    return null;
  }

  function isStatusCode(value) {
    return Boolean(globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(String(value || '')));
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: 'historyId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open notification history database.'));
      request.onblocked = () => reject(new Error('Notification history database upgrade was blocked.'));
    });
    databasePromise.catch(() => { databasePromise = null; });
    return databasePromise;
  }

  async function getAllHistoryUnbounded() {
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => {
        const items = Array.isArray(request.result) ? request.result : [];
        items.sort((left, right) => String(right.completedAt || '').localeCompare(String(left.completedAt || '')));
        resolve(items);
      };
      request.onerror = () => reject(request.error || new Error('Could not read notification history.'));
    });
  }

  async function getAllHistory() {
    const items = await getAllHistoryUnbounded();
    return items.filter((item) => isStatusCode(item?.statusCode)).slice(0, MAX_HISTORY);
  }

  async function saveHistoryRecord(record) {
    const existing = await getAllHistoryUnbounded();
    const duplicate = existing.find((item) =>
      item.conversationId === record.conversationId &&
      record.fingerprint &&
      item.fingerprint === record.fingerprint
    );
    if (duplicate) record.historyId = duplicate.historyId;

    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.put(record);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not save notification history.'));
      transaction.onabort = () => reject(transaction.error || new Error('Notification history write was aborted.'));
    });

    const all = await getAllHistoryUnbounded();
    const coded = all.filter((item) => isStatusCode(item?.statusCode));
    const keep = new Set(coded.slice(0, MAX_HISTORY).map((item) => item.historyId));
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      for (const item of all) {
        if (!isStatusCode(item?.statusCode) || !keep.has(item.historyId)) store.delete(item.historyId);
      }
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not trim notification history.'));
      transaction.onabort = () => reject(transaction.error || new Error('Notification history trim was aborted.'));
    });
  }

  async function rememberEligibleCompletion(record) {
    if (!record || !isStatusCode(record.statusCode)) return false;
    const conversationId = String(record.conversationId || '');
    const conversationUrl = String(record.conversationUrl || '');
    const identity = conversationFromUrl(conversationUrl);
    if (!conversationId || !identity || identity.id !== conversationId) return false;

    await saveHistoryRecord({
      historyId: String(record.historyId || crypto.randomUUID()),
      fingerprint: String(record.fingerprint || ''),
      conversationId,
      conversationUrl: identity.url,
      title: String(record.title || 'ChatGPT'),
      preview: String(record.preview || 'Response finished.'),
      statusCode: String(record.statusCode || ''),
      completedAt: String(record.completedAt || new Date().toISOString())
    });
    return true;
  }

  async function focusOrOpenConversation(conversationId, conversationUrl) {
    const identity = conversationFromUrl(conversationUrl);
    if (!identity || identity.id !== conversationId) return false;

    const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    const existing = tabs.find((tab) => conversationFromUrl(tab.url)?.id === conversationId);
    if (existing?.id !== undefined) {
      await chrome.tabs.update(existing.id, { active: true });
      if (typeof existing.windowId === 'number') {
        try {
          const windowInfo = await chrome.windows.get(existing.windowId);
          if (windowInfo.state === 'minimized') {
            await chrome.windows.update(existing.windowId, { state: 'normal' });
          }
          await chrome.windows.update(existing.windowId, { focused: true });
        } catch {}
      }
      return true;
    }

    await chrome.tabs.create({ url: identity.url, active: true });
    return true;
  }

  globalThis.__chatgptNotifierHistory = Object.freeze({
    rememberEligibleCompletion
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'GET_RECENT_NOTIFICATIONS') {
      getAllHistory().then((notifications) => {
        sendResponse?.({ ok: true, notifications });
      }).catch((error) => {
        sendResponse?.({ ok: false, notifications: [], error: String(error?.message || error) });
      });
      return true;
    }

    if (message?.type === 'OPEN_RECENT_NOTIFICATION') {
      const conversationId = String(message?.conversationId || '');
      const conversationUrl = String(message?.conversationUrl || '');
      focusOrOpenConversation(conversationId, conversationUrl).then((opened) => {
        sendResponse?.({ ok: opened });
      }).catch((error) => {
        sendResponse?.({ ok: false, error: String(error?.message || error) });
      });
      return true;
    }

    return false;
  });
})();
