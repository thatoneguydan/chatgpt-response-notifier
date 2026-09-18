'use strict';

(() => {
  if (globalThis.__chatgptNotifierCrossDesktopClickFallback) return;

  const originalFocusOrOpenConversation = globalThis.focusOrOpenConversation;
  if (typeof originalFocusOrOpenConversation !== 'function') {
    throw new Error('Cross-desktop click verification could not find primary click navigation.');
  }

  const VERIFY_ATTEMPTS = 5;
  const VERIFY_DELAY_MS = 125;
  const PROBE_TIMEOUT_MS = 750;
  const EXPLICIT_FALLBACK_VERIFY_TIMEOUT_MS = 2500;

  const sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));

  function bounded(promise, timeoutMs, timeoutValue) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(timeoutValue);
      }, Math.max(1, Number(timeoutMs || 1)));
      Promise.resolve(promise).then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(timeoutValue);
      });
    });
  }

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

  async function targetStillMatches(tabId, conversationId) {
    if (!Number.isInteger(tabId) || !conversationId) return false;
    const tab = await bounded(chrome.tabs.get(tabId), PROBE_TIMEOUT_MS, null);
    return conversationIdFromUrl(tab?.url) === conversationId;
  }

  async function pageFocusSnapshot(tabId) {
    if (!Number.isInteger(tabId)) return { available: false, visibility: '', hasFocus: false, reason: 'tab-missing' };
    const results = await bounded(chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        visibility: String(document.visibilityState || ''),
        hasFocus: document.hasFocus() === true
      })
    }), PROBE_TIMEOUT_MS, null);
    if (!results) return { available: false, visibility: '', hasFocus: false, reason: 'probe-timeout-or-error' };
    const value = results?.[0]?.result;
    const visibility = String(value?.visibility || '');
    if (visibility !== 'visible' && visibility !== 'hidden') {
      return { available: false, visibility: '', hasFocus: false, reason: 'probe-invalid' };
    }
    return {
      available: true,
      visibility,
      hasFocus: value?.hasFocus === true,
      reason: ''
    };
  }

  async function waitForPresentation(tabId, conversationId) {
    let last = { available: false, visibility: '', hasFocus: false, reason: 'not-observed' };
    let sawAvailable = false;
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(VERIFY_DELAY_MS);
      if (!await targetStillMatches(tabId, conversationId)) {
        return { ...last, sawAvailable, attempts: attempt + 1, targetMatched: false, reason: 'target-identity-changed' };
      }
      last = await pageFocusSnapshot(tabId);
      if (last.available) sawAvailable = true;
      if (last.available && last.visibility === 'visible') {
        return { ...last, sawAvailable, attempts: attempt + 1, targetMatched: true };
      }
    }
    return { ...last, sawAvailable, attempts: VERIFY_ATTEMPTS, targetMatched: true };
  }

  async function openCurrentDesktopCopy(conversationId, conversationUrl, clickContext = {}) {
    const safeUrl = canonicalConversationUrl(conversationUrl);
    if (!safeUrl || conversationIdFromUrl(safeUrl) !== conversationId) {
      emit('cross-desktop-explicit-copy-rejected', {
        ...clickContext,
        conversationId,
        reason: 'conversation-url-invalid'
      });
      return { requested: false, presented: false, outcome: 'invalid-conversation-url', tabId: null };
    }

    const created = await bounded(chrome.windows.create({
      url: safeUrl,
      focused: true,
      type: 'normal'
    }), PROBE_TIMEOUT_MS, null);
    if (!created || !Number.isInteger(created.id)) {
      emit('cross-desktop-explicit-copy-failed', {
        ...clickContext,
        conversationId,
        reason: 'chrome-window-create-failed'
      });
      return { requested: true, presented: false, outcome: 'copy-create-failed', tabId: null };
    }

    const tabs = await bounded(chrome.tabs.query({ windowId: created.id }), PROBE_TIMEOUT_MS, []);
    const createdTab = (Array.isArray(tabs) ? tabs : []).find((tab) => conversationIdFromUrl(tab?.url) === conversationId)
      || (Array.isArray(tabs) ? tabs[0] : null);
    const createdTabId = Number.isInteger(createdTab?.id) ? createdTab.id : null;
    if (createdTabId === null) {
      emit('cross-desktop-explicit-copy-unverified', {
        ...clickContext,
        conversationId,
        reason: 'created-tab-unavailable'
      });
      return { requested: true, presented: false, outcome: 'copy-unverified', tabId: null };
    }

    const presented = await bounded(
      waitForPresentation(createdTabId, conversationId),
      EXPLICIT_FALLBACK_VERIFY_TIMEOUT_MS,
      { available: false, visibility: '', hasFocus: false, targetMatched: true, reason: 'whole-copy-verification-timeout' }
    );
    const visible = presented?.available === true && presented.visibility === 'visible';
    emit(visible ? 'cross-desktop-explicit-copy-visible' : 'cross-desktop-explicit-copy-unverified', {
      ...clickContext,
      conversationId,
      tabId: createdTabId,
      reason: visible ? '' : String(presented?.reason || presented?.visibility || 'page-probe-unavailable')
    });
    return {
      requested: true,
      presented: visible,
      outcome: visible ? 'copy-visible' : 'copy-unverified',
      tabId: createdTabId
    };
  }

  globalThis.focusOrOpenConversation = async function focusOrOpenConversationWithCrossDesktopVerification(
    conversationId,
    conversationUrl,
    clickContext = {}
  ) {
    const primary = await originalFocusOrOpenConversation(conversationId, conversationUrl, clickContext);
    const targetTabId = Number.isInteger(primary?.tabId) ? primary.tabId : null;
    if (!primary?.requested || targetTabId === null) {
      emit('cross-desktop-focus-unverified', {
        ...clickContext,
        conversationId,
        reason: String(primary?.outcome || 'primary-target-unavailable')
      });
      return {
        requested: Boolean(primary?.requested),
        presented: false,
        outcome: String(primary?.outcome || 'primary-target-unavailable'),
        tabId: targetTabId,
        existing: primary?.existing === true
      };
    }

    const presented = await waitForPresentation(targetTabId, conversationId);
    if (presented.available && presented.visibility === 'visible') {
      emit('cross-desktop-focus-visible', {
        ...clickContext,
        conversationId,
        tabId: targetTabId,
        reason: presented.hasFocus ? 'focused' : 'visible'
      });
      return {
        requested: true,
        presented: true,
        outcome: presented.hasFocus ? 'focused' : 'visible',
        tabId: targetTabId,
        existing: primary.existing === true
      };
    }

    if (presented.targetMatched === false) {
      emit('cross-desktop-focus-target-changed', {
        ...clickContext,
        conversationId,
        tabId: targetTabId,
        reason: 'target-identity-changed'
      });
      return { requested: true, presented: false, outcome: 'target-identity-changed', tabId: targetTabId, existing: primary.existing === true };
    }

    if (!presented.sawAvailable) {
      emit('cross-desktop-focus-verification-unavailable', {
        ...clickContext,
        conversationId,
        tabId: targetTabId,
        reason: String(presented.reason || 'page-probe-unavailable')
      });
      return { requested: true, presented: false, outcome: 'verification-unavailable', tabId: targetTabId, existing: primary.existing === true };
    }

    if (presented.visibility === 'hidden' && primary.existing === true) {
      emit('cross-desktop-focus-hidden', {
        ...clickContext,
        conversationId,
        tabId: targetTabId,
        reason: 'existing-tab-remained-hidden'
      });
      return { requested: true, presented: false, outcome: 'hidden-cross-desktop', tabId: targetTabId, existing: true };
    }

    emit('cross-desktop-focus-unverified', {
      ...clickContext,
      conversationId,
      tabId: targetTabId,
      reason: String(presented.visibility || presented.reason || 'presentation-unverified')
    });
    return { requested: true, presented: false, outcome: 'presentation-unverified', tabId: targetTabId, existing: primary.existing === true };
  };

  globalThis.__chatgptNotifierCrossDesktopClickFallback = Object.freeze({
    version: 2,
    verifyAttempts: VERIFY_ATTEMPTS,
    verifyDelayMs: VERIFY_DELAY_MS,
    probeTimeoutMs: PROBE_TIMEOUT_MS,
    nativeForegroundUsed: false,
    automaticDuplicateWindowFallback: false,
    originalFocusOrOpenConversation,
    conversationIdFromUrl,
    canonicalConversationUrl,
    pageFocusSnapshot,
    waitForPresentation,
    openCurrentDesktopCopy
  });
})();
