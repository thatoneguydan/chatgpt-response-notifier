'use strict';

(() => {
  if (globalThis.__chatgptNotifierRecoveryControl) return;

  // v0.9.0 and older stored the recovery opt-in separately. Keep this database
  // read-only as migration/rollback evidence; the monitor enrollment is now the
  // sole writable owner of both monitoring and bounded recovery permission.
  const LEGACY_DB_NAME = 'chatgpt-response-notifier-recovery-control';
  const LEGACY_DB_VERSION = 1;
  const LEGACY_STORE_NAME = 'conversation-config';
  let databasePromise = null;

  function openLegacyDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(LEGACY_DB_NAME, LEGACY_DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(LEGACY_STORE_NAME)) {
          request.result.createObjectStore(LEGACY_STORE_NAME, { keyPath: 'conversationId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open legacy recovery control database.'));
      request.onblocked = () => reject(new Error('Legacy recovery control database was blocked.'));
    });
    databasePromise.catch(() => { databasePromise = null; });
    return databasePromise;
  }

  async function getConfig(conversationId) {
    if (!conversationId) return null;
    const database = await openLegacyDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(LEGACY_STORE_NAME, 'readonly');
      const request = transaction.objectStore(LEGACY_STORE_NAME).get(String(conversationId));
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Could not read legacy recovery control.'));
    });
  }

  async function overview() {
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    const current = await monitor?.monitorOverview?.();
    if (!current) throw new Error('Build automation state is unavailable.');
    return {
      activeChat: current.activeConversationId ? {
        conversationId: current.activeConversationId,
        conversationUrl: current.activeConversationUrl,
        tabId: current.activeTabId
      } : null,
      recoveryEnabled: current.automationEnabled === true,
      recovery: current.recovery || null,
      unified: true,
      stateRevision: Number(current.stateRevision || 0)
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Compatibility for an already-open old popup during an extension update.
    // Both legacy controls now map to the single authoritative automation state.
    if (message?.type === 'GET_BOUNDED_RECOVERY_OVERVIEW') {
      overview().then((result) => sendResponse?.({ ok: true, ...result }))
        .catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'SET_ACTIVE_CHAT_RECOVERY') {
      globalThis.__chatgptNotifierMonitorBackground?.setActiveAutomation?.({
        enabled: message.enabled === true,
        expectedRevision: message.expectedRevision,
        requestId: message.requestId,
        resumeExistingRun: false
      }).then((result) => sendResponse?.({
        ...result,
        recoveryEnabled: result?.automationEnabled === true
      })).catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'RESUME_ACTIVE_CHAT_RECOVERY') {
      globalThis.__chatgptNotifierMonitorBackground?.setActiveAutomation?.({
        enabled: true,
        expectedRevision: message.expectedRevision,
        requestId: message.requestId,
        resumeExistingRun: true
      }).then((result) => sendResponse?.(result))
        .catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    return false;
  });

  globalThis.__chatgptNotifierRecoveryControl = Object.freeze({
    version: 2,
    legacyReadOnly: true,
    getConfig,
    overview
  });
})();