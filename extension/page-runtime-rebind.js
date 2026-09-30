'use strict';

(() => {
  const RUNTIME_GENERATION = 3;
  let extensionVersion = '';
  try { extensionVersion = String(chrome.runtime.getManifest().version || ''); } catch {}

  const previousVersion = String(globalThis.__chatgptNotifierPageRuntimeRebindVersion || '');
  const previousGeneration = Math.max(0, Number(globalThis.__chatgptNotifierPageRuntimeRebindGeneration || 0));
  if (previousVersion === extensionVersion && extensionVersion && previousGeneration === RUNTIME_GENERATION) return;

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

  // These legacy guards do not expose a disposer. Clear them whenever either
  // the installed extension version or this page-runtime generation advances,
  // so same-version candidate deployments cannot strand stale hot-tab code.
  globalThis.__chatgptPromptBoundNotifierInstalled = false;
  globalThis.__chatgptNotifierPersistenceInstalled = false;
  globalThis.__chatgptNotifierRecoveryInstalled = false;
  globalThis.__chatgptNotifierStatusDomInstalled = false;

  globalThis.__chatgptNotifierPageRuntimeRebindVersion = extensionVersion || `unknown:${Date.now()}`;
  globalThis.__chatgptNotifierPageRuntimeRebindGeneration = RUNTIME_GENERATION;
})();
