'use strict';

(() => {
  if (globalThis.__chatgptNotifierQuickPromptAttachmentInstalled) return;
  globalThis.__chatgptNotifierQuickPromptAttachmentInstalled = true;

  const CHATGPT_URL = /^https:\/\/chatgpt\.com\//i;

  async function attachQuickPrompts(tabId) {
    if (!Number.isInteger(tabId)) return false;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!CHATGPT_URL.test(String(tab?.url || ''))) return false;
      if (tab.discarded === true || tab.frozen === true) return false;
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['quick-prompts-script.js']
      });
      return true;
    } catch {
      return false;
    }
  }

  async function attachQuickPromptsToExistingTabs() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); } catch { return; }
    for (const tab of tabs) {
      if (!Number.isInteger(tab?.id)) continue;
      if (tab.discarded === true || tab.frozen === true) continue;
      await attachQuickPrompts(tab.id);
    }
  }

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo?.status !== 'complete') return;
    if (!CHATGPT_URL.test(String(tab?.url || ''))) return;
    attachQuickPrompts(tabId).catch(() => {});
  });

  attachQuickPromptsToExistingTabs().catch(() => {});
})();
