'use strict';

(() => {
  if (globalThis.__chatgptNotifierWatchdogRequestLifecycleFix) return;

  const RUNTIME_VERSION = 3;
  const DB_NAME = 'chatgpt-response-notifier-monitor';
  const DB_VERSION = 1;
  const PROFILE_STORE = 'profile';
  const WATCHDOG_PREFIX = 'code-watchdog:';
  const ALARM_PREFIX = 'chatgpt-notifier-code-watchdog:';
  const MANUAL_SETTLE_RETRY_MS = 60;
  const MANUAL_SETTLE_RETRIES = 16;
  const ROUTE_BIND_RETRY_MS = 80;
  const ROUTE_BIND_RETRIES = 25;
  const TERMINAL_REASSERT_DELAYS_MS = Object.freeze([25, 125, 400]);
  const requestStartsByTab = new Map();
  const terminalLatchesByConversation = new Map();
  const terminalReassertionsByConversation = new Map();
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

  function isAnswerStreamRequest(details) {
    if (!Number.isInteger(details?.tabId) || details.tabId < 0 || details.method !== 'POST') return false;
    try {
      const path = new URL(String(details.url || '')).pathname.replace(/\/+$/, '');
      return path === '/backend-api/f/conversation' || path === '/backend-api/conversation';
    } catch {
      return false;
    }
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

  function requestResult(request, errorMessage) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(errorMessage));
    });
  }

  async function readWatchdog(conversationId) {
    if (!conversationId) return null;
    const database = await openDatabase();
    const transaction = database.transaction(PROFILE_STORE, 'readonly');
    const value = await requestResult(transaction.objectStore(PROFILE_STORE).get(`${WATCHDOG_PREFIX}${conversationId}`), 'Could not read watchdog.');
    return value ? structuredClone(value) : null;
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
      transaction.onerror = () => reject(transaction.error || new Error('Could not update watchdog.'));
      transaction.onabort = () => reject(transaction.error || new Error('Watchdog update was aborted.'));
    });
    return next;
  }

  function watchdogAlarmName(conversationId) {
    return `${ALARM_PREFIX}${encodeURIComponent(String(conversationId || ''))}`;
  }

  function statusCodeFromStopReason(reasonValue) {
    const reason = String(reasonValue || '');
    return reason.startsWith('status:') ? reason.slice('status:'.length) : '';
  }

  async function resetStoppedAttempts(conversationId, statusCode) {
    const current = await readWatchdog(conversationId).catch(() => null);
    if (!current || current.stopped !== true) return current;
    if (String(current.stopReason || '') !== `status:${statusCode}`) return current;
    try { await chrome.alarms.clear(watchdogAlarmName(conversationId)); } catch {}
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

  function clearTerminalLatch(conversationId) {
    const id = String(conversationId || '');
    if (!id) return;
    terminalLatchesByConversation.delete(id);
  }

  function rememberTerminalLatch(conversationId, statusCode, promptKey, stoppedAt = Date.now()) {
    const id = String(conversationId || '');
    if (!id || !statusCode) return null;
    const latch = Object.freeze({
      conversationId: id,
      statusCode: String(statusCode),
      promptKey: String(promptKey || ''),
      stoppedAt: Math.max(0, Number(stoppedAt || Date.now()))
    });
    terminalLatchesByConversation.set(id, latch);
    return latch;
  }

  function freshRequestClearsTerminalLatch(conversationId, requestStartedAt) {
    const id = String(conversationId || '');
    const latch = terminalLatchesByConversation.get(id);
    if (!latch) return false;
    const startedAt = Math.max(0, Number(requestStartedAt || 0));
    if (!startedAt || startedAt <= Number(latch.stoppedAt || 0)) return false;
    clearTerminalLatch(id);
    return true;
  }

  async function publishOverview(target) {
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    if (!target || typeof monitor?.monitorOverview !== 'function' || typeof monitor?.publishAutomationOverview !== 'function') return;
    try {
      const overview = await monitor.monitorOverview(target);
      await monitor.publishAutomationOverview(target, overview);
    } catch {}
  }

  async function reassertTerminalLatch(conversationId, tabId, expectedStoppedAt) {
    const id = String(conversationId || '');
    const latch = terminalLatchesByConversation.get(id);
    if (!latch || Number(latch.stoppedAt || 0) !== Number(expectedStoppedAt || 0)) return false;

    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch { return false; }
    const identity = conversationFromUrl(tab?.url || '');
    if (!identity || identity.id !== id) return false;

    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    if (typeof monitor?.reconcileCodeWatchdog !== 'function') return false;

    for (const delayMs of TERMINAL_REASSERT_DELAYS_MS) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const activeLatch = terminalLatchesByConversation.get(id);
      if (!activeLatch || Number(activeLatch.stoppedAt || 0) !== Number(expectedStoppedAt || 0)) return false;

      const current = await readWatchdog(id).catch(() => null);
      const currentRequestStartedAt = Math.max(0, Number(current?.lastRequestStartedAt || 0));
      if (currentRequestStartedAt > Number(activeLatch.stoppedAt || 0)) {
        clearTerminalLatch(id);
        return false;
      }

      try {
        await monitor.reconcileCodeWatchdog({
          conversationId: id,
          conversationUrl: identity.url,
          promptKey: String(activeLatch.promptKey || current?.lastPromptKey || ''),
          previousPromptKey: '',
          previousStatusCode: '',
          statusCode: activeLatch.statusCode,
          requestStartedAt: currentRequestStartedAt
        }, { tab });
        await resetStoppedAttempts(id, activeLatch.statusCode).catch(() => null);
      } catch {}
    }

    await publishOverview({ tab, id, url: identity.url });
    return true;
  }

  function scheduleTerminalReassert(conversationId, tabId) {
    const id = String(conversationId || '');
    const latch = terminalLatchesByConversation.get(id);
    if (!latch || !Number.isInteger(tabId)) return;
    if (terminalReassertionsByConversation.has(id)) return;
    const promise = reassertTerminalLatch(id, tabId, latch.stoppedAt)
      .catch(() => false)
      .finally(() => terminalReassertionsByConversation.delete(id));
    terminalReassertionsByConversation.set(id, promise);
  }

  async function releaseTerminalStopForFreshRequest(conversationId, requestStartedAt) {
    const id = String(conversationId || '');
    const startedAt = Math.max(0, Number(requestStartedAt || 0));
    if (!id || !startedAt) return null;

    const current = await readWatchdog(id).catch(() => null);
    if (!current?.stopped || !String(current.stopReason || '').startsWith('status:')) return current;
    if (startedAt <= Math.max(0, Number(current.lastRequestStartedAt || 0))) return current;

    // The network request is extension-observed proof of a new interaction. Mark
    // that request as the operator prompt boundary before normal reconciliation so
    // the terminal-storage invariant may release only the old response's stop.
    return await writeWatchdog({
      ...current,
      stopped: false,
      stopReason: '',
      lastStatusCode: '',
      sendCount: 0,
      waitingForRequestStart: false,
      lastRequestStartedAt: startedAt,
      operatorPromptArmedAt: Math.max(startedAt, Number(current.operatorPromptArmedAt || 0) + 1),
      deadlineAt: 0,
      retryAt: 0,
      retryReason: ''
    }).catch(() => current);
  }

  async function armRequestStartForTab(tabId, requestId, requestStartedAt, attempt = 0) {
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    if (typeof monitor?.reconcileCodeWatchdog !== 'function' || typeof monitor?.monitorOverview !== 'function') return false;

    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch { return false; }
    const identity = conversationFromUrl(tab?.url || '');
    if (!identity) return false;
    freshRequestClearsTerminalLatch(identity.id, requestStartedAt);

    let overview = null;
    try { overview = await monitor.monitorOverview({ tab, id: identity.id, url: identity.url }); } catch {}
    if (overview?.automationEnabled !== true) {
      if (attempt < ROUTE_BIND_RETRIES) {
        setTimeout(() => {
          armRequestStartForTab(tabId, requestId, requestStartedAt, attempt + 1).catch(() => false);
        }, ROUTE_BIND_RETRY_MS);
      }
      return false;
    }

    try {
      await releaseTerminalStopForFreshRequest(identity.id, requestStartedAt);
      await monitor.reconcileCodeWatchdog({
        conversationId: identity.id,
        conversationUrl: identity.url,
        promptKey: '',
        previousPromptKey: '',
        previousStatusCode: '',
        statusCode: '',
        requestId: String(requestId || ''),
        requestStartedAt: Math.max(0, Number(requestStartedAt || Date.now()))
      }, { tab });
      await publishOverview({ tab, id: identity.id, url: identity.url });
      return true;
    } catch {
      return false;
    }
  }

  async function deferManualEnableTimer(tabId, toggledAt, attempt = 0) {
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    if (typeof monitor?.chatTargetFromTab !== 'function') return false;

    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch { return false; }
    const target = monitor.chatTargetFromTab(tab);
    if (!target?.id) return false;

    const watchdog = await readWatchdog(target.id).catch(() => null);
    if (!watchdog) {
      if (attempt < MANUAL_SETTLE_RETRIES) {
        setTimeout(() => deferManualEnableTimer(tabId, toggledAt, attempt + 1).catch(() => false), MANUAL_SETTLE_RETRY_MS);
      }
      return false;
    }

    const manualActivatedAt = Math.max(0, Number(watchdog.manualActivatedAt || 0));
    if (manualActivatedAt < toggledAt - 2000) return false;

    const latestRequest = requestStartsByTab.get(tabId) || null;
    const freshRequestStartedAt = Math.max(0, Number(latestRequest?.requestStartedAt || 0));
    if (freshRequestStartedAt >= toggledAt) {
      return await armRequestStartForTab(tabId, latestRequest.requestId, freshRequestStartedAt);
    }

    try { await chrome.alarms.clear(watchdogAlarmName(target.id)); } catch {}
    const deferred = await writeWatchdog({
      ...watchdog,
      stopped: false,
      stopReason: '',
      waitingForRequestStart: true,
      resetAt: toggledAt,
      deadlineAt: 0,
      retryAt: 0,
      retryReason: '',
      manualEnableDeferredAt: toggledAt
    }).catch(() => null);
    if (deferred) await publishOverview(target);

    const requestAfterWrite = requestStartsByTab.get(tabId) || null;
    const requestAfterWriteAt = Math.max(0, Number(requestAfterWrite?.requestStartedAt || 0));
    if (requestAfterWriteAt >= toggledAt) {
      return await armRequestStartForTab(tabId, requestAfterWrite.requestId, requestAfterWriteAt);
    }
    return Boolean(deferred);
  }

  async function resolveManualEnableTabId(message, sender) {
    if (Number.isInteger(sender?.tab?.id)) return sender.tab.id;
    if (Number.isInteger(message?.tabId)) return message.tabId;
    let tabs = [];
    try { tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: ['https://chatgpt.com/*'] }); } catch {}
    return Number.isInteger(tabs[0]?.id) ? tabs[0].id : null;
  }

  async function parkTerminalStatusForSender(message, sender) {
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    const policy = globalThis.ChatGPTNotifierContinuationPolicy;
    const parser = globalThis.ChatGPTNotifierStatusCode;
    if (
      typeof monitor?.chatTargetFromTab !== 'function'
      || typeof monitor?.reconcileCodeWatchdog !== 'function'
    ) return { ok: false, reason: 'watchdog-runtime-unavailable' };

    const target = monitor.chatTargetFromTab(sender?.tab);
    if (!target?.id || !Number.isInteger(target?.tab?.id)) return { ok: false, reason: 'watchdog-target-unavailable' };
    if (message?.conversationId && String(message.conversationId) !== String(target.id)) {
      return { ok: false, reason: 'target-conversation-changed' };
    }

    const statusCode = String(message?.statusCode || '');
    if (parser?.isStatusCode?.(statusCode) !== true || policy?.isDefinitiveStopStatusCode?.(statusCode) !== true) {
      return { ok: false, reason: 'not-definitive-stop-status' };
    }

    let overview = null;
    try { overview = await monitor.monitorOverview(target); } catch {}
    if (overview?.automationEnabled !== true) return { ok: false, reason: 'automation-not-active', ...(overview || {}) };

    const current = await readWatchdog(target.id).catch(() => null);
    if (current?.lastPromptKey && message?.promptKey
      && String(current.lastPromptKey) !== String(message.promptKey)) {
      return { ok: false, reason: 'terminal-prompt-superseded', ...(overview || {}) };
    }
    const promptKey = String(message?.promptKey || current?.lastPromptKey || '');
    const stoppedAt = Date.now();
    const stopped = await monitor.reconcileCodeWatchdog({
      conversationId: target.id,
      conversationUrl: target.url,
      promptKey,
      previousPromptKey: '',
      previousStatusCode: '',
      statusCode,
      requestStartedAt: Math.max(0, Number(current?.lastRequestStartedAt || 0))
    }, { tab: target.tab });

    if (stopped?.stopped !== true || String(stopped?.stopReason || '') !== `status:${statusCode}`) {
      return { ok: false, reason: 'terminal-stop-not-persisted', ...(overview || {}) };
    }

    rememberTerminalLatch(target.id, statusCode, promptKey, stoppedAt);
    await resetStoppedAttempts(target.id, statusCode).catch(() => null);
    try { overview = await monitor.monitorOverview(target); } catch {}
    await publishOverview(target);
    return { ok: true, stopped: true, statusCode, ...(overview || {}) };
  }

  chrome.webRequest.onBeforeRequest.addListener((details) => {
    if (!isAnswerStreamRequest(details)) return;
    const requestStartedAt = Date.now();
    const record = {
      tabId: details.tabId,
      requestId: String(details.requestId || ''),
      requestStartedAt
    };
    requestStartsByTab.set(details.tabId, record);

    let tab = null;
    chrome.tabs.get(details.tabId).then((value) => {
      tab = value;
      const identity = conversationFromUrl(tab?.url || '');
      if (identity) freshRequestClearsTerminalLatch(identity.id, requestStartedAt);
    }).catch(() => {});

    armRequestStartForTab(details.tabId, record.requestId, requestStartedAt).catch(() => false);
  }, {
    urls: [
      'https://chatgpt.com/backend-api/f/conversation*',
      'https://chatgpt.com/backend-api/conversation*'
    ]
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const identity = conversationFromUrl(changeInfo?.url || tab?.url || '');
    const request = requestStartsByTab.get(tabId);
    if (!identity || !request) return;
    armRequestStartForTab(tabId, request.requestId, request.requestStartedAt).catch(() => false);
  });

  chrome.tabs.onRemoved.addListener((tabId) => requestStartsByTab.delete(tabId));

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'PARK_CODE_WATCHDOG_FOR_TERMINAL_STATUS_FOR_SENDER') {
      parkTerminalStatusForSender(message, sender)
        .then((result) => sendResponse?.(result))
        .catch((error) => sendResponse?.({ ok: false, reason: 'terminal-stop-failed', error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'CHATGPT_MONITOR_STATE') {
      const conversationId = String(message?.snapshot?.conversationId || '');
      const latch = terminalLatchesByConversation.get(conversationId);
      if (latch && Number.isInteger(sender?.tab?.id)) {
        const requestStartedAt = Math.max(0, Number(message?.snapshot?.requestStartedAt || 0));
        if (requestStartedAt > Number(latch.stoppedAt || 0)) clearTerminalLatch(conversationId);
        else scheduleTerminalReassert(conversationId, sender.tab.id);
      }
      return false;
    }

    const manualEnable = (
      message?.type === 'SET_BUILD_AUTOMATION_STATE'
      || message?.type === 'SET_BUILD_AUTOMATION_STATE_FOR_SENDER'
      || message?.type === 'SET_ACTIVE_CHAT_MONITORING'
    ) && message?.enabled === true && message?.resumeExistingRun !== true;
    if (!manualEnable) return false;

    const toggledAt = Date.now();
    resolveManualEnableTabId(message, sender).then((tabId) => {
      if (!Number.isInteger(tabId)) return;
      setTimeout(() => deferManualEnableTimer(tabId, toggledAt).catch(() => false), 0);
    }).catch(() => {});
    return false;
  });

  globalThis.__chatgptNotifierWatchdogRequestLifecycleFix = Object.freeze({
    version: RUNTIME_VERSION,
    requestStartsByTab,
    terminalLatchesByConversation,
    armRequestStartForTab,
    releaseTerminalStopForFreshRequest,
    deferManualEnableTimer,
    resolveManualEnableTabId,
    parkTerminalStatusForSender,
    resetStoppedAttempts,
    statusCodeFromStopReason
  });
})();
