'use strict';

(() => {
  if (globalThis.__chatgptNotifierQuickContinueBridgeBackground) return;

  const RUNTIME_VERSION = 1;
  const BRIDGE_FILE = 'quick-continue-monitor-bridge.js';

  function isChatGptUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' && ['chatgpt.com', 'www.chatgpt.com'].includes(url.hostname);
    } catch {
      return false;
    }
  }

  async function bridgeCurrent(tabId) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_NOTIFIER_QUICK_BRIDGE_PING' });
      return result?.ok === true && Number(result.runtimeVersion || 0) >= RUNTIME_VERSION;
    } catch {
      return false;
    }
  }

  async function ensureBridge(tabId) {
    if (!Number.isInteger(tabId)) return false;
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch { return false; }
    if (!isChatGptUrl(tab?.url) || tab?.discarded === true || tab?.frozen === true) return false;
    if (await bridgeCurrent(tabId)) return true;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [BRIDGE_FILE] });
    } catch {
      return false;
    }
    return await bridgeCurrent(tabId);
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
