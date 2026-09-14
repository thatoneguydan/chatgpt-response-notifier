'use strict';

(() => {
  if (globalThis.__chatgptNotifierRuntimeIdentity) return;

  let extensionVersion = '';
  let runtimeId = '';
  try { extensionVersion = String(chrome.runtime.getManifest().version || ''); } catch {}
  try { runtimeId = crypto.randomUUID(); } catch { runtimeId = `${Date.now()}-${Math.random()}`; }

  function publish(status = 'worker-alive') {
    const diagnostic = {
      source: 'extension-runtime',
      status: String(status || 'worker-alive'),
      observedAt: new Date().toISOString(),
      extensionVersion,
      correlationId: runtimeId
    };
    try {
      if (typeof sendNative === 'function') return sendNative({ type: 'diagnostics.event', diagnostic });
    } catch {}
    return false;
  }

  const runtime = Object.freeze({
    version: 2,
    extensionVersion,
    runtimeId,
    publish
  });
  globalThis.__chatgptNotifierRuntimeIdentity = runtime;
  publish('worker-connected');
})();
