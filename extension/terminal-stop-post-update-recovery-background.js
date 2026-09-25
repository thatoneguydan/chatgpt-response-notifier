'use strict';

(() => {
  if (globalThis.__chatgptNotifierTerminalStopPostUpdateRecovery) return;

  const RUNTIME_VERSION = 3;
  const REFRESH_DELAYS_MS = Object.freeze([0, 250, 1000, 3000]);
  const HOT_RUNTIME_FILES = Object.freeze([
    'page-runtime-rebind.js',
    'page-dom-compat.js',
    'attachment-script.js',
    'content-script.js',
    'persistence-script.js',
    'status-code.js',
    'status-policy.js',
    'rendered-terminal-status.js',
    'monitor-script.js',
    'bounded-recovery-script.js',
    'status-script.js',
    'terminal-status-live-observer.js',
    'recovery-script.js',
    'watchdog-page-authority-v3.js',
    'automation-route-refresh.js',
    'observation-relay.js',
    'response-stream-status-bridge.js',
    'hidden-window-diagnostics-page.js',
    'quick-continue-monitor-bridge.js',
    'quick-continue-status-owner-v6.js'
  ]);
  const scheduledByTab = new Map();

  function isChatGptUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' && ['chatgpt.com', 'www.chatgpt.com'].includes(url.hostname);
    } catch {
      return false;
    }
  }

  async function refreshTerminalAuthority(tabId) {
    if (!Number.isInteger(tabId)) return false;
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch { return false; }
    if (!isChatGptUrl(tab?.url) || tab?.discarded === true || tab?.frozen === true) return false;

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [...HOT_RUNTIME_FILES]
      });
    } catch {
      return false;
    }

    try {
      const [authority, attachment, monitor, status, renderedObserver, quickBridge, quickStatus] = await Promise.all([
        chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_NOTIFIER_WATCHDOG_PAGE_AUTHORITY_PING' }).catch(() => null),
        chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_NOTIFIER_ATTACHMENT_PING' }).catch(() => null),
        chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_MONITOR_QUERY' }).catch(() => null),
        chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_STATUS_RUNTIME_PING' }).catch(() => null),
        chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_RENDERED_TERMINAL_OBSERVER_PING' }).catch(() => null),
        chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_NOTIFIER_QUICK_BRIDGE_PING' }).catch(() => null),
        chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_NOTIFIER_QUICK_STATUS_PING' }).catch(() => null)
      ]);
      return authority?.ok === true
        && attachment?.ok === true
        && Boolean(monitor?.snapshot || monitor?.conversationId)
        && status?.ok === true
        && renderedObserver?.ok === true
        && quickBridge?.ok === true
        && quickStatus?.ok === true;
    } catch {
      return false;
    }
  }

  function scheduleTerminalRefresh(tabId) {
    if (!Number.isInteger(tabId)) return;
    const previous = scheduledByTab.get(tabId) || [];
    for (const timer of previous) {
      try { clearTimeout(timer); } catch {}
    }

    const timers = REFRESH_DELAYS_MS.map((delayMs, index) => setTimeout(() => {
      refreshTerminalAuthority(tabId).catch(() => false);
      if (index === REFRESH_DELAYS_MS.length - 1) scheduledByTab.delete(tabId);
    }, delayMs));
    scheduledByTab.set(tabId, timers);
  }

  async function ensureExistingTabs() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); } catch { return; }
    for (const tab of tabs) {
      if (Number.isInteger(tab?.id)) scheduleTerminalRefresh(tab.id);
    }
  }

  function handleRuntimeMessage(message, sender) {
    if (
      message?.type === 'CHATGPT_RESPONSE_STREAM_DIAGNOSTIC'
      && message?.state === 'stream-read-error'
      && Number.isInteger(sender?.tab?.id)
    ) {
      scheduleTerminalRefresh(sender.tab.id);
    }
    return false;
  }

  try { chrome.runtime.onMessage.addListener(handleRuntimeMessage); } catch {}
  try {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      const url = String(changeInfo?.url || tab?.url || '');
      if (!isChatGptUrl(url)) return;
      if (changeInfo?.status && changeInfo.status !== 'complete') return;
      scheduleTerminalRefresh(tabId);
    });
  } catch {}

  globalThis.__chatgptNotifierTerminalStopPostUpdateRecovery = Object.freeze({
    version: RUNTIME_VERSION,
    refreshTerminalAuthority,
    scheduleTerminalRefresh,
    ensureExistingTabs,
    hotRuntimeFiles: HOT_RUNTIME_FILES
  });

  ensureExistingTabs().catch(() => {});
})();
