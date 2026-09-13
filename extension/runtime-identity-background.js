'use strict';

(() => {
  if (globalThis.__chatgptNotifierRuntimeIdentity) return;

  let extensionVersion = '';
  let runtimeId = '';
  try { extensionVersion = String(chrome.runtime.getManifest().version || ''); } catch {}
  try { runtimeId = crypto.randomUUID(); } catch { runtimeId = `${Date.now()}-${Math.random()}`; }

  const diagnostic = {
    source: 'extension-runtime',
    status: 'worker-connected',
    observedAt: new Date().toISOString(),
    extensionVersion,
    correlationId: runtimeId
  };

  try {
    if (typeof sendNative === 'function') sendNative({ type: 'diagnostics.event', diagnostic });
  } catch {}

  globalThis.__chatgptNotifierRuntimeIdentity = Object.freeze({
    version: 1,
    extensionVersion,
    runtimeId
  });
})();
