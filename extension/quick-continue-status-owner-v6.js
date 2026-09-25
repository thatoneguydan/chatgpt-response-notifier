'use strict';

(() => {
  const RUNTIME_VERSION = 7;
  const TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const STATUS_ID = 'chatgpt-notifier-countdown-fallback-v7';
  const STYLE_ID = 'chatgpt-notifier-countdown-style-v7';
  const OVERVIEW_REFRESH_MS = 2000;
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
  let row = null;
  let resetButton = null;
  let stopButton = null;

  function formatCountdown(milliseconds) {
    const seconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
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
      'continue-send-failed': 'send retry'
    };
    const key = String(reason || '');
    return key ? (labels[key] || key.replace(/-/g, ' ')) : '';
  }

  function candidateIdentity(value) {
    const id = String(value?.activeConversationId || '');
    return id ? `conversation:${id}` : `tab:${Number.isInteger(value?.activeTabId) ? value.activeTabId : 'none'}`;
  }

  function acceptOverview(value) {
    if (!value || typeof value !== 'object') return false;
    let candidate = value;
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
    const automationTransition = overview && stateRevision > highestStateRevision
      && Boolean(overview.automationEnabled) !== Boolean(candidate.automationEnabled);
    if (automationTransition) highestWatchdogRevision = -1;
    if (candidate.automationEnabled === true && overview?.automationEnabled === true) {
      if (overview.codeWatchdog && !candidate.codeWatchdog) {
        candidate = { ...candidate, codeWatchdog: overview.codeWatchdog };
      } else if (candidate.codeWatchdog && highestWatchdogRevision >= 0 && watchdogRevision < highestWatchdogRevision) {
        candidate = { ...candidate, codeWatchdog: overview.codeWatchdog || candidate.codeWatchdog };
      }
    }
    highestStateRevision = Math.max(highestStateRevision, stateRevision);
    if (candidate.automationEnabled === true && candidate.codeWatchdog) {
      highestWatchdogRevision = Math.max(highestWatchdogRevision, Number(candidate.codeWatchdog.watchdogRevision || 0));
    } else if (candidate.automationEnabled !== true) {
      highestWatchdogRevision = -1;
    }
    overview = candidate;
    return true;
  }

  function presentation(state = overview, now = Date.now()) {
    const watchdog = state?.automationEnabled === true ? state?.codeWatchdog : null;
    if (!watchdog) return { text: '', active: false, due: false };
    const maxSends = Math.max(1, Number(state?.codeWatchdogMaxSends || 3));
    const remaining = Math.max(0, maxSends - Math.max(0, Number(watchdog.sendCount || 0)));
    const stopReason = String(watchdog.stopReason || '');
    if (stopReason.startsWith('status:')) return { text: '', active: false, due: false };
    if (remaining <= 0 || stopReason === 'retry-cap-reached') {
      return { text: 'Auto-continues exhausted', active: false, due: false };
    }
    const left = `${remaining} left`;
    if (watchdog.stopped === true) return { text: `Timer stopped · ${left}`, active: false, due: false };
    const deadlineAt = Math.max(0, Number(watchdog.deadlineAt || 0));
    const retryAt = Math.max(0, Number(watchdog.retryAt || 0));
    const activatedAt = Math.max(0, Number(watchdog.manualActivatedAt || 0));
    const startedAt = Math.max(0, Number(watchdog.lastRequestStartedAt || 0));
    const manualOnly = activatedAt > 0 && startedAt < activatedAt && deadlineAt > 0
      && Math.abs(deadlineAt - (activatedAt + WATCHDOG_DELAY_MS)) < 2500;
    if (manualOnly || watchdog.waitingForRequestStart === true) return { text: '', active: false, due: false };
    if (retryAt > now) {
      const waitingFor = holdText(watchdog.retryReason);
      const label = waitingFor ? `Auto-continue blocked · ${waitingFor}` : 'Retrying auto-continue';
      return { text: `${label} · retry ${formatCountdown(retryAt - now)} · ${left}`, active: true, due: false };
    }
    if (deadlineAt > now) {
      return { text: `Next auto-continue ${formatCountdown(deadlineAt - now)} · ${left}`, active: true, due: false };
    }
    if ((deadlineAt > 0 && deadlineAt <= now) || (retryAt > 0 && retryAt <= now)) {
      return { text: `Sending auto-continue… · ${left}`, active: true, due: true };
    }
    return { text: '', active: false, due: false };
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${TOOLBAR_ID} #${STATUS_ID}:not([hidden]) {
        display: flex;
        position: absolute;
        box-sizing: border-box;
        width: calc(100% + 2px);
        max-width: calc(100% + 2px);
        left: -1px;
        bottom: calc(100% + 4px);
        align-items: flex-start;
        gap: 3px;
        padding: 3px 4px;
        border: 1px solid var(--border-light, rgba(0, 0, 0, .14));
        border-radius: 6px;
        background: var(--main-surface-primary, #fff);
        color: #111;
        box-shadow: 0 1px 4px rgba(0, 0, 0, .14);
        font-size: 11px;
        line-height: 1.25;
        white-space: normal;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      #${STATUS_ID} button {
        color: inherit;
        font: inherit;
        line-height: inherit;
        background: transparent;
        border: 0;
        border-radius: 3px;
        padding: 0 2px;
        cursor: pointer;
      }
      #${STATUS_ID} button:disabled { cursor: default; }
      #${STATUS_ID} button:focus-visible { outline: 1px solid currentColor; }
      #${STATUS_ID} .chatgpt-notifier-timer-text {
        flex: 1 1 auto;
        min-width: 0;
        max-width: 100%;
        overflow-wrap: anywhere;
        white-space: normal;
        text-align: right;
      }
      #${STATUS_ID} .chatgpt-notifier-timer-stop {
        flex: 0 0 18px;
        padding: 0;
        width: 18px;
        min-height: 18px;
        border: 1px solid currentColor;
        text-align: center;
      }
      #${STATUS_ID} .chatgpt-notifier-timer-stop[hidden] { display: none; }
    `;
    (document.head || document.documentElement).append(style);
  }

  function removeLegacyStatusNodes(toolbar) {
    for (const node of toolbar.querySelectorAll(
      '[id^="chatgpt-notifier-countdown-v"], #chatgpt-notifier-automation-status, '
      + '#chatgpt-notifier-countdown-fallback, [id^="chatgpt-notifier-countdown-fallback-v"]'
    )) {
      if (node.id !== STATUS_ID) node.remove();
    }
  }

  function ensureRow(toolbar) {
    if (row?.isConnected && row.parentElement === toolbar) return row;
    removeLegacyStatusNodes(toolbar);
    row = document.createElement('div');
    row.id = STATUS_ID;
    row.hidden = true;
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Auto-continue timer');
    resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'chatgpt-notifier-timer-text';
    resetButton.setAttribute('aria-label', 'Reset auto-continues remaining');
    resetButton.addEventListener('click', resetBudget);
    stopButton = document.createElement('button');
    stopButton.type = 'button';
    stopButton.className = 'chatgpt-notifier-timer-stop';
    stopButton.textContent = '■';
    stopButton.setAttribute('aria-label', 'Stop current auto-continue timer');
    stopButton.addEventListener('click', stopTimer);
    row.append(resetButton, stopButton);
    toolbar.append(row);
    return row;
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

  async function kickDueWatchdog() {
    if (disposed || busy || dueKickInFlight || overview?.automationEnabled !== true || !overview?.activeConversationId) return false;
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
    const toolbar = document.getElementById(TOOLBAR_ID);
    if (!toolbar) return;
    ensureStyle();
    ensureRow(toolbar);
    const state = presentation();
    if (resetButton.textContent !== state.text) resetButton.textContent = state.text;
    if (row.hidden !== !state.text) row.hidden = !state.text;
    resetButton.disabled = busy || overview?.automationEnabled !== true;
    stopButton.hidden = !state.active;
    stopButton.disabled = busy || overview?.automationEnabled !== true;
    if (state.due) kickDueWatchdog().catch(() => false);
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
    } catch {} finally { busy = false; render(); }
  }

  async function stopTimer(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (busy || overview?.automationEnabled !== true || !overview?.activeConversationId || !presentation().active) return;
    busy = true;
    render();
    try {
      const requestId = crypto.randomUUID();
      const result = await chrome.runtime.sendMessage({
        type: 'STOP_CODE_WATCHDOG_TIMER_FOR_SENDER',
        conversationId: overview.activeConversationId,
        watchdogRevision: overview.codeWatchdog.watchdogRevision,
        requestId
      });
      if (result?.ok === true && String(result.requestId || '') === requestId) acceptOverview(result);
      else await refreshOverview();
    } catch {} finally { busy = false; render(); }
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
    refresh() { refreshOverview().catch(() => null); render(); },
    dispose() {
      disposed = true;
      if (refreshTimer !== null) clearInterval(refreshTimer);
      if (tickTimer !== null) clearInterval(tickTimer);
      try { chrome.runtime.onMessage.removeListener(handleRuntimeMessage); } catch {}
      try { window.removeEventListener('resize', render); } catch {}
      try { row?.remove(); } catch {}
      try { document.getElementById(STYLE_ID)?.remove(); } catch {}
      row = resetButton = stopButton = null;
      if (globalThis.__chatgptNotifierQuickContinueStatusFallback === runtime) {
        delete globalThis.__chatgptNotifierQuickContinueStatusFallback;
      }
    }
  });
  globalThis.__chatgptNotifierQuickContinueStatusFallback = runtime;
  refreshOverview().catch(() => null);
  render();
})();
