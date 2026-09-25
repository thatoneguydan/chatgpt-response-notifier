'use strict';

(() => {
  if (globalThis.__chatgptNotifierWatchdogAuthorityV3) return;

  const RUNTIME_VERSION = 3;
  const PAGE_RUNTIME_VERSION = 3;
  const STATUS_RUNTIME_VERSION = 7;
  const PAGE_FILE = 'watchdog-page-authority-v3.js';
  const STATUS_FILE = 'quick-continue-status-owner-v6.js';

  function isChatGptUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' && ['chatgpt.com', 'www.chatgpt.com'].includes(url.hostname);
    } catch {
      return false;
    }
  }

  function monitorRuntime() {
    return globalThis.__chatgptNotifierMonitorBackground || null;
  }

  function senderTarget(sender) {
    const monitor = monitorRuntime();
    try { return monitor?.chatTargetFromTab?.(sender?.tab) || null; } catch { return null; }
  }

  function definitiveStatusCode(value) {
    const code = String(value || '');
    const parser = globalThis.ChatGPTNotifierStatusCode;
    const policy = globalThis.ChatGPTNotifierContinuationPolicy;
    if (parser?.isStatusCode?.(code) !== true) return '';
    return policy?.isDefinitiveStopStatusCode?.(code) === true ? code : '';
  }

  async function forceTerminalStop(message, sender) {
    const monitor = monitorRuntime();
    if (
      typeof monitor?.readCodeWatchdog !== 'function'
      || typeof monitor?.parkCodeWatchdogForTerminalStatus !== 'function'
      || typeof monitor?.monitorOverview !== 'function'
      || typeof monitor?.publishAutomationOverview !== 'function'
    ) return { ok: false, reason: 'watchdog-runtime-unavailable' };

    const target = senderTarget(sender);
    if (!target?.id || !Number.isInteger(target?.tab?.id)) return { ok: false, reason: 'watchdog-target-unavailable' };
    if (message?.conversationId && String(message.conversationId) !== String(target.id)) {
      return { ok: false, reason: 'target-conversation-changed' };
    }

    const statusCode = definitiveStatusCode(message?.statusCode);
    if (!statusCode) return { ok: false, reason: 'not-definitive-stop-status' };

    let overview = null;
    try { overview = await monitor.monitorOverview(target); } catch {}
    if (overview?.automationEnabled !== true) {
      return { ok: false, reason: 'automation-not-active', ...(overview || {}) };
    }

    const current = await monitor.readCodeWatchdog(target.id).catch(() => null);
    if (!current) {
      await monitor.publishAutomationOverview(target, overview).catch(() => false);
      return { ok: true, stopped: true, statusCode, ...(overview || {}) };
    }

    if (current.lastPromptKey && message?.promptKey
      && String(current.lastPromptKey) !== String(message.promptKey)) {
      return { ok: false, reason: 'terminal-prompt-superseded', ...(overview || {}) };
    }

    const requestStartedAt = Math.max(
      0,
      Number(message?.requestStartedAt || 0),
      Number(current?.lastRequestStartedAt || 0)
    );
    const promptKey = String(message?.promptKey || current?.lastPromptKey || '');

    await monitor.parkCodeWatchdogForTerminalStatus({
      conversationId: target.id,
      conversationUrl: target.url,
      promptKey,
      requestStartedAt,
      statusCode
    }, { tab: target.tab }, current);

    const stopped = await monitor.readCodeWatchdog(target.id).catch(() => null);
    const persisted = stopped?.stopped === true
      && String(stopped?.stopReason || '') === `status:${statusCode}`
      && Number(stopped?.sendCount || 0) === 0
      && Number(stopped?.deadlineAt || 0) === 0
      && Number(stopped?.retryAt || 0) === 0;
    if (!persisted) return { ok: false, reason: 'terminal-stop-not-persisted', ...(overview || {}) };

    try { overview = await monitor.monitorOverview(target); } catch {}
    await monitor.publishAutomationOverview(target, overview).catch(() => false);
    return { ok: true, stopped: true, statusCode, ...(overview || {}) };
  }

  async function runDueWatchdogNow(message, sender) {
    const monitor = monitorRuntime();
    if (
      typeof monitor?.readCodeWatchdog !== 'function'
      || typeof monitor?.handleCodeWatchdogAlarm !== 'function'
      || typeof monitor?.monitorOverview !== 'function'
      || typeof monitor?.publishAutomationOverview !== 'function'
    ) return { ok: false, reason: 'watchdog-runtime-unavailable' };

    const target = senderTarget(sender);
    if (!target?.id || !Number.isInteger(target?.tab?.id)) return { ok: false, reason: 'watchdog-target-unavailable' };
    if (message?.conversationId && String(message.conversationId) !== String(target.id)) {
      return { ok: false, reason: 'target-conversation-changed' };
    }

    let overview = null;
    try { overview = await monitor.monitorOverview(target); } catch {}
    if (overview?.automationEnabled !== true) {
      return { ok: false, reason: 'automation-not-active', ...(overview || {}) };
    }

    const current = await monitor.readCodeWatchdog(target.id).catch(() => null);
    if (!current || current.stopped === true) {
      await monitor.publishAutomationOverview(target, overview).catch(() => false);
      return { ok: true, ran: false, reason: current?.stopped === true ? 'watchdog-stopped' : 'watchdog-missing', ...(overview || {}) };
    }

    const deadlineAt = Math.max(0, Number(current.deadlineAt || 0));
    const retryAt = Math.max(0, Number(current.retryAt || 0));
    const now = Date.now();
    const due = (deadlineAt > 0 && deadlineAt <= now) || (retryAt > 0 && retryAt <= now);
    if (!due) return { ok: true, ran: false, reason: 'watchdog-not-due', ...(overview || {}) };

    await monitor.handleCodeWatchdogAlarm(target.id);
    try { overview = await monitor.monitorOverview(target); } catch {}
    await monitor.publishAutomationOverview(target, overview).catch(() => false);
    return { ok: true, ran: true, ...(overview || {}) };
  }

  async function pageRuntimeCurrent(tabId, type, minimumVersion) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type });
      return result?.ok === true && Number(result.runtimeVersion || 0) >= Number(minimumVersion || 1);
    } catch {
      return false;
    }
  }

  async function ensurePageAuthority(tabId) {
    if (!Number.isInteger(tabId)) return false;
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch { return false; }
    if (!isChatGptUrl(tab?.url) || tab?.discarded === true || tab?.frozen === true) return false;

    if (!await pageRuntimeCurrent(tabId, 'CHATGPT_NOTIFIER_WATCHDOG_PAGE_AUTHORITY_PING', PAGE_RUNTIME_VERSION)) {
      try { await chrome.scripting.executeScript({ target: { tabId }, files: [PAGE_FILE] }); } catch { return false; }
    }
    if (!await pageRuntimeCurrent(tabId, 'CHATGPT_NOTIFIER_QUICK_STATUS_PING', STATUS_RUNTIME_VERSION)) {
      try { await chrome.scripting.executeScript({ target: { tabId }, files: [STATUS_FILE] }); } catch { return false; }
    }

    return await pageRuntimeCurrent(tabId, 'CHATGPT_NOTIFIER_WATCHDOG_PAGE_AUTHORITY_PING', PAGE_RUNTIME_VERSION)
      && await pageRuntimeCurrent(tabId, 'CHATGPT_NOTIFIER_QUICK_STATUS_PING', STATUS_RUNTIME_VERSION);
  }

  async function ensureExistingTabs() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); } catch { return; }
    for (const tab of tabs) {
      if (!Number.isInteger(tab?.id)) continue;
      await ensurePageAuthority(tab.id);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'FORCE_PARK_CODE_WATCHDOG_TERMINAL_V3') {
      forceTerminalStop(message, sender)
        .then((result) => sendResponse?.(result))
        .catch((error) => sendResponse?.({ ok: false, reason: 'terminal-stop-failed', error: String(error?.message || error) }));
      return true;
    }
    if (message?.type === 'RUN_CODE_WATCHDOG_NOW_V3') {
      runDueWatchdogNow(message, sender)
        .then((result) => sendResponse?.(result))
        .catch((error) => sendResponse?.({ ok: false, reason: 'watchdog-run-failed', error: String(error?.message || error) }));
      return true;
    }
    if (message?.type === 'CHATGPT_NOTIFIER_WATCHDOG_AUTHORITY_V3_PING') {
      sendResponse?.({ ok: true, runtimeVersion: RUNTIME_VERSION });
      return false;
    }
    return false;
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = String(changeInfo?.url || tab?.url || '');
    if (!isChatGptUrl(url)) return;
    if (changeInfo?.status && changeInfo.status !== 'complete') return;
    ensurePageAuthority(tabId).catch(() => false);
  });

  globalThis.__chatgptNotifierWatchdogAuthorityV3 = Object.freeze({
    version: RUNTIME_VERSION,
    forceTerminalStop,
    runDueWatchdogNow,
    ensurePageAuthority,
    ensureExistingTabs
  });

  ensureExistingTabs().catch(() => {});
})();
