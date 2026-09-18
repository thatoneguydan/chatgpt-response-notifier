'use strict';

(() => {
  if (globalThis.__chatgptNotifierCrossDesktopClickFallback) return;

  const originalFocusOrOpenConversation = globalThis.focusOrOpenConversation;
  if (typeof originalFocusOrOpenConversation !== 'function') {
    throw new Error('Cross-desktop click verifier could not find primary click navigation.');
  }

  const PROBE_TIMEOUT_MS = 300;
  const VERIFY_ATTEMPTS = 6;
  const VERIFY_DELAY_MS = 100;
  const CLICK_DEADLINE_MS = 3500;
  const MOVE_DEADLINE_MS = 3500;

  const sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));

  function emit(status, context = {}) {
    try { globalThis.emitClickDiagnostic?.(status, context); } catch {}
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

  function bounded(promise, timeoutMs, fallback) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(fallback);
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
        resolve(fallback);
      });
    });
  }

  async function pageFocusSnapshot(tabId) {
    if (!Number.isInteger(tabId)) return { available: false, timedOut: false, visibility: '', hasFocus: false };
    const fallback = { available: false, timedOut: true, visibility: '', hasFocus: false };
    return await bounded((async () => {
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
          return { available: false, timedOut: false, visibility: '', hasFocus: false };
        }
        return {
          available: true,
          timedOut: false,
          visibility,
          hasFocus: value?.hasFocus === true
        };
      } catch {
        return { available: false, timedOut: false, visibility: '', hasFocus: false };
      }
    })(), PROBE_TIMEOUT_MS, fallback);
  }

  async function waitForPresentation(tabId) {
    let last = { available: false, timedOut: false, visibility: '', hasFocus: false };
    let sawAvailable = false;
    let sawTimeout = false;
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(VERIFY_DELAY_MS);
      last = await pageFocusSnapshot(tabId);
      sawAvailable ||= last.available === true;
      sawTimeout ||= last.timedOut === true;
      if (last.available && last.visibility === 'visible' && last.hasFocus) {
        return { ...last, sawAvailable, sawTimeout, attempts: attempt + 1, state: 'focused' };
      }
    }
    if (last.available && last.visibility === 'visible') {
      return { ...last, sawAvailable, sawTimeout, attempts: VERIFY_ATTEMPTS, state: 'visible-not-focused' };
    }
    if (last.available && last.visibility === 'hidden') {
      return { ...last, sawAvailable, sawTimeout, attempts: VERIFY_ATTEMPTS, state: 'other-desktop' };
    }
    return {
      ...last,
      sawAvailable,
      sawTimeout,
      attempts: VERIFY_ATTEMPTS,
      state: sawTimeout ? 'probe-timeout' : 'unverified'
    };
  }

  async function verifyPrimary(conversationId, conversationUrl, clickContext) {
    const primary = await bounded(
      originalFocusOrOpenConversation(conversationId, conversationUrl, clickContext),
      CLICK_DEADLINE_MS,
      { requested: false, presented: false, presentationState: 'route-timeout', reason: 'primary-route-timeout', targetTabId: clickContext?.targetTabId ?? null }
    );

    if (!primary || primary.requested !== true || !Number.isInteger(primary.targetTabId)) {
      const state = String(primary?.presentationState || 'unverified');
      emit('cross-desktop-click-unverified', {
        ...clickContext,
        conversationId,
        tabId: primary?.targetTabId,
        reason: String(primary?.reason || state)
      });
      return {
        ...(primary || {}),
        requested: primary?.requested === true,
        presented: false,
        presentationState: state,
        reason: String(primary?.reason || state)
      };
    }

    const current = await bounded(
      chrome.tabs.get(primary.targetTabId),
      PROBE_TIMEOUT_MS,
      null
    );
    if (!current || conversationIdFromUrl(current.url) !== conversationId) {
      emit('cross-desktop-click-target-changed', {
        ...clickContext,
        conversationId,
        tabId: primary.targetTabId,
        reason: 'target-identity-changed'
      });
      return { ...primary, presented: false, presentationState: 'target-changed', reason: 'target-identity-changed' };
    }

    const presentation = await waitForPresentation(primary.targetTabId);
    emit(`cross-desktop-click-${presentation.state}`, {
      ...clickContext,
      conversationId,
      tabId: primary.targetTabId,
      reason: presentation.state
    });
    return {
      ...primary,
      presented: presentation.state === 'focused',
      presentationState: presentation.state,
      reason: presentation.state,
      visibility: presentation.visibility,
      hasFocus: presentation.hasFocus === true
    };
  }

  globalThis.focusOrOpenConversation = async function focusOrOpenConversationWithVerifiedPresentation(
    conversationId,
    conversationUrl,
    clickContext = {}
  ) {
    return await bounded(
      verifyPrimary(conversationId, conversationUrl, clickContext),
      CLICK_DEADLINE_MS,
      {
        requested: false,
        presented: false,
        presentationState: 'route-timeout',
        reason: 'whole-click-timeout',
        targetTabId: Number.isInteger(clickContext?.targetTabId) ? clickContext.targetTabId : null
      }
    );
  };

  async function moveTabHere(conversationId, targetTabId, clickContext = {}) {
    if (!conversationId || !Number.isInteger(targetTabId)) {
      return { requested: false, presented: false, presentationState: 'invalid', reason: 'missing-target' };
    }

    const target = await bounded(chrome.tabs.get(targetTabId), PROBE_TIMEOUT_MS, null);
    if (!target || conversationIdFromUrl(target.url) !== conversationId) {
      emit('cross-desktop-move-target-changed', { ...clickContext, conversationId, tabId: targetTabId, reason: 'target-identity-changed' });
      return { requested: false, presented: false, presentationState: 'target-changed', reason: 'target-identity-changed', targetTabId };
    }

    const moved = await bounded(
      chrome.windows.create({ tabId: targetTabId, focused: true, type: 'normal' }),
      MOVE_DEADLINE_MS,
      null
    );
    if (!moved) {
      emit('cross-desktop-move-failed', { ...clickContext, conversationId, tabId: targetTabId, reason: 'chrome-window-move-failed' });
      return { requested: true, presented: false, presentationState: 'move-failed', reason: 'chrome-window-move-failed', targetTabId };
    }

    const presentation = await waitForPresentation(targetTabId);
    emit(`cross-desktop-move-${presentation.state}`, {
      ...clickContext,
      conversationId,
      tabId: targetTabId,
      reason: presentation.state
    });
    return {
      requested: true,
      presented: presentation.state === 'focused',
      presentationState: presentation.state,
      reason: presentation.state,
      targetTabId,
      targetWindowId: Number.isInteger(moved.id) ? moved.id : null
    };
  }

  globalThis.__chatgptNotifierCrossDesktopClickFallback = Object.freeze({
    version: 2,
    probeTimeoutMs: PROBE_TIMEOUT_MS,
    verifyAttempts: VERIFY_ATTEMPTS,
    verifyDelayMs: VERIFY_DELAY_MS,
    clickDeadlineMs: CLICK_DEADLINE_MS,
    moveDeadlineMs: MOVE_DEADLINE_MS,
    nativeForegroundUsed: false,
    automaticDuplicateWindowFallback: false,
    explicitMoveExistingTabFallback: true,
    originalFocusOrOpenConversation,
    conversationIdFromUrl,
    pageFocusSnapshot,
    waitForPresentation,
    moveTabHere
  });
})();
