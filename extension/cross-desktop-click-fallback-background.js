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
  const NATIVE_SWITCH_TIMEOUT_MS = 1600;

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

  function finiteWindowCoordinate(value) {
    return Number.isFinite(value) ? Math.round(value) : null;
  }

  function nativeFailurePresentationState(state) {
    const value = String(state || '');
    if (value === 'unsupported-build') return 'desktop-switch-unsupported';
    if (value === 'window-ambiguous') return 'desktop-switch-ambiguous';
    if (value === 'missing-window-identity' || value === 'window-not-found' || value === 'window-bounds-mismatch') {
      return 'desktop-switch-unverified';
    }
    return 'desktop-switch-failed';
  }

  async function requestNativeDesktopSwitch(tabId, windowId, clickContext = {}) {
    if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) {
      return { success: false, state: 'missing-window-identity', presentationState: 'desktop-switch-unverified' };
    }

    await sleep(75);
    const identity = await bounded((async () => {
      try {
        const [tabInfo, windowInfo] = await Promise.all([
          chrome.tabs.get(tabId),
          chrome.windows.get(windowId)
        ]);
        return {
          title: String(tabInfo?.title || '').trim(),
          left: finiteWindowCoordinate(windowInfo?.left),
          top: finiteWindowCoordinate(windowInfo?.top),
          width: finiteWindowCoordinate(windowInfo?.width),
          height: finiteWindowCoordinate(windowInfo?.height)
        };
      } catch {
        return null;
      }
    })(), PROBE_TIMEOUT_MS, null);

    if (
      !identity?.title ||
      identity.left === null ||
      identity.top === null ||
      identity.width === null ||
      identity.height === null
    ) {
      emit('cross-desktop-native-switch-unidentified', {
        ...clickContext,
        tabId,
        reason: 'missing-window-identity'
      });
      return { success: false, state: 'missing-window-identity', presentationState: 'desktop-switch-unverified' };
    }

    if (typeof globalThis.sendNativeRequest !== 'function') {
      emit('cross-desktop-native-switch-unavailable', {
        ...clickContext,
        tabId,
        reason: 'native-request-unavailable'
      });
      return { success: false, state: 'native-request-unavailable', presentationState: 'desktop-switch-failed' };
    }

    const response = await globalThis.sendNativeRequest({
      type: 'window.switchVirtualDesktop',
      windowTitle: identity.title,
      windowLeft: identity.left,
      windowTop: identity.top,
      windowWidth: identity.width,
      windowHeight: identity.height
    }, ['window.switchVirtualDesktopResult'], NATIVE_SWITCH_TIMEOUT_MS);

    const state = String(response?.switchState || (response?.success === true ? 'switched' : 'native-timeout'));
    const success = response?.success === true;
    emit(success ? 'cross-desktop-native-switch-complete' : 'cross-desktop-native-switch-failed', {
      ...clickContext,
      tabId,
      reason: state
    });
    return {
      success,
      state,
      presentationState: success ? 'desktop-switched' : nativeFailurePresentationState(state),
      osBuild: Number(response?.osBuild || 0),
      candidateCount: Number(response?.candidateCount || 0)
    };
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

    let presentation = await waitForPresentation(primary.targetTabId);
    emit(`cross-desktop-click-${presentation.state}`, {
      ...clickContext,
      conversationId,
      tabId: primary.targetTabId,
      reason: presentation.state
    });

    if (presentation.state === 'other-desktop') {
      const switched = await requestNativeDesktopSwitch(
        primary.targetTabId,
        primary.targetWindowId,
        { ...clickContext, conversationId, targetTabId: primary.targetTabId }
      );
      if (!switched.success) {
        return {
          ...primary,
          presented: false,
          presentationState: switched.presentationState,
          reason: switched.state,
          visibility: presentation.visibility,
          hasFocus: false
        };
      }

      if (Number.isInteger(primary.targetWindowId)) {
        await bounded((async () => {
          try {
            const windowInfo = await chrome.windows.get(primary.targetWindowId);
            if (windowInfo?.state === 'minimized') {
              await chrome.windows.update(primary.targetWindowId, { state: 'normal' });
            }
            await chrome.windows.update(primary.targetWindowId, { focused: true });
            return true;
          } catch {
            return false;
          }
        })(), PROBE_TIMEOUT_MS, false);
      }

      presentation = await waitForPresentation(primary.targetTabId);
      emit(`cross-desktop-post-switch-${presentation.state}`, {
        ...clickContext,
        conversationId,
        tabId: primary.targetTabId,
        reason: presentation.state
      });
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
    nativeSwitchTimeoutMs: NATIVE_SWITCH_TIMEOUT_MS,
    nativeForegroundUsed: false,
    nativeVirtualDesktopSwitchUsed: true,
    automaticDuplicateWindowFallback: false,
    explicitMoveExistingTabFallback: false,
    originalFocusOrOpenConversation,
    conversationIdFromUrl,
    pageFocusSnapshot,
    waitForPresentation,
    requestNativeDesktopSwitch
  });
})();
