'use strict';

(() => {
  const RUNTIME_VERSION = 9;
  const STATUS_OWNER_ATTR = 'data-chatgpt-notifier-watchdog-status-owner';
  const UI_OWNER_ATTR = 'data-chatgpt-notifier-watchdog-ui-owner';
  const previous = globalThis.__chatgptNotifierQuickContinueStatusFallback;
  if (Number(previous?.version || 0) === RUNTIME_VERSION) return;
  try { previous?.dispose?.(); } catch {}

  let disposed = false;

  function removeLegacyWatchdogUi() {
    try {
      for (const node of document.querySelectorAll(`[${STATUS_OWNER_ATTR}], [id^="chatgpt-notifier-countdown-v"], #chatgpt-notifier-automation-status, #chatgpt-notifier-countdown-fallback, [id^="chatgpt-notifier-countdown-fallback-v"]`)) {
        node.remove();
      }
      document.documentElement?.removeAttribute?.(UI_OWNER_ATTR);
    } catch {}
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type !== 'CHATGPT_NOTIFIER_QUICK_STATUS_PING') return false;
    sendResponse?.({ ok: true, runtimeVersion: RUNTIME_VERSION, legacyWatchdogRetired: true });
    return false;
  }

  removeLegacyWatchdogUi();
  try { chrome.runtime.onMessage.addListener(handleRuntimeMessage); } catch {}

  const runtime = Object.freeze({
    version: RUNTIME_VERSION,
    legacyWatchdogRetired: true,
    refresh() { removeLegacyWatchdogUi(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { chrome.runtime.onMessage.removeListener(handleRuntimeMessage); } catch {}
      removeLegacyWatchdogUi();
      if (globalThis.__chatgptNotifierQuickContinueStatusFallback === runtime) {
        delete globalThis.__chatgptNotifierQuickContinueStatusFallback;
      }
    }
  });

  globalThis.__chatgptNotifierQuickContinueStatusFallback = runtime;
})();
