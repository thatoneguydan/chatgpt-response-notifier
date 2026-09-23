'use strict';

(() => {
  const RUNTIME_VERSION = 1;
  const AUTOMATION_UI_SELECTOR = '[data-chatgpt-notifier-automation-ui-owner]';
  const previousRuntime = globalThis.__chatgptNotifierAutomationRouteRefreshRuntime;
  if (Number(previousRuntime?.version || 0) === RUNTIME_VERSION) return;
  try { previousRuntime?.dispose?.(); } catch {}

  let activeConversationId = conversationIdFromUrl();
  let scheduled = false;
  let observer = null;

  function conversationIdFromUrl(rawUrl = location.href) {
    try {
      const url = new URL(String(rawUrl || ''), location.origin);
      const parts = url.pathname.split('/').filter(Boolean);
      for (let index = parts.length - 2; index >= 0; index -= 1) {
        if (parts[index] !== 'c') continue;
        const id = decodeURIComponent(parts[index + 1] || '').trim();
        if (id) return id;
      }
    } catch {}
    return '';
  }

  function invalidateAutomationUi() {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(AUTOMATION_UI_SELECTOR)); } catch {}
    for (const node of nodes) {
      try { node.remove(); } catch {}
    }
  }

  function syncRoute() {
    scheduled = false;
    const nextConversationId = conversationIdFromUrl();
    if (nextConversationId === activeConversationId) return;
    activeConversationId = nextConversationId;

    // Enrollment is already durable and keyed by conversation in the background.
    // Removing only notifier-owned state UI makes attachment-script recreate it
    // and perform a fresh sender-scoped overview read for the newly selected chat.
    invalidateAutomationUi();
  }

  function scheduleSync() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(syncRoute);
  }

  observer = new MutationObserver(scheduleSync);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', scheduleSync, true);
  window.addEventListener('hashchange', scheduleSync, true);
  try { globalThis.navigation?.addEventListener?.('navigatesuccess', scheduleSync); } catch {}

  globalThis.__chatgptNotifierAutomationRouteRefreshRuntime = Object.freeze({
    version: RUNTIME_VERSION,
    get activeConversationId() { return activeConversationId; },
    dispose() {
      try { observer?.disconnect(); } catch {}
      try { window.removeEventListener('popstate', scheduleSync, true); } catch {}
      try { window.removeEventListener('hashchange', scheduleSync, true); } catch {}
      try { globalThis.navigation?.removeEventListener?.('navigatesuccess', scheduleSync); } catch {}
    }
  });
})();
