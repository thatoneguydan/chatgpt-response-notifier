'use strict';

(() => {
  const RUNTIME_VERSION = 1;
  const TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const FALLBACK_ID = 'chatgpt-notifier-countdown-fallback';
  const CANONICAL_STATUS_SELECTOR = '[id^="chatgpt-notifier-countdown-v"], #chatgpt-notifier-automation-status';
  const OVERVIEW_REFRESH_MS = 2000;

  const previous = globalThis.__chatgptNotifierQuickContinueStatusFallback;
  if (Number(previous?.version || 0) === RUNTIME_VERSION) {
    try { previous.refresh?.(); } catch {}
    return;
  }
  try { previous?.dispose?.(); } catch {}

  let disposed = false;
  let overview = null;
  let refreshTimer = null;
  let tickTimer = null;
  let observer = null;
  let busy = false;

  function formatCountdown(milliseconds) {
    const seconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${minutes}:${String(remainder).padStart(2, '0')}`;
  }

  function holdText(reason) {
    const labels = {
      'page-unobservable': 'page observation',
      'page-unavailable': 'page availability',
      'runtime-unavailable': 'page runtime',
      'offline': 'connection',
      'auth-required': 'sign-in',
      'approval-required': 'approval',
      'rate-limited': 'rate-limit clearance',
      'draft-present': 'draft to clear',
      'upload-present': 'upload to clear',
      'application-state-identity-mismatch': 'current response identity',
      'watchdog-runtime-unavailable': 'watchdog runtime'
    };
    return labels[String(reason || '')] || '';
  }

  function statusText(state = overview, now = Date.now()) {
    if (state?.automationEnabled !== true) return '';
    const watchdog = state?.codeWatchdog || null;
    const maxSends = Math.max(1, Number(state?.codeWatchdogMaxSends || 3));
    const sendCount = Math.max(0, Number(watchdog?.sendCount || 0));
    const remaining = Math.max(0, maxSends - sendCount);

    if (remaining <= 0 || (watchdog?.stopped === true && String(watchdog?.stopReason || '') === 'retry-cap-reached')) {
      return 'Auto-continues exhausted';
    }

    const remainingText = `${remaining} left`;
    const deadlineAt = Math.max(0, Number(watchdog?.deadlineAt || 0));
    const retryAt = Math.max(0, Number(watchdog?.retryAt || 0));
    const waitingFor = holdText(watchdog?.retryReason);

    if (deadlineAt > 0) {
      if (deadlineAt <= Number(now)) {
        return waitingFor
          ? `Auto-continue due · waiting for ${waitingFor} · ${remainingText}`
          : `Auto-continue due · ${remainingText}`;
      }
      return `Next auto-continue ${formatCountdown(deadlineAt - Number(now))} · ${remainingText}`;
    }

    if (retryAt > Number(now)) {
      return `Retrying auto-continue ${formatCountdown(retryAt - Number(now))} · ${remainingText}`;
    }
    if (watchdog?.stopped === true) return `Auto-continue stopped · ${remainingText}`;
    return `Auto-continue waiting · ${remainingText}`;
  }

  function canonicalStatus(toolbar) {
    try { return toolbar?.querySelector?.(CANONICAL_STATUS_SELECTOR) || null; } catch { return null; }
  }

  function canonicalStatusVisible(toolbar) {
    const status = canonicalStatus(toolbar);
    if (!status || status.hidden === true) return false;
    const text = String(status.textContent || '').trim();
    if (!text) return false;
    try {
      const style = getComputedStyle(status);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    } catch {}
    return true;
  }

  function ensureFallback(toolbar) {
    if (!toolbar) return null;
    let fallback = document.getElementById(FALLBACK_ID);
    if (fallback && fallback.parentElement === toolbar) return fallback;
    try { fallback?.remove?.(); } catch {}

    fallback = document.createElement('button');
    fallback.id = FALLBACK_ID;
    fallback.type = 'button';
    fallback.hidden = true;
    fallback.setAttribute('aria-label', 'Reset auto-continues remaining');
    Object.assign(fallback.style, {
      position: 'absolute',
      left: '0',
      right: 'auto',
      bottom: 'calc(100% + 4px)',
      padding: '2px',
      border: '1px solid transparent',
      borderRadius: '5px',
      background: 'transparent',
      color: 'var(--text-secondary, #666)',
      font: 'inherit',
      fontSize: '9px',
      lineHeight: '1.2',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      pointerEvents: 'auto',
      cursor: 'pointer',
      opacity: '1',
      boxShadow: 'none',
      textAlign: 'left'
    });
    fallback.addEventListener('mouseenter', () => {
      if (!fallback.disabled) fallback.style.borderColor = 'currentColor';
    });
    fallback.addEventListener('mouseleave', () => {
      fallback.style.borderColor = 'transparent';
    });
    fallback.addEventListener('click', resetBudget);
    toolbar.append(fallback);
    return fallback;
  }

  function render() {
    if (disposed) return;
    let toolbar = null;
    try { toolbar = document.getElementById(TOOLBAR_ID); } catch {}
    if (!toolbar) return;

    const fallback = ensureFallback(toolbar);
    if (!fallback) return;
    if (canonicalStatusVisible(toolbar)) {
      fallback.hidden = true;
      return;
    }

    const text = statusText();
    fallback.textContent = text;
    fallback.hidden = !text;
    fallback.disabled = busy || overview?.automationEnabled !== true;
    fallback.style.cursor = fallback.disabled ? 'default' : 'pointer';
  }

  async function refreshOverview() {
    if (disposed) return null;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'GET_BUILD_AUTOMATION_OVERVIEW_FOR_SENDER' });
      if (result?.ok === true) overview = result;
    } catch {}
    render();
    return overview;
  }

  async function resetBudget(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (busy || overview?.automationEnabled !== true || !overview?.activeConversationId) return;
    busy = true;
    render();
    try {
      const requestId = crypto.randomUUID();
      const result = await chrome.runtime.sendMessage({
        type: 'RESET_CODE_WATCHDOG_BUDGET_FOR_SENDER',
        conversationId: overview.activeConversationId,
        requestId
      });
      if (result?.ok === true && String(result.requestId || '') === requestId) overview = result;
      else await refreshOverview();
    } catch {}
    finally {
      busy = false;
      render();
    }
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type === 'CHATGPT_NOTIFIER_QUICK_STATUS_PING') {
      sendResponse?.({ ok: true, runtimeVersion: RUNTIME_VERSION });
      return false;
    }
    if (message?.type === 'BUILD_AUTOMATION_STATE_CHANGED' && message.overview) {
      overview = message.overview;
      render();
    }
    return false;
  }

  function handleMutations(records) {
    const fallback = document.getElementById(FALLBACK_ID);
    const meaningful = Array.from(records || []).some((record) => {
      const target = record?.target;
      if (!target) return false;
      if (target === fallback || fallback?.contains?.(target)) return false;
      return true;
    });
    if (meaningful) render();
  }

  try { chrome.runtime.onMessage.addListener(handleRuntimeMessage); } catch {}
  if (typeof MutationObserver === 'function') {
    observer = new MutationObserver(handleMutations);
    try { observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'style'] }); } catch {}
  }
  refreshTimer = setInterval(() => { refreshOverview().catch(() => null); }, OVERVIEW_REFRESH_MS);
  tickTimer = setInterval(render, 1000);

  const runtime = Object.freeze({
    version: RUNTIME_VERSION,
    refresh() {
      refreshOverview().catch(() => null);
      render();
    },
    dispose() {
      disposed = true;
      try { observer?.disconnect(); } catch {}
      try { if (refreshTimer !== null) clearInterval(refreshTimer); } catch {}
      try { if (tickTimer !== null) clearInterval(tickTimer); } catch {}
      try { chrome.runtime.onMessage.removeListener(handleRuntimeMessage); } catch {}
      try { document.getElementById(FALLBACK_ID)?.remove(); } catch {}
      if (globalThis.__chatgptNotifierQuickContinueStatusFallback === runtime) {
        delete globalThis.__chatgptNotifierQuickContinueStatusFallback;
      }
    }
  });
  globalThis.__chatgptNotifierQuickContinueStatusFallback = runtime;

  refreshOverview().catch(() => null);
  render();
})();
