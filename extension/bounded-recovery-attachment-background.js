'use strict';

(() => {
  if (globalThis.__chatgptNotifierBoundedRecoveryAttachment) return;
  globalThis.__chatgptNotifierBoundedRecoveryAttachment = true;

  async function attachToExistingTabs() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); } catch { return; }
    for (const tab of tabs) {
      if (!Number.isInteger(tab?.id) || tab.discarded === true || tab.frozen === true) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['status-code.js', 'status-policy.js', 'monitor-script.js', 'bounded-recovery-script.js']
        });
      } catch {}
    }
  }

  globalThis.__chatgptNotifierBoundedRecoveryAttach = Object.freeze({ attachToExistingTabs });
  attachToExistingTabs().catch(() => {});
})();
