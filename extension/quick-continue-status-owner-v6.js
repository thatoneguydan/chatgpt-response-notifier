'use strict';

(() => {
  const RUNTIME_VERSION = 6;
  const TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const FALLBACK_ID = 'chatgpt-notifier-countdown-fallback-v6';
  const LEGACY_FALLBACK_ID = 'chatgpt-notifier-countdown-fallback';
  const STYLE_ID = 'chatgpt-notifier-countdown-readability-v6';
  const CANONICAL_STATUS_SELECTOR = '[id^="chatgpt-notifier-countdown-v"], #chatgpt-notifier-automation-status';
  const OVERVIEW_REFRESH_MS = 2000;
  const VIEWPORT_MARGIN_PX = 8;
  const STATUS_WIDTH_PX = 200;
  const WATCHDOG_DELAY_MS = 30 * 60_000;
  const DUE_KICK_MIN_INTERVAL_MS = 750;

  const previous = globalThis.__chatgptNotifierQuickContinueStatusFallback;
  if (Number(previous?.version || 0) === RUNTIME_VERSION) {
    try { previous.refresh?.(); } catch {}
    return;
  }
  try { previous?.dispose?.(); } catch {}

  let disposed = false;
  let overview = null;
  let overviewIdentity = '';
  let highestStateRevision = -1;
  let highestWatchdogRevision = -1;
  let refreshTimer = null;
  let tickTimer = null;
  let busy = false;
  let dueKickInFlight = false;
  let lastDueKickAt = 0;
  let fallbackNode = null;

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
      'watchdog-runtime-unavailable': 'watchdog runtime',
      'continue-send-failed': 'send retry',
      'watchdog-runtime-unavailable': 'watchdog runtime'
    };
    const key = String(reason || '');
    if (!key) return '';
    return labels[key] || key.replace(/-/g, ' ');
  }

  function candidateIdentity(candidate) {
    const conversationId = String(candidate?.activeConversationId || '');
    if (conversationId) return `conversation:${conversationId}`;
    const tabId = Number.isInteger(candidate?.activeTabId) ? candidate.activeTabId : 'none';
    return `tab:${tabId}`;
  }

  function acceptOverview(candidateValue) {
    if (!candidateValue || typeof candidateValue !== 'object') return false;
    let candidate = candidateValue;
    const identity = candidateIdentity(candidate);
    const stateRevision = Math.max(0, Number(candidate.stateRevision || 0));
    const watchdogRevision = Math.max(0, Number(candidate?.codeWatchdog?.watchdogRevision || 0));

    if (identity !== overviewIdentity) {
      overviewIdentity = identity;
      highestStateRevision = -1;
      highestWatchdogRevision = -1;
      overview = null;
    }

    if (highestStateRevision >= 0 && stateRevision < highestStateRevision) return false;

    const automationTransition = overview
      && stateRevision > highestStateRevision
      && Boolean(overview.automationEnabled) !== Boolean(candidate.automationEnabled);
    if (automationTransition) highestWatchdogRevision = -1;

    if (candidate.automationEnabled === true && overview?.automationEnabled === true) {
      if (overview.codeWatchdog && !candidate.codeWatchdog) {
        candidate = { ...candidate, codeWatchdog: overview.codeWatchdog };
      } else if (candidate.codeWatchdog && highestWatchdogRevision >= 0 && watchdogRevision < highestWatchdogRevision) {
        candidate = { ...candidate, codeWatchdog: overview.codeWatchdog || candidate.codeWatchdog };
      }
    }

    const acceptedWatchdogRevision = Math.max(0, Number(candidate?.codeWatchdog?.watchdogRevision || 0));
    highestStateRevision = Math.max(highestStateRevision, stateRevision);
    if (candidate.automationEnabled === true && candidate.codeWatchdog) {
      highestWatchdogRevision = Math.max(highestWatchdogRevision, acceptedWatchdogRevision);
    } else if (candidate.automationEnabled !== true) {
      highestWatchdogRevision = -1;
    }

    overview = candidate;
    return true;
  }

  function watchdogPresentation(state = overview, now = Date.now()) {
    if (state?.automationEnabled !== true) return { text: '', due: false };
    const watchdog = state?.codeWatchdog || null;
    if (!watchdog) return { text: '', due: false };

    const maxSends = Math.max(1, Number(state?.codeWatchdogMaxSends || 3));
    const sendCount = Math.max(0, Number(watchdog?.sendCount || 0));
    const remaining = Math.max(0, maxSends - sendCount);
    const stopReason = String(watchdog?.stopReason || '');

    if (stopReason.startsWith('status:')) return { text: '', due: false };
    if (remaining <= 0 || (watchdog?.stopped === true && stopReason === 'retry-cap-reached')) {
      return { text: 'Auto-continues exhausted', due: false };
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
    if (manualOnlyDeadline || watchdog?.waitingForRequestStart === true) return { text: '', due: false };

    if (retryAt > Number(now)) {
      const label = waitingFor ? `Auto-continue blocked · ${waitingFor}` : 'Retrying auto-continue';
      return { text: `${label} · retry ${formatCountdown(retryAt - Number(now))} · ${remainingText}`, due: false };
    }

    if (deadlineAt > Number(now)) {
      return { text: `Next auto-continue ${formatCountdown(deadlineAt - Number(now))} · ${remainingText}`, due: false };
    }

    if ((deadlineAt > 0 && deadlineAt <= Number(now)) || (retryAt > 0 && retryAt <= Number(now))) {
      return { text: `Sending auto-continue… · ${remainingText}`, due: true };
    }

    if (watchdog?.stopped === true) return { text: `Auto-continue stopped · ${remainingText}`, due: false };
    return { text: '', due: false };
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
      #${TOOLBAR_ID} #chatgpt-notifier-automation-status,
      #${TOOLBAR_ID} #${LEGACY_FALLBACK_ID},
      #${TOOLBAR_ID} [id^="chatgpt-notifier-countdown-fallback-v"] {
        display: none !important;
      }
      #${TOOLBAR_ID} #${FALLBACK_ID}:not([hidden]) {
        display: block !important;
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

  function cleanupOldStatusNodes(toolbar) {
    if (!toolbar) return;
    for (const status of canonicalStatuses(toolbar)) {
      try {
        status.hidden = true;
        status.style?.setProperty?.('display', 'none', 'important');
      } catch {}
    }
    let oldNodes = [];
    try {
      oldNodes = Array.from(toolbar.querySelectorAll(`#${LEGACY_FALLBACK_ID}, [id^="chatgpt-notifier-countdown-fallback-v"]`));
    } catch {}
    for (const node of oldNodes) {
      if (node === fallbackNode) continue;
      try { node.hidden = true; } catch {}
      try { node.style?.setProperty?.('display', 'none', 'important'); } catch {}
    }
  }

  function ensureFallback(toolbar) {
    if (!toolbar) return null;
    if (fallbackNode?.isConnected && fallbackNode.parentElement === toolbar) return fallbackNode;

    let existing = null;
    try { existing = toolbar.querySelector(`#${FALLBACK_ID}`); } catch {}
    fallbackNode = existing || document.createElement('button');
    fallbackNode.id = FALLBACK_ID;
    fallbackNode.type = 'button';
    fallbackNode.hidden = true;
    fallbackNode.setAttribute('aria-label', 'Reset auto-continues remaining');
    Object.assign(fallbackNode.style, {
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
    if (!existing) {
      fallbackNode.addEventListener('click', resetBudget);
      toolbar.append(fallbackNode);
    }
    return fallbackNode;
  }

  async function kickDueWatchdog() {
    if (disposed || dueKickInFlight || overview?.automationEnabled !== true || !overview?.activeConversationId) return false;
    const now = Date.now();
    if (now - lastDueKickAt < DUE_KICK_MIN_INTERVAL_MS) return false;
    lastDueKickAt = now;
    dueKickInFlight = true;
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'RUN_CODE_WATCHDOG_NOW_V3',
        conversationId: overview.activeConversationId
      });
      if (result?.ok === true) acceptOverview(result);
      else await refreshOverview();
      return result?.ok === true;
    } catch {
      return false;
    } finally {
      dueKickInFlight = false;
      render();
    }
  }

  function render() {
    if (disposed) return;
    let toolbar = null;
    try { toolbar = document.getElementById(TOOLBAR_ID); } catch {}
    if (!toolbar) return;

    ensureReadabilityStyle();
    const fallback = ensureFallback(toolbar);
    cleanupOldStatusNodes(toolbar);
    if (!fallback) return;

    const presentation = watchdogPresentation();
    if (fallback.textContent !== presentation.text) fallback.textContent = presentation.text;
    fallback.hidden = !presentation.text;
    fallback.disabled = busy || overview?.automationEnabled !== true;
    fallback.style.cursor = fallback.disabled ? 'default' : 'pointer';
    applyViewportBounds(toolbar, fallback);
    if (presentation.due) kickDueWatchdog().catch(() => false);
  }

  async function refreshOverview() {
    if (disposed) return null;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'GET_BUILD_AUTOMATION_OVERVIEW_FOR_SENDER' });
      if (result?.ok === true) acceptOverview(result);
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
      if (result?.ok === true && String(result.requestId || '') === requestId) acceptOverview(result);
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
      acceptOverview(message.overview);
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
      try { fallbackNode?.remove?.(); } catch {}
      try { document.getElementById(STYLE_ID)?.remove(); } catch {}
      fallbackNode = null;
      if (globalThis.__chatgptNotifierQuickContinueStatusFallback === runtime) {
        delete globalThis.__chatgptNotifierQuickContinueStatusFallback;
      }
    }
  });
  globalThis.__chatgptNotifierQuickContinueStatusFallback = runtime;

  refreshOverview().catch(() => null);
  render();
})();
