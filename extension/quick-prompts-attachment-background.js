'use strict';

(() => {
  if (globalThis.__chatgptNotifierQuickPromptAttachmentInstalled) return;
  globalThis.__chatgptNotifierQuickPromptAttachmentInstalled = true;

  async function attachQuickPromptsToExistingTabs() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); } catch { return; }
    for (const tab of tabs) {
      if (!Number.isInteger(tab?.id)) continue;
      if (tab.discarded === true || tab.frozen === true) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['quick-prompts-script.js']
        });
      } catch {}
    }
  }

  attachQuickPromptsToExistingTabs().catch(() => {});
})();
