'use strict';

(() => {
  const RUNTIME_VERSION = 2;
  try { globalThis.__chatgptNotifierRecoveryLiveContent?.dispose?.(); } catch {}

  let observer = null;
  let publishTimer = null;
  let disposed = false;

  function detectExplicitInterruption(expected = {}) {
    try {
      const monitor = globalThis.__chatgptNotifierMonitorRuntime;
      if (typeof monitor?.inspectCurrentRequestUi !== 'function') {
        return { explicitInterruption: false, interruptionKind: '', applicationStateIdentityMatched: false, applicationStateReason: 'monitor-classifier-unavailable' };
      }
      const result = monitor.inspectCurrentRequestUi(expected) || {};
      return {
        explicitInterruption: result.explicitInterruption === true,
        interruptionKind: String(result.interruptionKind || ''),
        interruptionAttribution: String(result.interruptionAttribution || ''),
        rateLimited: result.rateLimited === true,
        authRequired: result.authRequired === true,
        approvalRequired: result.approvalRequired === true,
        conversationId: String(result.conversationId || ''),
        documentId: String(result.documentId || ''),
        promptKey: String(result.promptKey || ''),
        applicationStateIdentityMatched: result.applicationStateIdentityMatched !== false,
        applicationStateReason: String(result.applicationStateReason || '')
      };
    } catch {
      return { explicitInterruption: false, interruptionKind: '', applicationStateIdentityMatched: false, applicationStateReason: 'monitor-classifier-failed' };
    }
  }

  function augmentedSnapshot(expected = {}) {
    let base = null;
    try { base = globalThis.__chatgptNotifierMonitorRuntime?.snapshot?.() || null; } catch {}
    if (!base?.conversationId || !base?.promptKey) return base;
    const boundExpected = {
      conversationId: String(expected.conversationId || base.conversationId || ''),
      documentId: String(expected.documentId || base.documentId || ''),
      promptKey: String(expected.promptKey || base.promptKey || '')
    };
    const applicationState = detectExplicitInterruption(boundExpected);
    if (applicationState.applicationStateIdentityMatched === false) return base;
    return { ...base, ...applicationState };
  }

  async function publishExplicitState() {
    if (disposed) return false;
    const snapshot = augmentedSnapshot();
    if (!snapshot?.explicitInterruption && !snapshot?.rateLimited && !snapshot?.authRequired && !snapshot?.approvalRequired) return false;
    try {
      await chrome.runtime.sendMessage({ type: 'CHATGPT_MONITOR_STATE', snapshot });
      return true;
    } catch { return false; }
  }

  function schedulePublish() {
    if (disposed || publishTimer !== null) return;
    publishTimer = setTimeout(() => {
      publishTimer = null;
      publishExplicitState().catch(() => {});
    }, 60);
  }

  const messageListener = (message, _sender, sendResponse) => {
    if (message?.type === 'CHATGPT_RECOVERY_LIVE_PING') {
      sendResponse?.({ ok: true, runtimeVersion: RUNTIME_VERSION });
      return false;
    }
    if (message?.type === 'CHATGPT_RECOVERY_LIVE_INSPECT') {
      const expected = message?.expected && typeof message.expected === 'object' ? message.expected : {};
      sendResponse?.({ ok: true, ...detectExplicitInterruption(expected) });
      return false;
    }
    if (message?.type === 'CHATGPT_RECOVERY_LIVE_REPUBLISH') {
      publishExplicitState().then((published) => sendResponse?.({ ok: true, published }))
        .catch(() => sendResponse?.({ ok: false, published: false }));
      return true;
    }
    return false;
  };

  chrome.runtime.onMessage.addListener(messageListener);
  const root = document.documentElement || document.body;
  if (root && typeof MutationObserver === 'function') {
    observer = new MutationObserver(schedulePublish);
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['role', 'aria-live', 'aria-label', 'aria-hidden', 'hidden', 'data-testid', 'class', 'style'] });
  }
  setTimeout(() => publishExplicitState().catch(() => {}), 0);

  const runtime = {
    version: RUNTIME_VERSION,
    detectExplicitInterruption,
    augmentedSnapshot,
    publishExplicitState,
    dispose() {
      disposed = true;
      try { chrome.runtime.onMessage.removeListener(messageListener); } catch {}
      try { observer?.disconnect(); } catch {}
      if (publishTimer !== null) clearTimeout(publishTimer);
      if (globalThis.__chatgptNotifierRecoveryLiveContent === runtime) delete globalThis.__chatgptNotifierRecoveryLiveContent;
    }
  };
  globalThis.__chatgptNotifierRecoveryLiveContent = runtime;
})();
