'use strict';

(() => {
  const RUNTIME_VERSION = 3;
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const FALLBACK_SELECTOR = [
    '[role="alert"]',
    '[role="status"]',
    '[aria-live]',
    '[data-testid*="error" i]',
    '[data-testid*="warning" i]',
    '[data-testid*="retry" i]',
    '[data-testid*="system" i]',
    'main div[class]',
    'main span[class]',
    'main p[class]',
    'main button'
  ].join(',');
  const EXCLUDED_FALLBACK_SELECTOR = [
    'pre', 'code', 'blockquote', '.markdown', '[class*="prose"]',
    '[data-message-author-role]', '[data-tool]', '[data-testid*="tool" i]',
    'form', '[contenteditable="true"]', '[data-chatgpt-notifier-owned]'
  ].join(',');
  const MAX_FALLBACK_NODES = 512;
  const MAX_FALLBACK_TEXT = 420;

  try { globalThis.__chatgptNotifierRecoveryLiveContent?.dispose?.(); } catch {}

  let observer = null;
  let publishTimer = null;
  let disposed = false;

  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function visible(node) {
    if (!node || node.isConnected === false) return false;
    try {
      if (node.hidden === true || node.closest?.('[hidden], [aria-hidden="true"]')) return false;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0')) return false;
      const rect = node.getBoundingClientRect?.();
      if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
    } catch {}
    return true;
  }

  function interruptionFromText(textValue) {
    const text = normalize(textValue).toLowerCase();
    if (!text) return null;
    const patterns = [
      ['connection-interrupted', /connection interrupted|stream interrupted|response interrupted|network error|connection lost|disconnected|failed to connect/],
      ['systems-taking-longer', /our systems? (?:are )?(?:taking longer|busy|experiencing|under (?:heavy )?load|at capacity|temporarily unavailable)|systems? (?:are )?taking longer|taking longer than expected|high demand|service temporarily unavailable/],
      ['timed-out', /(?:message|response|request|generation)?\s*(?:delivery\s*)?(?:timed out|timeout)|took too long|taking too long/],
      ['generation-error', /failed to (?:generate|respond|complete)|error (?:generating|while generating|during generation)|something went wrong|there was an error|unable to generate|could(?: not|n't) generate/]
    ];
    return patterns.find(([, pattern]) => pattern.test(text)) || null;
  }

  function fallbackApplicationState(base = {}, expected = {}) {
    const conversationId = String(base.conversationId || '');
    const documentId = String(base.documentId || '');
    const promptKey = String(base.promptKey || '');
    if (!conversationId || !documentId || !promptKey) return null;
    if (expected.conversationId && String(expected.conversationId) !== conversationId) return null;
    if (expected.documentId && String(expected.documentId) !== documentId) return null;
    if (expected.promptKey && String(expected.promptKey) !== promptKey) return null;

    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(FALLBACK_SELECTOR)).slice(-MAX_FALLBACK_NODES); } catch {}
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      if (!visible(node)) continue;
      try {
        if (node.closest?.(TURN_SELECTOR)) continue;
        if (node.closest?.(EXCLUDED_FALLBACK_SELECTOR)) continue;
      } catch { continue; }
      const text = normalize(node?.innerText || node?.textContent || '');
      if (!text || text.length > MAX_FALLBACK_TEXT) continue;

      const lower = text.toLowerCase();
      const rateLimited = /too many requests|rate limit|try again later/.test(lower);
      const authRequired = /session expired|please log in|please sign in|authentication required/.test(lower);
      const approvalRequired = /approval required|requires approval|approve this action/.test(lower);
      if (rateLimited || authRequired || approvalRequired) {
        return {
          explicitInterruption: false,
          interruptionKind: '',
          interruptionAttribution: '',
          rateLimited,
          authRequired,
          approvalRequired,
          conversationId,
          documentId,
          promptKey,
          applicationStateIdentityMatched: true,
          applicationStateReason: 'bounded-global-safety-state'
        };
      }

      const interruption = interruptionFromText(text);
      if (!interruption) continue;
      return {
        explicitInterruption: true,
        interruptionKind: interruption[0],
        interruptionAttribution: 'current-request-global',
        rateLimited: false,
        authRequired: false,
        approvalRequired: false,
        conversationId,
        documentId,
        promptKey,
        applicationStateIdentityMatched: true,
        applicationStateReason: 'bounded-global-interruption-fallback'
      };
    }
    return null;
  }

  function detectExplicitInterruption(expected = {}) {
    try {
      const monitor = globalThis.__chatgptNotifierMonitorRuntime;
      if (typeof monitor?.inspectCurrentRequestUi !== 'function') {
        return { explicitInterruption: false, interruptionKind: '', applicationStateIdentityMatched: false, applicationStateReason: 'monitor-classifier-unavailable' };
      }
      const result = monitor.inspectCurrentRequestUi(expected) || {};
      const primary = {
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
      if (primary.applicationStateIdentityMatched === false || primary.explicitInterruption || primary.rateLimited || primary.authRequired || primary.approvalRequired) return primary;

      let base = null;
      try { base = monitor.snapshot?.() || null; } catch {}
      const fallback = fallbackApplicationState(base || primary, expected);
      return fallback || primary;
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
    fallbackApplicationState,
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
