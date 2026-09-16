'use strict';

(() => {
  if (globalThis.__chatgptNotifierCrossDesktopClickFallback) return;

  const originalFocusOrOpenConversation = globalThis.focusOrOpenConversation;
  if (typeof originalFocusOrOpenConversation !== 'function') {
    throw new Error('Cross-desktop click fallback could not find primary click navigation.');
  }

  const VERIFY_ATTEMPTS = 8;
  const VERIFY_DELAY_MS = 100;

  const sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));

  function conversationIdFromUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''));
      if (url.hostname !== 'chatgpt.com' && url.hostname !== 'www.chatgpt.com') return '';
      const segments = url.pathname.split('/').filter(Boolean);
      for (let index = segments.length - 2; index >= 0; index -= 1) {
        if (segments[index] !== 'c') continue;
        return decodeURIComponent(segments[index + 1] || '').trim();
      }
    } catch {}
    return '';
  }

  function canonicalConversationUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''));
      const id = conversationIdFromUrl(url.href);
      if (!id) return '';
      return `https://chatgpt.com${url.pathname.replace(/\/+$/, '')}`;
    } catch {
      return '';
    }
  }

  function emit(status, context = {}) {
    try {
      if (typeof globalThis.emitClickDiagnostic === 'function') {
        globalThis.emitClickDiagnostic(status, context);
      }
    } catch {}
  }

  async function findConversationTab(conversationId) {
    if (!conversationId) return null;
    try {
      const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
      return tabs.find((tab) => conversationIdFromUrl(tab?.url) === conversationId && Number.isInteger(tab?.id)) || null;
    } catch {
      return null;
    }
  }

  async function pageFocusSnapshot(tabId) {
    if (!Number.isInteger(tabId)) return { available: false, visibility: '', hasFocus: false };
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({
          visibility: String(document.visibilityState || ''),
          hasFocus: document.hasFocus() === true
        })
      });
      const value = results?.[0]?.result;
      const visibility = String(value?.visibility || '');
      if (visibility !== 'visible' && visibility !== 'hidden') {
        return { available: false, visibility: '', hasFocus: false };
      }
      return {
        available: true,
        visibility,
        hasFocus: value?.hasFocus === true
      };
    } catch {
      return { available: false, visibility: '', hasFocus: false };
    }
  }

  async function waitForPresentation(tabId) {
    let last = { available: false, visibility: '', hasFocus: false };
    let sawAvailable = false;
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(VERIFY_DELAY_MS);
      last = await pageFocusSnapshot(tabId);
      if (last.available) sawAvailable = true;
      if (last.available && last.visibility === 'visible') {
        return { ...last, sawAvailable, attempts: attempt + 1 };
      }
    }
    return { ...last, sawAvailable, attempts: VERIFY_ATTEMPTS };
  }

  async function tabStillOwnsUserClick(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab?.active === true;
    } catch {
      return false;
    }
  }

  async function createCurrentDesktopFallback(conversationId, conversationUrl, clickContext, originalTabId) {
    const safeUrl = canonicalConversationUrl(conversationUrl);
    if (!safeUrl || conversationIdFromUrl(safeUrl) !== conversationId) {
      emit('cross-desktop-fallback-rejected', {
        ...clickContext,
        conversationId,
        tabId: originalTabId,
        reason: 'conversation-url-invalid'
      });
      return false;
    }

    try {
      const created = await chrome.windows.create({
        url: safeUrl,
        focused: true,
        type: 'normal'
      });
      emit('cross-desktop-fallback-window-created', {
        ...clickContext,
        conversationId,
        tabId: originalTabId
      });

      const windowId = Number.isInteger(created?.id) ? created.id : null;
      if (windowId === null) return true;

      let createdTabId = null;
      try {
        const tabs = await chrome.tabs.query({ windowId });
        const createdTab = tabs.find((tab) => conversationIdFromUrl(tab?.url) === conversationId) || tabs[0];
        if (Number.isInteger(createdTab?.id)) createdTabId = createdTab.id;
      } catch {}

      if (createdTabId === null) {
        emit('cross-desktop-fallback-unverified', {
          ...clickContext,
          conversationId,
          tabId: originalTabId,
          reason: 'created-tab-unavailable'
        });
        return true;
      }

      const presented = await waitForPresentation(createdTabId);
      emit(presented.available && presented.visibility === 'visible'
        ? 'cross-desktop-fallback-visible'
        : 'cross-desktop-fallback-unverified', {
        ...clickContext,
        conversationId,
        tabId: createdTabId,
        reason: presented.available ? presented.visibility : 'page-probe-unavailable'
      });
      return true;
    } catch {
      emit('cross-desktop-fallback-window-failed', {
        ...clickContext,
        conversationId,
        tabId: originalTabId,
        reason: 'chrome-window-create-failed'
      });
      return false;
    }
  }

  globalThis.focusOrOpenConversation = async function focusOrOpenConversationWithCrossDesktopFallback(
    conversationId,
    conversationUrl,
    clickContext = {}
  ) {
    const primaryResult = await originalFocusOrOpenConversation(conversationId, conversationUrl, clickContext);
    const target = await findConversationTab(conversationId);
    if (!target || !Number.isInteger(target.id)) return primaryResult;

    const presented = await waitForPresentation(target.id);
    if (presented.available && presented.visibility === 'visible') {
      emit('cross-desktop-focus-visible', {
        ...clickContext,
        conversationId,
        tabId: target.id,
        reason: presented.hasFocus ? 'focused' : 'visible'
      });
      return primaryResult;
    }

    if (!presented.sawAvailable) {
      emit('cross-desktop-focus-verification-unavailable', {
        ...clickContext,
        conversationId,
        tabId: target.id,
        reason: 'page-probe-unavailable'
      });
      return primaryResult;
    }

    if (presented.visibility !== 'hidden') return primaryResult;
    if (!await tabStillOwnsUserClick(target.id)) {
      emit('cross-desktop-fallback-suppressed', {
        ...clickContext,
        conversationId,
        tabId: target.id,
        reason: 'target-tab-no-longer-active'
      });
      return primaryResult;
    }

    emit('cross-desktop-focus-hidden', {
      ...clickContext,
      conversationId,
      tabId: target.id,
      reason: 'page-remained-hidden-after-focus'
    });

    const fallbackCreated = await createCurrentDesktopFallback(
      conversationId,
      conversationUrl,
      clickContext,
      target.id
    );
    return fallbackCreated || primaryResult;
  };

  globalThis.__chatgptNotifierCrossDesktopClickFallback = Object.freeze({
    version: 1,
    verifyAttempts: VERIFY_ATTEMPTS,
    verifyDelayMs: VERIFY_DELAY_MS,
    nativeForegroundUsed: false,
    originalFocusOrOpenConversation,
    conversationIdFromUrl,
    canonicalConversationUrl,
    pageFocusSnapshot,
    waitForPresentation
  });
})();
