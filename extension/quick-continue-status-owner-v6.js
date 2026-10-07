'use strict';

(() => {
  const RUNTIME_VERSION = 9;
  const TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const STATUS_OWNER_ATTR = 'data-chatgpt-notifier-watchdog-status-owner';
  const UI_OWNER_ATTR = 'data-chatgpt-notifier-watchdog-ui-owner';
  const STYLE_ID = 'chatgpt-notifier-retired-watchdog-status-style-v9';

  const previous = globalThis.__chatgptNotifierQuickContinueStatusFallback;
  if (Number(previous?.version || 0) === RUNTIME_VERSION) {
    try { previous.refresh?.(); } catch {}
    return;
  }
  try { previous?.dispose?.(); } catch {}

  let disposed = false;

  function removeRetiredRows() {
    for (const selector of [
      `#${TOOLBAR_ID} [${STATUS_OWNER_ATTR}]`,
      `#${TOOLBAR_ID} [id^="chatgpt-notifier-watchdog-status-v"]`,
      `#${TOOLBAR_ID} [id^="chatgpt-notifier-countdown-v"]`,
      `#${TOOLBAR_ID} #chatgpt-notifier-automation-status`,
      `#${TOOLBAR_ID} #chatgpt-notifier-countdown-fallback`,
      `#${TOOLBAR_ID} [id^="chatgpt-notifier-countdown-fallback-v"]`
    ]) {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(selector)); } catch {}
      for (const node of nodes) {
        try { node.remove(); } catch {}
      }
    }
    try { document.documentElement?.removeAttribute?.(UI_OWNER_ATTR); } catch {}
  }

  function ensureRetirementStyle() {
    for (const oldId of ['chatgpt-notifier-watchdog-status-style-v8']) {
      try { document.getElementById(oldId)?.remove(); } catch {}
    }
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).append(style);
    }
    const css = `
      #${TOOLBAR_ID} [${STATUS_OWNER_ATTR}],
      #${TOOLBAR_ID} [id^="chatgpt-notifier-watchdog-status-v"],
      #${TOOLBAR_ID} [id^="chatgpt-notifier-countdown-v"],
      #${TOOLBAR_ID} #chatgpt-notifier-automation-status,
      #${TOOLBAR_ID} #chatgpt-notifier-countdown-fallback,
      #${TOOLBAR_ID} [id^="chatgpt-notifier-countdown-fallback-v"] {
        display: none !important;
      }
    `;
    if (style.textContent !== css) style.textContent = css;
  }

  function refresh() {
    if (disposed) return;
    ensureRetirementStyle();
    removeRetiredRows();
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type !== 'CHATGPT_NOTIFIER_QUICK_STATUS_PING') return false;
    sendResponse?.({ ok: true, runtimeVersion: RUNTIME_VERSION });
    return false;
  }

  try { chrome.runtime.onMessage.addListener(handleRuntimeMessage); } catch {}

  const runtime = Object.freeze({
    version: RUNTIME_VERSION,
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      try { chrome.runtime.onMessage.removeListener(handleRuntimeMessage); } catch {}
      try { removeRetiredRows(); } catch {}
      if (globalThis.__chatgptNotifierQuickContinueStatusFallback === runtime) {
        delete globalThis.__chatgptNotifierQuickContinueStatusFallback;
      }
    }
  });

  globalThis.__chatgptNotifierQuickContinueStatusFallback = runtime;
  refresh();
})();
