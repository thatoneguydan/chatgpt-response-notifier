'use strict';

(() => {
  if (globalThis.__chatgptNotifierPageRuntimeCompatBackground) return;

  const NEEDS_PAGE_COMPAT = new Set([
    'attachment-script.js',
    'monitor-script.js',
    'bounded-recovery-script.js',
    'status-script.js',
    'recovery-script.js',
    'recovery-live-fix-content.js'
  ]);
  const PAGE_COMPAT_FILE = 'page-dom-compat.js';
  const PAGE_COMPAT_REGISTRATION_ID = 'chatgpt-notifier-page-dom-compat-v1';
  const PAGE_COMPAT_MATCHES = ['https://chatgpt.com/*'];

  const originalExecuteScript = chrome.scripting?.executeScript?.bind(chrome.scripting);
  const originalReload = chrome.tabs?.reload?.bind(chrome.tabs);

  async function ensurePersistentPageCompat() {
    const scripting = chrome.scripting;
    if (!scripting?.registerContentScripts) return false;
    try {
      if (typeof scripting.getRegisteredContentScripts === 'function') {
        const existing = await scripting.getRegisteredContentScripts({ ids: [PAGE_COMPAT_REGISTRATION_ID] });
        if (Array.isArray(existing) && existing.some((item) => item?.id === PAGE_COMPAT_REGISTRATION_ID)) return true;
      }
      await scripting.registerContentScripts([{
        id: PAGE_COMPAT_REGISTRATION_ID,
        matches: PAGE_COMPAT_MATCHES,
        js: [PAGE_COMPAT_FILE],
        runAt: 'document_start',
        allFrames: false,
        persistAcrossSessions: true
      }]);
      return true;
    } catch {
      if (typeof scripting.getRegisteredContentScripts === 'function') {
        try {
          const existing = await scripting.getRegisteredContentScripts({ ids: [PAGE_COMPAT_REGISTRATION_ID] });
          return Array.isArray(existing) && existing.some((item) => item?.id === PAGE_COMPAT_REGISTRATION_ID);
        } catch {}
      }
      return false;
    }
  }

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

  const registrationPromise = ensurePersistentPageCompat();

  globalThis.__chatgptNotifierPageRuntimeCompatBackground = Object.freeze({
    version: 2,
    pageCompatFile: PAGE_COMPAT_FILE,
    pageCompatRegistrationId: PAGE_COMPAT_REGISTRATION_ID,
    hardReloads: true,
    registrationPromise
  });
})();
