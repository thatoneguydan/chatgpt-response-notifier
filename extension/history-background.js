'use strict';

(() => {
  if (globalThis.__chatgptNotifierHistoryBackgroundInstalled) return;
  globalThis.__chatgptNotifierHistoryBackgroundInstalled = true;

  const DB_NAME = 'chatgpt-response-notifier-history';
  const DB_VERSION = 1;
  const STORE_NAME = 'notifications';
  const MAX_HISTORY = 10;
  const RESPONSE_PREVIEW_MAX_CHARS = 300;
  let databasePromise = null;

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

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

  function fullTabTitle(sender, message) {
    const title = String(sender?.tab?.title || message?.sessionTitle || 'ChatGPT').trim();
    return title || 'ChatGPT';
  }

  function truncateResponse(text, maxChars = RESPONSE_PREVIEW_MAX_CHARS) {
    const normalized = normalize(text);
    if (!normalized) return 'Response finished.';
    if (normalized.length <= maxChars) return normalized;
    const slice = normalized.slice(0, Math.max(1, maxChars - 3));
    const lastSpace = slice.lastIndexOf(' ');
    const safeCut = lastSpace >= Math.floor(maxChars * 0.7) ? slice.slice(0, lastSpace) : slice;
    return `${safeCut.trimEnd()}...`;
  }

  function sleep(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
  }

  async function resolveConversationIdentity(initialUrl, tabId) {
    let identity = conversationFromUrl(initialUrl);
    if (identity) return identity;

    if (typeof tabId !== 'number') return null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(250);
      try {
        const tab = await chrome.tabs.get(tabId);
        identity = conversationFromUrl(tab.url);
        if (identity) return identity;
      } catch {
        return null;
      }
    }
    return null;
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

  async function getAllHistory() {
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => {
        const items = Array.isArray(request.result) ? request.result : [];
        items.sort((left, right) => String(right.completedAt || '').localeCompare(String(left.completedAt || '')));
        resolve(items.slice(0, MAX_HISTORY));
      };
      request.onerror = () => reject(request.error || new Error('Could not read notification history.'));
    });
  }

  async function saveHistoryRecord(record) {
    const existing = await getAllHistory();
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
    if (all.length <= MAX_HISTORY) return;
    const keep = new Set(all.slice(0, MAX_HISTORY).map((item) => item.historyId));
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      for (const item of all) {
        if (!keep.has(item.historyId)) store.delete(item.historyId);
      }
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not trim notification history.'));
      transaction.onabort = () => reject(transaction.error || new Error('Notification history trim was aborted.'));
    });
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

  async function rememberCompletion(message, sender) {
    const tabId = sender.tab?.id;
    const identity = await resolveConversationIdentity(sender.tab?.url || '', tabId);
    if (!identity) return;

    const fingerprint = String(message?.fingerprint || '');
    const completedAt = new Date().toISOString();
    await saveHistoryRecord({
      historyId: crypto.randomUUID(),
      fingerprint,
      conversationId: identity.id,
      conversationUrl: identity.url,
      title: fullTabTitle(sender, message),
      preview: truncateResponse(message?.response),
      completedAt
    });
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

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'CHATGPT_RESPONSE_COMPLETE') {
      rememberCompletion(message, sender).catch((error) => {
        console.warn('Could not save completion in recent notification history', error);
      });
      return false;
    }

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
