'use strict';

(() => {
  let extensionVersion = '';
  try { extensionVersion = String(chrome.runtime.getManifest().version || ''); } catch {}

  const previous = globalThis.__chatgptNotifierAttachmentRuntime;
  const runtimeChanged = !previous || String(previous.extensionVersion || '') !== extensionVersion;
  if (runtimeChanged) {
    // Extension reload/update invalidates old runtime listeners but Chrome may
    // retain isolated-world globals for an already-open document. Reset only
    // stale installation guards so the unchanged upstream detector and local
    // listeners can attach to the new runtime without reloading/activating tab.
    globalThis.__chatgptPromptBoundNotifierInstalled = false;
    globalThis.__chatgptNotifierPersistenceInstalled = false;
    globalThis.__chatgptNotifierRecoveryInstalled = false;
    globalThis.__chatgptNotifierStatusDomInstalled = false;
  }

  globalThis.__chatgptNotifierAttachmentRuntime = Object.freeze({
    version: 1,
    extensionVersion
  });
})();
