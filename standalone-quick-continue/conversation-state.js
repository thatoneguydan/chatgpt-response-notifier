'use strict';

(() => {
  const RUNTIME_VERSION = 1;
  const STORAGE_PREFIX = 'quick-continue:manual-timestamp:';
  const CLOCK_SELECTOR = '[aria-label="Current local time"]';
  const previousRuntime = globalThis.__chatgptQuickContinueConversationStateRuntime;
  if (Number(previousRuntime?.version || 0) === RUNTIME_VERSION) return;
  try { previousRuntime?.dispose?.(); } catch {}

  let activeConversationId = null;
  let desiredEnabled = false;
  let provisionalEnabled = false;
  let provisionalTouched = false;
  let restoreGeneration = 0;
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

  const storageKey = (conversationId) => `${STORAGE_PREFIX}${String(conversationId || '')}`;

  function currentEnabled() {
    try {
      const runtime = globalThis.__chatgptQuickContinueHoverEditRuntime;
      if (runtime && typeof runtime.manualTimestampEnabled === 'boolean') {
        return runtime.manualTimestampEnabled;
      }
    } catch {}
    try {
      return document.querySelector(CLOCK_SELECTOR)?.getAttribute('aria-pressed') === 'true';
    } catch {
      return false;
    }
  }

  function applyDesiredState() {
    const clock = document.querySelector(CLOCK_SELECTOR);
    if (!clock) return false;
    if (currentEnabled() === desiredEnabled) return true;
    try {
      clock.click();
      return currentEnabled() === desiredEnabled;
    } catch {
      return false;
    }
  }

  async function readStoredState(conversationId) {
    const key = storageKey(conversationId);
    const values = await chrome.storage.local.get(key);
    return {
      found: Object.prototype.hasOwnProperty.call(values || {}, key),
      enabled: values?.[key] === true
    };
  }

  async function writeStoredState(conversationId, enabled) {
    if (!conversationId) return;
    await chrome.storage.local.set({ [storageKey(conversationId)]: enabled === true });
  }

  async function restoreForConversation(nextConversationId, previousConversationId) {
    const generation = ++restoreGeneration;
    desiredEnabled = false;
    applyDesiredState();

    if (!nextConversationId) {
      provisionalEnabled = false;
      provisionalTouched = false;
      return;
    }

    let stored = { found: false, enabled: false };
    try { stored = await readStoredState(nextConversationId); } catch {}
    if (generation !== restoreGeneration || activeConversationId !== nextConversationId) return;

    if (stored.found) {
      desiredEnabled = stored.enabled;
      provisionalEnabled = stored.enabled;
      provisionalTouched = false;
      applyDesiredState();
      return;
    }

    if (!previousConversationId && provisionalTouched) {
      desiredEnabled = provisionalEnabled;
      try { await writeStoredState(nextConversationId, desiredEnabled); } catch {}
      if (generation !== restoreGeneration || activeConversationId !== nextConversationId) return;
      provisionalTouched = false;
      applyDesiredState();
      return;
    }

    desiredEnabled = false;
    provisionalEnabled = false;
    provisionalTouched = false;
    applyDesiredState();
  }

  function syncRouteAndToggle() {
    scheduled = false;
    const nextConversationId = conversationIdFromUrl();
    if (nextConversationId !== activeConversationId) {
      const previousConversationId = activeConversationId || '';
      activeConversationId = nextConversationId;
      restoreForConversation(nextConversationId, previousConversationId).catch(() => {});
    } else {
      applyDesiredState();
    }
  }

  function scheduleSync() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(syncRouteAndToggle);
  }

  function clockFromEvent(event) {
    const target = event?.target;
    if (!(target instanceof Element)) return null;
    try { return target.closest(CLOCK_SELECTOR); } catch { return null; }
  }

  function persistUserChoiceSoon(event) {
    if (event?.isTrusted !== true || !clockFromEvent(event)) return;
    setTimeout(() => {
      const enabled = currentEnabled();
      desiredEnabled = enabled;
      const conversationId = conversationIdFromUrl();
      activeConversationId = conversationId;
      if (conversationId) {
        provisionalTouched = false;
        writeStoredState(conversationId, enabled).catch(() => {});
      } else {
        provisionalEnabled = enabled;
        provisionalTouched = true;
      }
    }, 0);
  }

  function handleClockKeydown(event) {
    if (!['Enter', ' '].includes(event?.key)) return;
    persistUserChoiceSoon(event);
  }

  function handleStorageChanged(changes, areaName) {
    if (areaName !== 'local' || !activeConversationId) return;
    const key = storageKey(activeConversationId);
    if (!Object.prototype.hasOwnProperty.call(changes || {}, key)) return;
    desiredEnabled = changes[key]?.newValue === true;
    provisionalEnabled = desiredEnabled;
    provisionalTouched = false;
    applyDesiredState();
  }

  observer = new MutationObserver(scheduleSync);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('click', persistUserChoiceSoon, true);
  document.addEventListener('keydown', handleClockKeydown, true);
  window.addEventListener('popstate', scheduleSync, true);
  window.addEventListener('hashchange', scheduleSync, true);
  try { globalThis.navigation?.addEventListener?.('navigatesuccess', scheduleSync); } catch {}
  try { chrome.storage.onChanged.addListener(handleStorageChanged); } catch {}
  scheduleSync();

  globalThis.__chatgptQuickContinueConversationStateRuntime = Object.freeze({
    version: RUNTIME_VERSION,
    get activeConversationId() { return activeConversationId || ''; },
    get desiredEnabled() { return desiredEnabled; },
    dispose() {
      try { observer?.disconnect(); } catch {}
      try { document.removeEventListener('click', persistUserChoiceSoon, true); } catch {}
      try { document.removeEventListener('keydown', handleClockKeydown, true); } catch {}
      try { window.removeEventListener('popstate', scheduleSync, true); } catch {}
      try { window.removeEventListener('hashchange', scheduleSync, true); } catch {}
      try { globalThis.navigation?.removeEventListener?.('navigatesuccess', scheduleSync); } catch {}
      try { chrome.storage.onChanged.removeListener(handleStorageChanged); } catch {}
    }
  });
})();
