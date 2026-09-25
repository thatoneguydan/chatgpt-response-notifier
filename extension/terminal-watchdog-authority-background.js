'use strict';

(() => {
  if (globalThis.__chatgptNotifierTerminalWatchdogAuthority) return;

  const RUNTIME_VERSION = 1;
  const DB_NAME = 'chatgpt-response-notifier-monitor';
  const DB_VERSION = 1;
  const PROFILE_STORE = 'profile';
  const WATCHDOG_PREFIX = 'code-watchdog:';

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
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open watchdog database.'));
      request.onblocked = () => reject(new Error('Watchdog database is blocked.'));
    });
    databasePromise.catch(() => { databasePromise = null; });
    return databasePromise;
  }

  async function readWatchdog(conversationId) {
    const database = await openDatabase();
    const transaction = database.transaction(PROFILE_STORE, 'readonly');
    return await new Promise((resolve, reject) => {
      const request = transaction.objectStore(PROFILE_STORE).get(`${WATCHDOG_PREFIX}${conversationId}`);
      request.onsuccess = () => resolve(request.result ? structuredClone(request.result) : null);
      request.onerror = () => reject(request.error || new Error('Could not read watchdog.'));
    });
  }

  async function writeWatchdog(record) {
    if (!record?.conversationId) return null;
    const database = await openDatabase();
    const next = {
      ...record,
      key: `${WATCHDOG_PREFIX}${record.conversationId}`,
      watchdogRevision: Math.max(0, Number(record.watchdogRevision || 0)) + 1,
      updatedAt: Date.now()
    };
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(PROFILE_STORE, 'readwrite');
      transaction.objectStore(PROFILE_STORE).put(next);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not reset watchdog attempts.'));
      transaction.onabort = () => reject(transaction.error || new Error('Watchdog attempt reset was aborted.'));
    });
    return next;
  }

  function isDefinitiveStop(statusCode) {
    const parser = globalThis.ChatGPTNotifierStatusCode;
    const policy = globalThis.ChatGPTNotifierContinuationPolicy;
    return parser?.isStatusCode?.(statusCode) === true
      && policy?.isDefinitiveStopStatusCode?.(statusCode) === true;
  }

  async function resetStoppedAttempts(conversationId, statusCode) {
    const current = await readWatchdog(conversationId).catch(() => null);
    if (!current || current.stopped !== true) return current;
    if (String(current.stopReason || '') !== `status:${statusCode}`) return current;
    return await writeWatchdog({
      ...current,
      sendCount: 0,
      waitingForRequestStart: false,
      lastAutomaticSentAt: 0,
      lastAutomaticPromptKey: '',
      lastAutomaticParentPromptKey: '',
      deadlineAt: 0,
      retryAt: 0,
      retryReason: ''
    });
  }

  async function publishOverview(target) {
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    if (!target || typeof monitor?.monitorOverview !== 'function' || typeof monitor?.publishAutomationOverview !== 'function') return;
    try {
      const overview = await monitor.monitorOverview(target);
      await monitor.publishAutomationOverview(target, overview);
    } catch {}
  }

  async function stopFromStream(message, sender) {
    const statusCode = String(message?.statusCode || '');
    if (!isDefinitiveStop(statusCode)) return false;

    const lifecycle = globalThis.__chatgptNotifierWatchdogRequestLifecycleFix;
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    if (typeof lifecycle?.parkTerminalStatusForSender !== 'function' || typeof monitor?.chatTargetFromTab !== 'function') return false;

    const target = monitor.chatTargetFromTab(sender?.tab);
    if (!target?.id || !Number.isInteger(target?.tab?.id)) return false;
    const result = await lifecycle.parkTerminalStatusForSender({
      conversationId: target.id,
      statusCode
    }, sender);
    if (result?.ok !== true) return false;

    await resetStoppedAttempts(target.id, statusCode).catch(() => null);
    await publishOverview(target);
    return true;
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== 'CHATGPT_RESPONSE_STREAM_TERMINAL_STATUS') return false;
    stopFromStream(message, sender).catch(() => false);
    return false;
  });

  globalThis.__chatgptNotifierTerminalWatchdogAuthority = Object.freeze({
    version: RUNTIME_VERSION,
    stopFromStream,
    resetStoppedAttempts
  });
})();