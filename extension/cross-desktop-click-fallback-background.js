'use strict';

(() => {
  if (globalThis.__chatgptNotifierCrossDesktopClickFallback) return;

  const originalFocusOrOpenConversation = globalThis.focusOrOpenConversation;
  const presentExistingWindow = globalThis.__chatgptNotifierPresentExistingWindow;
  if (typeof originalFocusOrOpenConversation !== 'function') {
    throw new Error('Cross-desktop click verifier could not find primary click navigation.');
  }
  if (typeof presentExistingWindow !== 'function') {
    throw new Error('Cross-desktop click verifier could not find native desktop presentation.');
  }

  const PROBE_TIMEOUT_MS = 300;
  const VERIFY_ATTEMPTS = 6;
  const VERIFY_DELAY_MS = 100;
  const CLICK_DEADLINE_MS = 8000;

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

  async function exactTargetStillMatches(conversationId, targetTabId) {
    const current = await bounded(chrome.tabs.get(targetTabId), PROBE_TIMEOUT_MS, null);
    return Boolean(current && conversationIdFromUrl(current.url) === conversationId) ? current : null;
  }

  function failureState(reason) {
    switch (String(reason || '')) {
      case 'unsupported-windows-build': return 'desktop-switch-unsupported';
      case 'chrome-window-not-found': return 'desktop-window-not-found';
      case 'chrome-window-ambiguous': return 'desktop-window-ambiguous';
      case 'native-switch-timeout': return 'desktop-switch-timeout';
      case 'target-window-changed': return 'target-changed';
      default: return 'desktop-switch-failed';
    }
  }

  async function switchToExistingWindow(primary, conversationId, clickContext) {
    if (!Number.isInteger(primary?.targetTabId) || !Number.isInteger(primary?.targetWindowId)) {
      return { ...primary, presented: false, presentationState: 'desktop-switch-failed', reason: 'missing-window-identity' };
    }

    const before = await exactTargetStillMatches(conversationId, primary.targetTabId);
    if (!before || before.windowId !== primary.targetWindowId) {
      emit('cross-desktop-click-target-changed', {
        ...clickContext,
        conversationId,
        tabId: primary.targetTabId,
        reason: 'target-identity-changed-before-switch'
      });
      return { ...primary, presented: false, presentationState: 'target-changed', reason: 'target-identity-changed-before-switch' };
    }

    const nativeResult = await bounded(
      presentExistingWindow(primary.targetTabId, primary.targetWindowId, {
        ...clickContext,
        conversationId,
        targetTabId: primary.targetTabId
      }),
      3500,
      { success: false, reason: 'native-switch-timeout' }
    );

    if (nativeResult?.success !== true) {
      const reason = String(nativeResult?.reason || 'native-switch-failed');
      const state = failureState(reason);
      emit(`cross-desktop-click-${state}`, {
        ...clickContext,
        conversationId,
        tabId: primary.targetTabId,
        reason
      });
      return { ...primary, presented: false, presentationState: state, reason };
    }

    const after = await exactTargetStillMatches(conversationId, primary.targetTabId);
    if (!after || after.windowId !== primary.targetWindowId) {
      emit('cross-desktop-click-target-changed', {
        ...clickContext,
        conversationId,
        tabId: primary.targetTabId,
        reason: 'target-identity-changed-after-switch'
      });
      return { ...primary, presented: false, presentationState: 'target-changed', reason: 'target-identity-changed-after-switch' };
    }

    try { await bounded(chrome.tabs.update(primary.targetTabId, { active: true }), PROBE_TIMEOUT_MS, null); } catch {}
    try { await bounded(chrome.windows.update(primary.targetWindowId, { focused: true }), PROBE_TIMEOUT_MS, null); } catch {}

    const presentation = await waitForPresentation(primary.targetTabId);
    emit(`cross-desktop-click-after-switch-${presentation.state}`, {
      ...clickContext,
      conversationId,
      tabId: primary.targetTabId,
      reason: presentation.state
    });
    return {
      ...primary,
      presented: presentation.state === 'focused',
      presentationState: presentation.state === 'focused' ? 'focused' : 'desktop-switch-unverified',
      reason: presentation.state,
      visibility: presentation.visibility,
      hasFocus: presentation.hasFocus === true
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

    const current = await exactTargetStillMatches(conversationId, primary.targetTabId);
    if (!current) {
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

    if (presentation.state === 'other-desktop') {
      return await switchToExistingWindow(primary, conversationId, clickContext);
    }

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

  globalThis.__chatgptNotifierCrossDesktopClickFallback = Object.freeze({
    version: 3,
    probeTimeoutMs: PROBE_TIMEOUT_MS,
    verifyAttempts: VERIFY_ATTEMPTS,
    verifyDelayMs: VERIFY_DELAY_MS,
    clickDeadlineMs: CLICK_DEADLINE_MS,
    nativeDesktopSwitchUsed: true,
    automaticDuplicateWindowFallback: false,
    explicitMoveExistingTabFallback: false,
    originalFocusOrOpenConversation,
    conversationIdFromUrl,
    pageFocusSnapshot,
    waitForPresentation
  });
})();
