'use strict';

(() => {
  if (globalThis.__chatgptNotifierRecoveryBackgroundInstalled) return;
  globalThis.__chatgptNotifierRecoveryBackgroundInstalled = true;

  const REQUEST_FILTER = {
    urls: [
      'https://chatgpt.com/backend-api/f/conversation*',
      'https://chatgpt.com/backend-api/conversation*'
    ]
  };
  const DB_NAME = 'chatgpt-response-notifier';
  const DB_VERSION = 1;
  const STORE_NAME = 'pending-conversations';
  const MAX_PENDING_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const pendingRequestTabs = new Set();
  let databasePromise = null;

  function normalizePathname(url) {
    try {
      return new URL(url).pathname.replace(/\/+$/, '');
    } catch {
      return '';
    }
  }

  function isAnswerStreamRequest(details) {
    if (details.tabId < 0 || details.method !== 'POST') return false;
    const path = normalizePathname(details.url);
    return path === '/backend-api/f/conversation' || path === '/backend-api/conversation';
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

  function sleep(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
  }

  async function resolveConversationIdentity(initialUrl, tabId, attempts = 24) {
    let identity = conversationFromUrl(initialUrl);
    if (identity) return identity;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const tab = await chrome.tabs.get(tabId);
        identity = conversationFromUrl(tab.url);
        if (identity) return identity;
      } catch {
        return null;
      }
      await sleep(250);
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
          database.createObjectStore(STORE_NAME, { keyPath: 'conversationId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open recovery state database.'));
      request.onblocked = () => reject(new Error('Recovery state database upgrade was blocked.'));
    });
    databasePromise.catch(() => { databasePromise = null; });
    return databasePromise;
  }

  async function runStore(mode, callback) {
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      let callbackResult;
      try {
        callbackResult = callback(store);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(callbackResult);
      transaction.onerror = () => reject(transaction.error || new Error('Recovery state transaction failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Recovery state transaction was aborted.'));
    });
  }

  async function rememberPending(identity) {
    if (!identity?.id) return false;
    await runStore('readwrite', (store) => {
      store.put({
        conversationId: identity.id,
        conversationUrl: identity.url,
        startedAt: Date.now()
      });
    });
    return true;
  }

  async function readPending(conversationId) {
    if (!conversationId) return null;
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(conversationId);
      request.onsuccess = () => {
        const record = request.result || null;
        if (!record) {
          resolve(null);
          return;
        }
        const startedAt = Number(record.startedAt || 0);
        if (!Number.isFinite(startedAt) || Date.now() - startedAt > MAX_PENDING_AGE_MS) {
          store.delete(conversationId);
          resolve(null);
          return;
        }
        resolve(record);
      };
      request.onerror = () => reject(request.error || new Error('Could not read recovery state.'));
    });
  }

  async function clearPending(conversationId) {
    if (!conversationId) return false;
    await runStore('readwrite', (store) => store.delete(conversationId));
    return true;
  }

  async function rememberPendingForTab(tabId, initialUrl = '') {
    if (typeof tabId !== 'number' || tabId < 0) return false;
    pendingRequestTabs.add(tabId);
    try {
      const identity = await resolveConversationIdentity(initialUrl, tabId);
      if (!identity) return false;
      await rememberPending(identity);
      return true;
    } finally {
      pendingRequestTabs.delete(tabId);
    }
  }

  async function identityForSender(message, sender) {
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') return null;
    return await resolveConversationIdentity(message?.conversationUrl || sender.tab?.url || '', tabId, 4);
  }

  async function rearmUpstreamMonitor(tabId) {
    const message = { type: 'CHATGPT_CONVERSATION_REQUEST_COMPLETED' };
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch {}

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-script.js']
      });
      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch (error) {
      console.warn('Recovery could not re-arm upstream completion watcher', error);
      return false;
    }
  }

  async function injectRecoveryIntoExistingTabs() {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    } catch {
      return;
    }
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['recovery-script.js']
        });
      } catch {}
    }
  }

  chrome.webRequest.onBeforeRequest.addListener((details) => {
    if (!isAnswerStreamRequest(details)) return;
    rememberPendingForTab(details.tabId, details.documentUrl || '').catch((error) => {
      console.warn('Could not persist pending ChatGPT response state', error);
    });
  }, REQUEST_FILTER);

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!pendingRequestTabs.has(tabId) || !changeInfo.url) return;
    const identity = conversationFromUrl(changeInfo.url);
    if (!identity) return;
    rememberPending(identity).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'CHATGPT_RECOVERY_QUERY') {
      (async () => {
        const identity = await identityForSender(message, sender);
        if (!identity) {
          sendResponse?.({ ok: true, pending: false });
          return;
        }
        const pending = await readPending(identity.id);
        sendResponse?.({
          ok: true,
          pending: Boolean(pending),
          conversationId: identity.id
        });
      })().catch((error) => sendResponse?.({ ok: false, pending: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'CHATGPT_RECOVERY_FINISHED_UI') {
      (async () => {
        const tabId = sender.tab?.id;
        const identity = await identityForSender(message, sender);
        if (typeof tabId !== 'number' || !identity) {
          sendResponse?.({ ok: false, armed: false });
          return;
        }
        const pending = await readPending(identity.id);
        if (!pending) {
          sendResponse?.({ ok: true, armed: false });
          return;
        }
        const armed = await rearmUpstreamMonitor(tabId);
        sendResponse?.({ ok: armed, armed });
      })().catch((error) => sendResponse?.({ ok: false, armed: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'CHATGPT_RECOVERY_CANCEL') {
      (async () => {
        const identity = await identityForSender(message, sender);
        if (identity) await clearPending(identity.id);
        sendResponse?.({ ok: true });
      })().catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'CHATGPT_RESPONSE_COMPLETE') {
      identityForSender(message, sender)
        .then((identity) => identity ? clearPending(identity.id) : false)
        .catch(() => {});
      return false;
    }

    return false;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    pendingRequestTabs.delete(tabId);
  });

  injectRecoveryIntoExistingTabs().catch(() => {});
})();
