'use strict';

(() => {
  if (globalThis.__chatgptNotifierQuickPromptAttachmentInstalled) return;
  globalThis.__chatgptNotifierQuickPromptAttachmentInstalled = true;

  // Legacy notifier-owned Quick Prompts were superseded by the standalone
  // Quick Continue extension. This background module intentionally performs no
  // tab injection. The former implementation injected a competing toolbar on
  // every MV3 service-worker cold start and every completed navigation, which
  // made the visible composer controls flash before the canonical toolbar
  // removed the duplicate. Keeping this module as an explicit retirement shim
  // preserves background import compatibility without any page-DOM churn.
})();
