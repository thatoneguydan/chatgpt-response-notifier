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

  const oldHeartbeat = globalThis.__chatgptNotifierActivationHeartbeat;
  if (oldHeartbeat?.timerId) {
    try { clearInterval(oldHeartbeat.timerId); } catch {}
  }
  if (oldHeartbeat?.initialTimerId) {
    try { clearTimeout(oldHeartbeat.initialTimerId); } catch {}
  }

  let timerId = null;
  let initialTimerId = null;
  const pingHelperVersion = () => {
    try {
      chrome.runtime.sendMessage({ type: 'PING_NATIVE_HOST', source: 'activation-heartbeat' }, () => {
        try { void chrome.runtime.lastError; } catch {}
      });
    } catch {
      if (timerId !== null) {
        try { clearInterval(timerId); } catch {}
        timerId = null;
      }
    }
  };

  // This does not activate or foreground the page. It only wakes the extension
  // worker so an already-open tab can help an old runtime discover that Setup
  // installed a newer manifest/helper version. Once per 30 seconds is enough to
  // close the sleeping-worker gap without polling ChatGPT or creating web traffic.
  initialTimerId = setTimeout(pingHelperVersion, 2000);
  timerId = setInterval(pingHelperVersion, 30000);
  globalThis.__chatgptNotifierActivationHeartbeat = {
    version: 1,
    extensionVersion,
    timerId,
    initialTimerId
  };

  globalThis.__chatgptNotifierAttachmentRuntime = Object.freeze({
    version: 2,
    extensionVersion
  });
})();
