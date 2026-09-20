'use strict';

(() => {
  const QUICK_CONTINUE_TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const AUTOMATION_INDICATOR_ID = 'chatgpt-notifier-automation-indicator';
  const AUTOMATION_STATUS_ID = 'chatgpt-notifier-automation-status';
  const AUTOMATION_DUE_REFRESH_MS = 5000;

  let extensionVersion = '';
  try { extensionVersion = String(chrome.runtime.getManifest().version || ''); } catch {}

  const previous = globalThis.__chatgptNotifierAttachmentRuntime;
  try { previous?.dispose?.(); } catch {}

  const runtimeChanged = !previous || String(previous.extensionVersion || '') !== extensionVersion;
  if (runtimeChanged) {
    // Extension reload/update invalidates old runtime listeners but Chrome may
    // retain isolated-world globals for an already-open document. Reset only
    // stale installation guards so the unchanged upstream detector and local
    // listeners can attach to the new runtime without reloading/activating tab.
    globalThis.__chatgptPromptBoundNotifierInstalled = false;
    globalThis.__chatgptNotifierPersistenceInstalled = false;
    globalThis.__chatgptNotifierRecoveryInstalled = false;
    globalThis.__chatgptNotifierStatusDomInstalled = false;
  }

  const oldHeartbeat = globalThis.__chatgptNotifierActivationHeartbeat;
  if (oldHeartbeat?.timerId) {
    try { clearInterval(oldHeartbeat.timerId); } catch {}
  }
  if (oldHeartbeat?.initialTimerId) {
    try { clearTimeout(oldHeartbeat.initialTimerId); } catch {}
  }

  let heartbeatTimerId = null;
  let heartbeatInitialTimerId = null;
  const pingHelperVersion = () => {
    try {
      chrome.runtime.sendMessage({ type: 'PING_NATIVE_HOST', source: 'activation-heartbeat' }, () => {
        try { void chrome.runtime.lastError; } catch {}
      });
    } catch {
      if (heartbeatTimerId !== null) {
        try { clearInterval(heartbeatTimerId); } catch {}
        heartbeatTimerId = null;
      }
    }
  };

  // This does not activate or foreground the page. It only wakes the extension
  // worker so an already-open tab can help an old runtime discover that Setup
  // installed a newer manifest/helper version. Once per 30 seconds is enough to
  // close the sleeping-worker gap without polling ChatGPT or creating web traffic.
  heartbeatInitialTimerId = setTimeout(pingHelperVersion, 2000);
  heartbeatTimerId = setInterval(pingHelperVersion, 30000);
  globalThis.__chatgptNotifierActivationHeartbeat = {
    version: 1,
    extensionVersion,
    timerId: heartbeatTimerId,
    initialTimerId: heartbeatInitialTimerId
  };

  let automationIndicator = null;
  let automationDot = null;
  let automationStatus = null;
  let automationBusy = false;
  let automationOverview = null;
  let automationIndicatorObserver = null;
  let automationCountdownTimerId = null;
  let automationDueRefreshAt = 0;

  function recoveryPauseReason(overview) {
    const recovery = overview?.recovery;
    if (recovery?.profile?.breakerOpen === true) return recovery.profile.breakerReason || 'recovery breaker open';
    if (Number(recovery?.humanRun?.generationActions || 0) >= 12) return 'run action limit reached';
    if (recovery?.incident?.state === 'attention') return recovery.incident.reason || 'recovery needs attention';
    return '';
  }

  function automationMode(overview) {
    if (!overview || !Number.isInteger(overview.activeTabId)) {
      return {
        key: 'unavailable',
        label: 'Monitor unavailable',
        color: '#888888',
        desired: true,
        resume: false,
        disabled: true
      };
    }
    if (overview.pausedByUser === true) {
      return {
        key: 'warning',
        label: 'Resume',
        color: '#888888',
        desired: true,
        resume: true,
        disabled: false
      };
    }
    if (overview.automationEnabled === true && recoveryPauseReason(overview)) {
      return {
        key: 'warning',
        label: 'Resume',
        color: '#888888',
        desired: true,
        resume: true,
        disabled: false
      };
    }
    if (overview.automationEnabled === true) {
      return {
        key: 'enabled',
        label: 'Pause',
        color: '#22c55e',
        desired: false,
        resume: false,
        disabled: false
      };
    }
    return {
      key: 'ready',
      label: 'Monitor',
      color: '#888888',
      desired: true,
      resume: false,
      disabled: false
    };
  }

  function formatCountdown(milliseconds) {
    const seconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${minutes}:${String(remainder).padStart(2, '0')}`;
  }

  function automationHoldText(reason) {
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

  function automationStatusText(overview = automationOverview, now = Date.now()) {
    if (overview?.automationEnabled !== true) return '';
    const watchdog = overview?.codeWatchdog || null;
    const maxSends = Math.max(1, Number(overview?.codeWatchdogMaxSends || 3));
    const sendCount = Math.max(0, Number(watchdog?.sendCount || 0));
    const remaining = Math.max(0, maxSends - sendCount);

    if (remaining <= 0 || (watchdog?.stopped === true && String(watchdog?.stopReason || '') === 'retry-cap-reached')) {
      return 'Auto-continues exhausted';
    }

    const remainingText = `${remaining} left`;
    const deadlineAt = Math.max(0, Number(watchdog?.deadlineAt || 0));
    const retryAt = Math.max(0, Number(watchdog?.retryAt || 0));
    const holdText = automationHoldText(watchdog?.retryReason);

    if (deadlineAt > 0) {
      if (deadlineAt <= Number(now)) {
        return holdText
          ? `Auto-continue due · waiting for ${holdText} · ${remainingText}`
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

  function ensureAutomationStatus() {
    const toolbar = document.getElementById(QUICK_CONTINUE_TOOLBAR_ID);
    if (!toolbar) {
      automationStatus = null;
      return null;
    }

    const existing = document.getElementById(AUTOMATION_STATUS_ID);
    if (existing && existing.parentElement === toolbar) {
      automationStatus = existing;
      return existing;
    }
    if (existing) {
      try { existing.remove(); } catch {}
    }

    const status = document.createElement('div');
    status.id = AUTOMATION_STATUS_ID;
    status.hidden = true;
    status.setAttribute('role', 'status');
    Object.assign(status.style, {
      position: 'absolute',
      left: '22px',
      bottom: 'calc(100% + 3px)',
      padding: '2px 4px',
      borderRadius: '5px',
      background: 'var(--main-surface-primary, #fff)',
      color: 'var(--text-secondary, #666)',
      fontSize: '9px',
      lineHeight: '1.2',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      opacity: '.78'
    });
    toolbar.append(status);
    automationStatus = status;
    return status;
  }

  function renderAutomationStatus(overview = automationOverview) {
    const status = ensureAutomationStatus();
    if (!status) return;
    const text = automationStatusText(overview);
    status.hidden = !text;
    status.textContent = text;
  }

  function tickAutomationStatus() {
    renderAutomationStatus();
    const watchdog = automationOverview?.codeWatchdog;
    const deadlineAt = Math.max(0, Number(watchdog?.deadlineAt || 0));
    const retryAt = Math.max(0, Number(watchdog?.retryAt || 0));
    const refreshBoundaryAt = deadlineAt > 0 ? deadlineAt : retryAt;
    const now = Date.now();
    if (
      automationOverview?.automationEnabled === true
      && refreshBoundaryAt > 0
      && refreshBoundaryAt <= now
      && now >= automationDueRefreshAt
    ) {
      automationDueRefreshAt = now + AUTOMATION_DUE_REFRESH_MS;
      refreshAutomationIndicator().catch(() => {});
    }
  }

  function renderAutomationIndicator(overview = automationOverview) {
    if (!automationIndicator || !automationDot) return;
    const mode = automationMode(overview);
    automationIndicator.disabled = automationBusy || mode.disabled;
    automationIndicator.style.cursor = automationIndicator.disabled ? 'default' : 'pointer';
    automationIndicator.style.opacity = '1';
    automationIndicator.setAttribute(
      'aria-label',
      mode.disabled
        ? 'Build automation state unavailable'
        : `Build automation: ${mode.label}. Click to ${mode.label.toLowerCase()}.`
    );
    automationIndicator.dataset.state = mode.key;
    renderAutomationStatus(overview);
    if (mode.disabled) {
      automationDot.style.visibility = 'hidden';
      return;
    }
    automationDot.style.visibility = 'visible';
    automationDot.style.background = mode.color;
    automationDot.style.boxShadow = 'none';
  }

  function buildAutomationIndicator() {
    const button = document.createElement('button');
    button.id = AUTOMATION_INDICATOR_ID;
    button.type = 'button';
    Object.assign(button.style, {
      width: '18px',
      minWidth: '18px',
      height: '24px',
      padding: '0',
      border: '0',
      borderRadius: '5px',
      background: 'transparent',
      color: 'inherit',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer'
    });

    const dot = document.createElement('span');
    dot.setAttribute('aria-hidden', 'true');
    Object.assign(dot.style, {
      display: 'block',
      width: '8px',
      height: '8px',
      borderRadius: '999px',
      background: 'transparent',
      visibility: 'hidden',
      boxShadow: 'none'
    });
    button.append(dot);

    button.addEventListener('mouseenter', () => {
      if (button.disabled) return;
      button.style.background = 'var(--main-surface-tertiary, rgba(127,127,127,.14))';
    });
    button.addEventListener('mouseleave', () => {
      button.style.background = 'transparent';
    });
    button.addEventListener('click', cycleAutomationState);

    automationIndicator = button;
    automationDot = dot;
    renderAutomationIndicator(null);
    return button;
  }

  function ensureAutomationIndicator() {
    const toolbar = document.getElementById(QUICK_CONTINUE_TOOLBAR_ID);
    if (!toolbar) {
      automationIndicator = null;
      automationDot = null;
      automationStatus = null;
      return null;
    }

    const existing = document.getElementById(AUTOMATION_INDICATOR_ID);
    if (existing && existing.parentElement === toolbar) {
      automationIndicator = existing;
      automationDot = existing.firstElementChild;
      return existing;
    }

    if (existing) {
      try { existing.remove(); } catch {}
    }

    const continueButton = Array.from(toolbar.querySelectorAll('button'))
      .find((button) => String(button.textContent || '').trim() === 'Continue');
    if (!continueButton) return null;

    const indicator = buildAutomationIndicator();
    continueButton.insertAdjacentElement('beforebegin', indicator);
    ensureAutomationStatus();
    return indicator;
  }

  async function readAutomationOverview() {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'GET_BUILD_AUTOMATION_OVERVIEW_FOR_SENDER' });
      if (!result?.ok) return null;
      return result;
    } catch {
      return null;
    }
  }

  async function refreshAutomationIndicator() {
    if (automationBusy) return automationOverview;
    const indicator = ensureAutomationIndicator();
    if (!indicator || document.visibilityState === 'hidden') return automationOverview;
    const overview = await readAutomationOverview();
    if (!overview) return automationOverview;
    automationOverview = overview;
    renderAutomationIndicator(overview);
    return overview;
  }

  async function cycleAutomationState(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (automationBusy) return;

    const indicator = ensureAutomationIndicator();
    if (!indicator) return;

    automationBusy = true;
    renderAutomationIndicator();
    try {
      const before = (await readAutomationOverview()) || automationOverview;
      if (before) automationOverview = before;
      const mode = automationMode(before);
      if (!before || mode.disabled) return;

      const requestId = crypto.randomUUID();
      const result = await chrome.runtime.sendMessage({
        type: 'SET_BUILD_AUTOMATION_STATE_FOR_SENDER',
        enabled: mode.desired,
        resumeExistingRun: mode.resume,
        tabId: before.activeTabId,
        conversationId: before.activeConversationId,
        expectedRevision: before.stateRevision,
        requestId
      });

      if (!result?.ok) throw new Error(result?.error || result?.reason || 'Build automation change was rejected.');
      if (String(result.requestId || '') !== requestId) throw new Error('Build automation confirmation did not match this request.');

      const expectedEnabled = mode.desired === true;
      if (
        result.automationEnabled !== expectedEnabled
        || result.recoveryEnabled !== expectedEnabled
        || result.monitoring !== expectedEnabled
      ) {
        throw new Error('Build automation write could not be verified from readback.');
      }
      if (mode.desired === false && result.pausedByUser !== true) {
        throw new Error('Pause was not persisted as an operator override.');
      }
      if (Number(result.stateRevision || 0) <= Number(before.stateRevision || 0)) {
        throw new Error('Build automation revision did not advance.');
      }

      automationOverview = result;
    } catch {
      setTimeout(() => { refreshAutomationIndicator().catch(() => {}); }, 800);
    } finally {
      automationBusy = false;
      renderAutomationIndicator();
    }
  }

  function maintainAutomationIndicator() {
    const previousIndicator = automationIndicator;
    const indicator = ensureAutomationIndicator();
    ensureAutomationStatus();
    if (!indicator || document.visibilityState === 'hidden') return;
    if (indicator !== previousIndicator || !automationOverview) {
      refreshAutomationIndicator().catch(() => {});
    }
  }

  function handleAutomationStateMessage(message) {
    if (message?.type !== 'BUILD_AUTOMATION_STATE_CHANGED') return false;
    const indicator = ensureAutomationIndicator();
    if (!indicator) return false;
    if (!message.overview) return false;
    automationOverview = message.overview;
    renderAutomationIndicator(automationOverview);
    return false;
  }

  function handleVisibilityChange() {
    if (document.visibilityState !== 'hidden') refreshAutomationIndicator().catch(() => {});
  }

  function handleWindowFocus() {
    refreshAutomationIndicator().catch(() => {});
  }

  try { document.getElementById(AUTOMATION_INDICATOR_ID)?.remove(); } catch {}
  try { chrome.runtime.onMessage.addListener(handleAutomationStateMessage); } catch {}
  document.addEventListener('visibilitychange', handleVisibilityChange, true);
  window.addEventListener('focus', handleWindowFocus, true);
  automationIndicatorObserver = new MutationObserver(() => {
    maintainAutomationIndicator();
  });
  automationIndicatorObserver.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => { maintainAutomationIndicator(); }, 100);
  automationCountdownTimerId = setInterval(tickAutomationStatus, 1000);

  globalThis.__chatgptNotifierAttachmentRuntime = Object.freeze({
    version: 5,
    extensionVersion,
    dispose() {
      try { if (heartbeatTimerId !== null) clearInterval(heartbeatTimerId); } catch {}
      try { if (heartbeatInitialTimerId !== null) clearTimeout(heartbeatInitialTimerId); } catch {}
      try { automationIndicatorObserver?.disconnect(); } catch {}
      try { if (automationCountdownTimerId !== null) clearInterval(automationCountdownTimerId); } catch {}
      try { chrome.runtime.onMessage.removeListener(handleAutomationStateMessage); } catch {}
      try { document.removeEventListener('visibilitychange', handleVisibilityChange, true); } catch {}
      try { window.removeEventListener('focus', handleWindowFocus, true); } catch {}
      try { document.getElementById(AUTOMATION_INDICATOR_ID)?.remove(); } catch {}
      try { document.getElementById(AUTOMATION_STATUS_ID)?.remove(); } catch {}
    }
  });
})();
