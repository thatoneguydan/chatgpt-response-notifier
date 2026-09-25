'use strict';

(() => {
  if (globalThis.__chatgptNotifierPageRuntimeCompatBackground) return;

  const NEEDS_PAGE_COMPAT = new Set([
    'attachment-script.js',
    'monitor-script.js',
    'bounded-recovery-script.js',
    'status-script.js',
    'terminal-status-live-observer.js',
    'recovery-script.js',
    'recovery-live-fix-content.js',
    'quick-continue-monitor-bridge.js',
    'watchdog-page-authority-v3.js'
  ]);
  const PAGE_COMPAT_FILE = 'page-dom-compat.js';

  const originalExecuteScript = chrome.scripting?.executeScript?.bind(chrome.scripting);
  const originalReload = chrome.tabs?.reload?.bind(chrome.tabs);

  if (originalExecuteScript) {
    chrome.scripting.executeScript = function notifierCompatibleExecuteScript(injection, callback) {
      let next = injection;
      try {
        const files = Array.isArray(injection?.files) ? injection.files.map(String) : null;
        if (files && files.some((file) => NEEDS_PAGE_COMPAT.has(file)) && !files.includes(PAGE_COMPAT_FILE)) {
          next = { ...injection, files: [PAGE_COMPAT_FILE, ...files] };
        }
      } catch {}
      return callback === undefined
        ? originalExecuteScript(next)
        : originalExecuteScript(next, callback);
    };
  }

  if (originalReload) {
    chrome.tabs.reload = function notifierHardReload(tabId, reloadProperties, callback) {
      let properties = reloadProperties;
      let completion = callback;
      if (typeof reloadProperties === 'function') {
        completion = reloadProperties;
        properties = {};
      }
      properties = { ...(properties || {}), bypassCache: true };
      return completion === undefined
        ? originalReload(tabId, properties)
        : originalReload(tabId, properties, completion);
    };
  }

  globalThis.__chatgptNotifierPageRuntimeCompatBackground = Object.freeze({
    version: 2,
    pageCompatFile: PAGE_COMPAT_FILE,
    hardReloads: true
  });
})();
