'use strict';

(() => {
  const RUNTIME_VERSION = 1;
  try { globalThis.__chatgptNotifierRecoveryLiveContent?.dispose?.(); } catch {}

  const abortController = new AbortController();
  let observer = null;
  let publishTimer = null;
  let disposed = false;

  const SEMANTIC_UI_SELECTOR = [
    '[role="alert"]',
    '[aria-live="assertive"]',
    '[data-testid="toast"]',
    '[data-testid*="error" i]',
    '[data-testid*="warning" i]',
    '[data-testid*="retry" i]',
    'button[aria-label*="retry" i]'
  ].join(', ');

  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

  function detectExplicitInterruption() {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(SEMANTIC_UI_SELECTOR)).slice(-24); } catch {}
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const text = normalize(nodes[index]?.innerText || nodes[index]?.textContent || '');
      if (!text) continue;
      if (/message delivery timed out|timed out|request timeout/.test(text)) return { explicitInterruption: true, interruptionKind: 'timed-out' };
      if (/connection interrupted|network error|connection lost/.test(text)) return { explicitInterruption: true, interruptionKind: 'connection-interrupted' };
      if (/systems? (?:are )?taking longer|taking longer than expected/.test(text)) return { explicitInterruption: true, interruptionKind: 'systems-taking-longer' };
      if (/failed to (?:generate|respond)|something went wrong|there was an error/.test(text)) return { explicitInterruption: true, interruptionKind: 'generation-error' };
    }
    return { explicitInterruption: false, interruptionKind: '' };
  }

  function augmentedSnapshot() {
    let base = null;
    try { base = globalThis.__chatgptNotifierMonitorRuntime?.snapshot?.() || null; } catch {}
    if (!base?.conversationId || !base?.promptKey) return base;
    const interruption = detectExplicitInterruption();
    return interruption.explicitInterruption ? { ...base, ...interruption } : base;
  }

  async function publishExplicitState() {
    if (disposed) return false;
    const snapshot = augmentedSnapshot();
    if (!snapshot?.explicitInterruption) return false;
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
      sendResponse?.({ ok: true, ...detectExplicitInterruption() });
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
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['role', 'aria-live', 'aria-label', 'data-testid'] });
  }
  setTimeout(() => publishExplicitState().catch(() => {}), 0);

  const runtime = {
    version: RUNTIME_VERSION,
    detectExplicitInterruption,
    augmentedSnapshot,
    publishExplicitState,
    dispose() {
      disposed = true;
      try { abortController.abort(); } catch {}
      try { chrome.runtime.onMessage.removeListener(messageListener); } catch {}
      try { observer?.disconnect(); } catch {}
      if (publishTimer !== null) clearTimeout(publishTimer);
      if (globalThis.__chatgptNotifierRecoveryLiveContent === runtime) delete globalThis.__chatgptNotifierRecoveryLiveContent;
    }
  };
  globalThis.__chatgptNotifierRecoveryLiveContent = runtime;
})();
