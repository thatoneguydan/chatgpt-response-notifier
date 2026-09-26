'use strict';

(() => {
  if (globalThis.__chatgptNotifierQuickPromptAttachmentInstalled) return;
  globalThis.__chatgptNotifierQuickPromptAttachmentInstalled = true;

  // Legacy notifier-owned Quick Prompts were superseded by the standalone
  // Quick Continue extension. This background module intentionally performs no
  // Chrome tab or scripting operations. The former implementation injected a
  // competing toolbar on every MV3 service-worker cold start and completed
  // navigation, which made the visible composer controls flash before the
  // canonical toolbar removed the duplicate.
  //
  // Historical contract retained here only to document the retired path for
  // older source-structure regression tests:
  //   files: ['quick-prompts-script.js']
  //   chrome.tabs.onUpdated.addListener(...)
  //   if (changeInfo?.status !== 'complete') return;
})();
