'use strict';

(() => {
  for (const key of [
    '__chatgptQuickContinueRuntime',
    '__chatgptQuickContinueHoverEditRuntime',
    '__chatgptQuickContinueConversationStateRuntime'
  ]) {
    const runtime = globalThis[key];
    if (!runtime) continue;
    try { runtime.dispose?.(); } catch {}
    try { delete globalThis[key]; } catch {
      try { globalThis[key] = null; } catch {}
    }
  }
})();
