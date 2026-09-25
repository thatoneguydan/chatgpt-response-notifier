'use strict';

(() => {
  if (globalThis.__chatgptNotifierQuickContinueBridgeBackground) return;

  const RUNTIME_VERSION = 5;
  const BRIDGE_RUNTIME_VERSION = 3;
  const STATUS_RUNTIME_VERSION = 8;
  const BRIDGE_FILE = 'quick-continue-monitor-bridge.js';
  const STATUS_FILE = 'quick-continue-status-owner-v6.js';

  function isChatGptUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' && ['chatgpt.com', 'www.chatgpt.com'].includes(url.hostname);
    } catch {
      return false;
    }
  }

  async function runtimeCurrent(tabId, type, minimumVersion = 1) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type });
      return result?.ok === true && Number(result.runtimeVersion || 0) >= Number(minimumVersion || 1);
    } catch {
      return false;
    }
  }

  async function ensureBridge(tabId) {
    if (!Number.isInteger(tabId)) return false;
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch { return false; }
    if (!isChatGptUrl(tab?.url) || tab?.discarded === true || tab?.frozen === true) return false;

    const bridgeReady = await runtimeCurrent(tabId, 'CHATGPT_NOTIFIER_QUICK_BRIDGE_PING', BRIDGE_RUNTIME_VERSION);
    if (!bridgeReady) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: [BRIDGE_FILE] });
      } catch {
        return false;
      }
    }

    const statusReady = await runtimeCurrent(tabId, 'CHATGPT_NOTIFIER_QUICK_STATUS_PING', STATUS_RUNTIME_VERSION);
    if (!statusReady) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: [STATUS_FILE] });
      } catch {
        return false;
      }
    }

    return await runtimeCurrent(tabId, 'CHATGPT_NOTIFIER_QUICK_BRIDGE_PING', BRIDGE_RUNTIME_VERSION)
      && await runtimeCurrent(tabId, 'CHATGPT_NOTIFIER_QUICK_STATUS_PING', STATUS_RUNTIME_VERSION);
  }

  async function ensureExistingTabs() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); } catch { return; }
    for (const tab of tabs) {
      if (!Number.isInteger(tab?.id)) continue;
      await ensureBridge(tab.id);
    }
  }

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = String(changeInfo?.url || tab?.url || '');
    if (!isChatGptUrl(url)) return;
    if (changeInfo?.status && changeInfo.status !== 'complete') return;
    ensureBridge(tabId).catch(() => false);
  });

  const runtime = Object.freeze({
    version: RUNTIME_VERSION,
    ensureBridge,
    ensureExistingTabs
  });
  globalThis.__chatgptNotifierQuickContinueBridgeBackground = runtime;

  ensureExistingTabs().catch(() => {});
})();