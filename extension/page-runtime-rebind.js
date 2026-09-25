'use strict';

(() => {
  let extensionVersion = '';
  try { extensionVersion = String(chrome.runtime.getManifest().version || ''); } catch {}

  const previousVersion = String(globalThis.__chatgptNotifierPageRuntimeRebindVersion || '');
  if (previousVersion === extensionVersion && extensionVersion) return;

  const disposableRuntimeKeys = [
    '__chatgptNotifierAttachmentRuntime',
    '__chatgptNotifierMonitorRuntime',
    '__chatgptNotifierStatusRuntime',
    '__chatgptNotifierRenderedTerminalObserver',
    '__chatgptNotifierStreamStatusBridge',
    '__chatgptNotifierQuickContinueBridge',
    '__chatgptNotifierQuickContinueStatusFallback',
    '__chatgptNotifierWatchdogPageAuthorityV3'
  ];

  for (const key of disposableRuntimeKeys) {
    try { globalThis[key]?.dispose?.(); } catch {}
    try { delete globalThis[key]; } catch {}
  }

  // These legacy guards do not expose a disposer. They must be cleared once per
  // extension version so the new extension context can bind fresh listeners in
  // an already-open ChatGPT document after chrome.runtime.reload().
  globalThis.__chatgptPromptBoundNotifierInstalled = false;
  globalThis.__chatgptNotifierPersistenceInstalled = false;
  globalThis.__chatgptNotifierRecoveryInstalled = false;
  globalThis.__chatgptNotifierStatusDomInstalled = false;

  globalThis.__chatgptNotifierPageRuntimeRebindVersion = extensionVersion || `unknown:${Date.now()}`;
})();
