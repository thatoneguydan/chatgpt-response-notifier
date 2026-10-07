'use strict';

(() => {
  const RESET_EVENT = 'chatgpt-quick-continue-runtime-reset';
  // DOM events reach surviving closures even when an extension reload replaces
  // its isolated-world globals. Retire those closures before building new UI.
  try { document.dispatchEvent(new Event(RESET_EVENT)); } catch {}
  const keys = [
    '__chatgptQuickContinueConversationStateRuntime',
    '__chatgptQuickContinueMonitorWatchdogRuntime',
    '__chatgptQuickContinueHoverEditRuntime',
    '__chatgptQuickContinueRuntime',
    'ChatGPTQuickContinueConfig',
    '__chatgptQuickContinueDomCompat'
  ];
  const runtimes = new Set();
  function retire() {
    for (const runtime of runtimes) { try { runtime.dispose?.(); } catch {} }
    runtimes.clear();
    for (const key of keys) {
      const runtime = globalThis[key];
      if (!runtime) continue;
      try { runtime.dispose?.(); } catch {}
      try { delete globalThis[key]; } catch {
        try { globalThis[key] = null; } catch {}
      }
    }
    try { document.removeEventListener(RESET_EVENT, retire); } catch {}
  }
  retire();
  document.addEventListener(RESET_EVENT, retire);
  globalThis.__chatgptQuickContinueLifecycle = Object.freeze({
    register(runtime) { runtimes.add(runtime); },
    dispose: retire
  });
})();
