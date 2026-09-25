'use strict';

(() => {
  const RUNTIME_VERSION = 3;
  const TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const FALLBACK_ID = 'chatgpt-notifier-countdown-fallback';
  const STYLE_ID = 'chatgpt-notifier-countdown-readability-v3';
  const CANONICAL_STATUS_SELECTOR = '[id^="chatgpt-notifier-countdown-v"], #chatgpt-notifier-automation-status';
  const OVERVIEW_REFRESH_MS = 2000;
  const VIEWPORT_MARGIN_PX = 8;
  const STATUS_WIDTH_PX = 200;
  const WATCHDOG_DELAY_MS = 30 * 60_000;

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
    if (!watchdog) return '';

    const maxSends = Math.max(1, Number(state?.codeWatchdogMaxSends || 3));
    const sendCount = Math.max(0, Number(watchdog?.sendCount || 0));
    const remaining = Math.max(0, maxSends - sendCount);
    const stopReason = String(watchdog?.stopReason || '');

    if (stopReason.startsWith('status:')) return '';
    if (remaining <= 0 || (watchdog?.stopped === true && stopReason === 'retry-cap-reached')) {
      return 'Auto-continues exhausted';
    }

    const remainingText = `${remaining} left`;
    const deadlineAt = Math.max(0, Number(watchdog?.deadlineAt || 0));
    const retryAt = Math.max(0, Number(watchdog?.retryAt || 0));
    const waitingFor = holdText(watchdog?.retryReason);
    const manualActivatedAt = Math.max(0, Number(watchdog?.manualActivatedAt || 0));
    const requestStartedAt = Math.max(0, Number(watchdog?.lastRequestStartedAt || 0));
    const manualOnlyDeadline = manualActivatedAt > 0
      && requestStartedAt < manualActivatedAt
      && deadlineAt > 0
      && Math.abs(deadlineAt - (manualActivatedAt + WATCHDOG_DELAY_MS)) < 2500;
    if (manualOnlyDeadline || watchdog?.waitingForRequestStart === true) return '';

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
    return '';
  }

  function canonicalStatuses(toolbar) {
    try { return Array.from(toolbar?.querySelectorAll?.(CANONICAL_STATUS_SELECTOR) || []); } catch { return []; }
  }

  function ensureReadabilityStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).append(style);
    }
    const css = `
      #${TOOLBAR_ID} [id^="chatgpt-notifier-countdown-v"],
      #${TOOLBAR_ID} #chatgpt-notifier-automation-status {
        display: none !important;
      }
      #${TOOLBAR_ID} #${FALLBACK_ID} {
        position: absolute !important;
        right: auto !important;
        bottom: calc(100% + 4px) !important;
        padding: 3px 6px !important;
        border: 1px solid var(--border-light, rgba(0, 0, 0, 0.14)) !important;
        border-radius: 6px !important;
        background: var(--main-surface-primary, #fff) !important;
        color: var(--text-primary, var(--text-secondary, #666)) !important;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.14) !important;
        box-sizing: border-box !important;
        font-size: 10px !important;
        line-height: 1.25 !important;
        font-variant-numeric: tabular-nums !important;
        white-space: normal !important;
        overflow-wrap: normal !important;
        text-align: left !important;
      }
      #${TOOLBAR_ID}[data-chatgpt-notifier-last-status]::after {
        content: none !important;
        display: none !important;
      }
    `;
    if (style.textContent !== css) style.textContent = css;
    return style;
  }

  function applyViewportBounds(toolbar, node) {
    if (!toolbar || !node || node.hidden === true) return;
    let viewportWidth = 0;
    let toolbarLeft = 0;
    try {
      viewportWidth = Math.max(0, Number(window.innerWidth || document.documentElement?.clientWidth || 0));
      toolbarLeft = Number(toolbar.getBoundingClientRect?.().left || 0);
    } catch {}
    if (viewportWidth <= 0) return;

    const margin = VIEWPORT_MARGIN_PX;
    const statusWidth = Math.max(1, Math.min(STATUS_WIDTH_PX, viewportWidth - (margin * 2)));
    const maxViewportLeft = Math.max(margin, viewportWidth - statusWidth - margin);
    const viewportLeft = Math.min(Math.max(toolbarLeft, margin), maxViewportLeft);
    const leftOffset = viewportLeft - toolbarLeft;
    try {
      node.style.setProperty('left', `${leftOffset}px`, 'important');
      node.style.setProperty('width', `${statusWidth}px`, 'important');
      node.style.setProperty('max-width', `${statusWidth}px`, 'important');
    } catch {}
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
      width: `${STATUS_WIDTH_PX}px`,
      maxWidth: `${STATUS_WIDTH_PX}px`,
      padding: '3px 6px',
      border: '1px solid var(--border-light, rgba(0, 0, 0, 0.14))',
      borderRadius: '6px',
      background: 'var(--main-surface-primary, #fff)',
      color: 'var(--text-primary, var(--text-secondary, #666))',
      font: 'inherit',
      fontSize: '10px',
      lineHeight: '1.25',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'normal',
      pointerEvents: 'auto',
      cursor: 'pointer',
      opacity: '1',
      boxShadow: '0 1px 4px rgba(0, 0, 0, 0.14)',
      boxSizing: 'border-box',
      textAlign: 'left'
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

    ensureReadabilityStyle();
    for (const status of canonicalStatuses(toolbar)) {
      try { status.hidden = true; } catch {}
    }
    const fallback = ensureFallback(toolbar);
    if (!fallback) return;

    const text = statusText();
    if (fallback.textContent !== text) fallback.textContent = text;
    fallback.hidden = !text;
    fallback.disabled = busy || overview?.automationEnabled !== true;
    fallback.style.cursor = fallback.disabled ? 'default' : 'pointer';
    applyViewportBounds(toolbar, fallback);
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
    if (busy || overview?.automationEnabled !== true || !overview?.activeConversationId || !overview?.codeWatchdog) return;
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

  try { chrome.runtime.onMessage.addListener(handleRuntimeMessage); } catch {}
  try { window.addEventListener('resize', render); } catch {}
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
      try { if (refreshTimer !== null) clearInterval(refreshTimer); } catch {}
      try { if (tickTimer !== null) clearInterval(tickTimer); } catch {}
      try { chrome.runtime.onMessage.removeListener(handleRuntimeMessage); } catch {}
      try { window.removeEventListener('resize', render); } catch {}
      try { document.getElementById(FALLBACK_ID)?.remove(); } catch {}
      try { document.getElementById(STYLE_ID)?.remove(); } catch {}
      if (globalThis.__chatgptNotifierQuickContinueStatusFallback === runtime) {
        delete globalThis.__chatgptNotifierQuickContinueStatusFallback;
      }
    }
  });
  globalThis.__chatgptNotifierQuickContinueStatusFallback = runtime;

  refreshOverview().catch(() => null);
  render();
})();