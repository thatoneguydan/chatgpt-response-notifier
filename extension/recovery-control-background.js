'use strict';

(() => {
  if (globalThis.__chatgptNotifierRecoveryControl) return;

  const DB_NAME = 'chatgpt-response-notifier-recovery-control';
  const DB_VERSION = 1;
  const STORE_NAME = 'conversation-config';
  let databasePromise = null;

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

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'conversationId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open recovery control database.'));
      request.onblocked = () => reject(new Error('Recovery control database upgrade was blocked.'));
    });
    databasePromise.catch(() => { databasePromise = null; });
    return databasePromise;
  }

  async function getConfig(conversationId) {
    if (!conversationId) return null;
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(String(conversationId));
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Could not read recovery control.'));
    });
  }

  async function setConfig(identity, recoveryEnabled) {
    if (!identity?.id) return null;
    const current = await getConfig(identity.id);
    const now = Date.now();
    const record = {
      conversationId: identity.id,
      conversationUrl: identity.url,
      recoveryEnabled: recoveryEnabled === true,
      enabledAt: recoveryEnabled === true ? (current?.enabledAt || now) : Number(current?.enabledAt || 0),
      updatedAt: now
    };
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(record);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not write recovery control.'));
      transaction.onabort = () => reject(transaction.error || new Error('Recovery control write was aborted.'));
    });
    return record;
  }

  async function activeChatIdentity() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: ['https://chatgpt.com/*'] }); } catch {}
    const tab = tabs[0];
    const identity = conversationFromUrl(tab?.url || '');
    return identity && Number.isInteger(tab?.id) ? { ...identity, tab } : null;
  }

  const monitorApi = globalThis.__chatgptNotifierMonitorBackground;
  if (monitorApi) {
    const originalGetEnrollment = monitorApi.getEnrollment?.bind(monitorApi);
    globalThis.__chatgptNotifierMonitorBackground = Object.freeze({
      ...monitorApi,
      async getEnrollment(conversationId) {
        const enrollment = await originalGetEnrollment?.(conversationId);
        const config = await getConfig(conversationId);
        return enrollment ? { ...enrollment, recoveryEnabled: config?.recoveryEnabled === true } : enrollment;
      },
      raiseAttention: monitorApi.ensureAttention?.bind(monitorApi)
    });
  }

  async function overview() {
    const active = await activeChatIdentity();
    if (!active) return { activeChat: null, recoveryEnabled: false, recovery: null };
    const config = await getConfig(active.id);
    const recovery = await globalThis.__chatgptNotifierBoundedRecovery?.overview?.(active.id) || null;
    return {
      activeChat: { conversationId: active.id, conversationUrl: active.url, title: String(active.tab?.title || 'ChatGPT') },
      recoveryEnabled: config?.recoveryEnabled === true,
      recovery
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'GET_BOUNDED_RECOVERY_OVERVIEW') {
      overview().then((result) => sendResponse?.({ ok: true, ...result }))
        .catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'SET_ACTIVE_CHAT_RECOVERY') {
      (async () => {
        const active = await activeChatIdentity();
        if (!active) { sendResponse?.({ ok: false, error: 'Open a ChatGPT conversation to change recovery.' }); return; }
        const enabled = message.enabled === true;
        if (enabled) await globalThis.__chatgptNotifierMonitorBackground?.setEnrollment?.(active, true, 'operator-recovery');
        const config = await setConfig(active, enabled);
        sendResponse?.({ ok: true, recoveryEnabled: config?.recoveryEnabled === true });
      })().catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'RESUME_ACTIVE_CHAT_RECOVERY') {
      (async () => {
        const active = await activeChatIdentity();
        if (!active) { sendResponse?.({ ok: false, error: 'Open a ChatGPT conversation to resume recovery.' }); return; }
        await globalThis.__chatgptNotifierMonitorBackground?.setEnrollment?.(active, true, 'operator-resume');
        await setConfig(active, true);
        const result = await globalThis.__chatgptNotifierBoundedRecovery?.resumeConversation?.(active.id);
        sendResponse?.(result || { ok: false, reason: 'recovery-coordinator-unavailable' });
      })().catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'SET_ACTIVE_CHAT_MONITORING' && message.enabled !== true) {
      activeChatIdentity().then((active) => active ? setConfig(active, false) : null).catch(() => {});
      return false;
    }
    return false;
  });

  globalThis.__chatgptNotifierRecoveryControl = Object.freeze({ version: 1, getConfig, setConfig, activeChatIdentity, overview });
})();
