'use strict';

(() => {
  const RUNTIME_VERSION = 3;
  const AUTOMATION_UI_SELECTOR = '[data-chatgpt-notifier-automation-ui-owner]';
  const previousRuntime = globalThis.__chatgptNotifierAutomationRouteRefreshRuntime;
  if (Number(previousRuntime?.version || 0) === RUNTIME_VERSION) return;
  try { previousRuntime?.dispose?.(); } catch {}

  let activeConversationId = conversationIdFromUrl();
  let scheduled = false;

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

  function refreshAutomationUi() {
    try { globalThis.__chatgptNotifierAttachmentRuntime?.refreshForRoute?.(); } catch {}
  }

  function syncRoute() {
    scheduled = false;
    const nextConversationId = conversationIdFromUrl();
    if (nextConversationId === activeConversationId) return;
    const previousConversationId = activeConversationId;
    activeConversationId = nextConversationId;

    const hadAutomationUi = (() => {
      try { return Boolean(document.querySelector(AUTOMATION_UI_SELECTOR)); } catch { return false; }
    })();

    // A brand-new chat starts without a conversation id. After the first send,
    // ChatGPT assigns /c/<id> while the already-rendered controls are still
    // present. Preserve that exact handoff. Coming from the homepage has no
    // automation UI, so it must take the normal refresh path instead.
    if (!previousConversationId && nextConversationId && hadAutomationUi) {
      refreshAutomationUi();
      return;
    }

    // Chat-to-chat and homepage-to-chat navigation must discard the prior
    // route's controls and force a fresh sender-scoped overview read.
    invalidateAutomationUi();
    refreshAutomationUi();
  }

  function scheduleSync() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(syncRoute);
  }

  // Route changes are navigation events, not editor-mutation events. Avoid a
  // document-wide MutationObserver here: it ran URL parsing on every keystroke.
  window.addEventListener('popstate', scheduleSync, true);
  window.addEventListener('hashchange', scheduleSync, true);
  try { globalThis.navigation?.addEventListener?.('navigatesuccess', scheduleSync); } catch {}

  globalThis.__chatgptNotifierAutomationRouteRefreshRuntime = Object.freeze({
    version: RUNTIME_VERSION,
    get activeConversationId() { return activeConversationId; },
    dispose() {
      try { window.removeEventListener('popstate', scheduleSync, true); } catch {}
      try { window.removeEventListener('hashchange', scheduleSync, true); } catch {}
      try { globalThis.navigation?.removeEventListener?.('navigatesuccess', scheduleSync); } catch {}
    }
  });
})();