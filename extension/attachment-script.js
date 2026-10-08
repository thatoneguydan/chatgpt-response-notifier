'use strict';

(() => {
  const QUICK_CONTINUE_TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const ATTACHMENT_RUNTIME_VERSION = 17;
  const AUTOMATION_OWNER_ATTR = 'data-chatgpt-notifier-automation-owner';
  const AUTOMATION_UI_OWNER_ATTR = 'data-chatgpt-notifier-automation-ui-owner';
  const PRIMARY_WATCHDOG_ATTR = 'data-chatgpt-notifier-primary-watchdog';
  const PRIMARY_WATCHDOG_CONTROL_ATTR = 'data-chatgpt-notifier-primary-watchdog-control';
  const MONITOR_WATCHDOG_STATE_ATTR = 'data-chatgpt-quick-continue-monitor-watchdog-state';
  const automationOwnerToken = (() => {
    try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random()}`; }
  })();
  const AUTOMATION_INDICATOR_ID = `chatgpt-notifier-control-v${ATTACHMENT_RUNTIME_VERSION}-${automationOwnerToken}`;
  const AUTOMATION_RUNTIME_STYLE_ID = 'chatgpt-notifier-automation-runtime-style-v14';
  const LEGACY_AUTOMATION_INDICATOR_ID = 'chatgpt-notifier-automation-indicator';

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
  let watchdogPauseButton = null;
  let watchdogResetButton = null;
  let automationBusy = false;
  let automationOverview = null;
  let automationIndicatorObserver = null;

  function ownsAutomationUi() {
    try {
      return document.documentElement?.getAttribute?.(AUTOMATION_OWNER_ATTR) === automationOwnerToken;
    } catch {
      return false;
    }
  }

  function claimAutomationUi() {
    try {
      document.documentElement?.setAttribute?.(AUTOMATION_OWNER_ATTR, automationOwnerToken);
    } catch {}
    return ownsAutomationUi();
  }

  function ensureAutomationRuntimeStyle() {
    let style = document.getElementById(AUTOMATION_RUNTIME_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = AUTOMATION_RUNTIME_STYLE_ID;
      (document.head || document.documentElement).append(style);
    }
    const css = `
      #${LEGACY_AUTOMATION_INDICATOR_ID},
      [id^="chatgpt-notifier-automation-indicator-v"],
      [id^="chatgpt-notifier-automation-status-v"],
      [${AUTOMATION_UI_OWNER_ATTR}]:not([${AUTOMATION_UI_OWNER_ATTR}="${automationOwnerToken}"]) {
        display: none !important;
      }
    `;
    if (style.textContent !== css) style.textContent = css;
    return style;
  }

  function removeStaleAutomationNodes() {
    for (const selector of [
      `#${LEGACY_AUTOMATION_INDICATOR_ID}`,
      '[id^="chatgpt-notifier-automation-indicator-v"]',
      '[id^="chatgpt-notifier-automation-status-v"]',
      `[${AUTOMATION_UI_OWNER_ATTR}]`
    ]) {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(selector)); } catch {}
      for (const node of nodes) {
        if (node.id === AUTOMATION_INDICATOR_ID) continue;
        try { node.remove(); } catch {}
      }
    }
  }

  function monitorWatchdogState() {
    let raw = '';
    try { raw = String(document.documentElement?.getAttribute?.(MONITOR_WATCHDOG_STATE_ATTR) || ''); } catch {}
    if (!raw) return null;
    try {
      const state = JSON.parse(raw);
      if (!state || typeof state !== 'object') return null;
      if (String(state.conversationId || '') !== String(automationOverview?.activeConversationId || '')) return null;
      return state;
    } catch {
      return null;
    }
  }

  function publishMonitorWatchdogControl(action) {
    const conversationId = String(automationOverview?.activeConversationId || '');
    if (!conversationId || automationOverview?.automationEnabled !== true) return false;
    const command = {
      conversationId,
      action: String(action || ''),
      commandId: (() => { try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random()}`; } })()
    };
    try {
      document.documentElement?.setAttribute?.(PRIMARY_WATCHDOG_CONTROL_ATTR, JSON.stringify(command));
      return true;
    } catch {
      return false;
    }
  }

  function watchdogButtonBase(button) {
    Object.assign(button.style, {
      minWidth: '24px',
      height: '24px',
      padding: '0 5px',
      border: '0',
      borderRadius: '5px',
      background: 'transparent',
      color: 'inherit',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '12px',
      lineHeight: '1',
      cursor: 'pointer'
    });
    button.addEventListener('mouseenter', () => {
      if (!button.disabled) button.style.background = 'var(--main-surface-tertiary, rgba(127,127,127,.14))';
    });
    button.addEventListener('mouseleave', () => { button.style.background = 'transparent'; });
  }

  function renderWatchdogControls() {
    if (!watchdogPauseButton || !watchdogResetButton) return;
    const monitoring = automationOverview?.automationEnabled === true && automationOverview?.pausedByUser !== true;
    const state = monitorWatchdogState();
    const paused = state?.paused === true || state?.phase === 'paused';
    const running = state?.enabled === true;

    watchdogPauseButton.hidden = !monitoring;
    watchdogResetButton.hidden = !monitoring;
    // The buttons have inline flex styling, which can override the UA
    // [hidden] rule. Set display explicitly when monitoring is disabled.
    watchdogPauseButton.style.display = monitoring ? 'inline-flex' : 'none';
    watchdogResetButton.style.display = monitoring ? 'inline-flex' : 'none';
    watchdogPauseButton.disabled = !monitoring;
    watchdogResetButton.disabled = !monitoring;

    const shouldResume = paused || !running || state?.exhausted === true;
    watchdogPauseButton.textContent = shouldResume ? '▶' : 'Ⅱ';
    watchdogPauseButton.setAttribute('aria-label', shouldResume ? 'Resume Monitor watchdog' : 'Pause Monitor watchdog');
    watchdogResetButton.textContent = '↻';
    watchdogResetButton.setAttribute('aria-label', 'Reset Monitor watchdog');
  }

  function buildWatchdogControls() {
    const pause = document.createElement('button');
    pause.type = 'button';
    pause.id = `chatgpt-notifier-monitor-watchdog-pause-v${ATTACHMENT_RUNTIME_VERSION}-${automationOwnerToken}`;
    pause.setAttribute(AUTOMATION_UI_OWNER_ATTR, automationOwnerToken);
    watchdogButtonBase(pause);
    pause.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const state = monitorWatchdogState();
      const shouldResume = state?.paused === true || state?.phase === 'paused' || state?.enabled !== true || state?.exhausted === true;
      publishMonitorWatchdogControl(shouldResume ? 'resume' : 'pause');
    });

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.id = `chatgpt-notifier-monitor-watchdog-reset-v${ATTACHMENT_RUNTIME_VERSION}-${automationOwnerToken}`;
    reset.setAttribute(AUTOMATION_UI_OWNER_ATTR, automationOwnerToken);
    watchdogButtonBase(reset);
    reset.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      publishMonitorWatchdogControl('reset');
    });

    watchdogPauseButton = pause;
    watchdogResetButton = reset;
    renderWatchdogControls();
    return { pause, reset };
  }

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

  function automationOverviewIsFresh(next, current = automationOverview) {
    if (!next || !current) return true;
    const nextConversationId = String(next.activeConversationId || '');
    const currentConversationId = String(current.activeConversationId || '');
    if (nextConversationId !== currentConversationId) return true;
    return Math.max(0, Number(next.stateRevision || 0)) >= Math.max(0, Number(current.stateRevision || 0));
  }

  function publishPrimaryWatchdogAuthority(overview) {
    if (!overview || !ownsAutomationUi()) return;
    const command = {
      conversationId: String(overview.activeConversationId || ''),
      enabled: overview.automationEnabled === true && overview.pausedByUser !== true,
      stateRevision: Math.max(0, Number(overview.stateRevision || 0))
    };
    try { document.documentElement?.setAttribute?.(PRIMARY_WATCHDOG_ATTR, JSON.stringify(command)); } catch {}
  }

  function applyAutomationOverview(next) {
    if (!next || !automationOverviewIsFresh(next)) return automationOverview;
    automationOverview = next;
    publishPrimaryWatchdogAuthority(next);
    renderAutomationIndicator(next);
    renderWatchdogControls();
    return automationOverview;
  }

  function renderAutomationIndicator(overview = automationOverview) {
    if (!ownsAutomationUi()) return;
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
    if (mode.disabled) {
      automationDot.style.visibility = 'hidden';
      renderWatchdogControls();
      return;
    }
    automationDot.style.visibility = 'visible';
    automationDot.style.background = mode.color;
    automationDot.style.boxShadow = 'none';
    renderWatchdogControls();
  }

  function buildAutomationIndicator() {
    const button = document.createElement('button');
    button.id = AUTOMATION_INDICATOR_ID;
    button.type = 'button';
    button.setAttribute(AUTOMATION_UI_OWNER_ATTR, automationOwnerToken);
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
    if (!ownsAutomationUi()) return null;
    const toolbar = document.getElementById(QUICK_CONTINUE_TOOLBAR_ID);
    if (!toolbar) {
      automationIndicator = null;
      automationDot = null;
      return null;
    }

    const existing = document.getElementById(AUTOMATION_INDICATOR_ID);
    if (existing && existing.parentElement === toolbar) {
      automationIndicator = existing;
      automationDot = existing.firstElementChild;
      watchdogPauseButton = toolbar.querySelector('[id^="chatgpt-notifier-monitor-watchdog-pause-v"]');
      watchdogResetButton = toolbar.querySelector('[id^="chatgpt-notifier-monitor-watchdog-reset-v"]');
      if (!watchdogPauseButton || !watchdogResetButton) {
        watchdogPauseButton?.remove();
        watchdogResetButton?.remove();
        const controls = buildWatchdogControls();
        existing.insertAdjacentElement('afterend', controls.pause);
        controls.pause.insertAdjacentElement('afterend', controls.reset);
      }
      renderWatchdogControls();
      return existing;
    }

    if (existing) {
      try { existing.remove(); } catch {}
    }

    const continueButton = Array.from(toolbar.querySelectorAll('button'))
      .find((button) => String(button.textContent || '').trim() === 'Continue');
    if (!continueButton) return null;

    const indicator = buildAutomationIndicator();
    const controls = buildWatchdogControls();
    continueButton.insertAdjacentElement('beforebegin', indicator);
    indicator.insertAdjacentElement('afterend', controls.pause);
    controls.pause.insertAdjacentElement('afterend', controls.reset);
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
    if (!ownsAutomationUi()) return automationOverview;
    if (automationBusy) return automationOverview;
    const indicator = ensureAutomationIndicator();
    if (!indicator || document.visibilityState === 'hidden') return automationOverview;
    const requestedPath = location.pathname;
    const overview = await readAutomationOverview();
    if (!overview || location.pathname !== requestedPath) return automationOverview;
    return applyAutomationOverview(overview);
  }

  function quickContinueActionFromEvent(event) {
    if (event?.isTrusted !== true) return '';
    const target = event?.target;
    let control = null;
    try { control = target?.closest?.(`#${QUICK_CONTINUE_TOOLBAR_ID} button`); } catch {}
    if (!control || control.disabled === true || control.getAttribute?.('aria-disabled') === 'true') return '';
    const label = String(control.getAttribute?.('aria-label') || '').trim();
    if (label === 'Send timestamped Continue') return 'continue';
    if (label === 'Send custom Project Continue') return 'project';
    if (/^Continue\s+.+/.test(label)) return 'project';
    return '';
  }

  async function cycleAutomationState(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!ownsAutomationUi()) return;
    if (automationBusy) return;

    const indicator = ensureAutomationIndicator();
    if (!indicator) return;

    automationBusy = true;
    renderAutomationIndicator();
    try {
      const observedBefore = await readAutomationOverview();
      const before = observedBefore && automationOverviewIsFresh(observedBefore)
        ? applyAutomationOverview(observedBefore)
        : automationOverview;
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

      applyAutomationOverview(result);
    } catch {
      setTimeout(() => { refreshAutomationIndicator().catch(() => {}); }, 800);
    } finally {
      automationBusy = false;
      renderAutomationIndicator();
    }
  }

  function refreshForRoute() {
    if (!ownsAutomationUi()) return;
    automationOverview = null;
    automationIndicator = null;
    automationDot = null;
    watchdogPauseButton = null;
    watchdogResetButton = null;
    maintainAutomationIndicator();
    for (const delay of [50, 250, 1000]) {
      setTimeout(() => {
        if (!ownsAutomationUi()) return;
        maintainAutomationIndicator();
        refreshAutomationIndicator().catch(() => {});
      }, delay);
    }
  }

  function maintainAutomationIndicator() {
    if (!ownsAutomationUi()) return;
    const previousIndicator = automationIndicator;
    const indicator = ensureAutomationIndicator();
    if (!indicator || document.visibilityState === 'hidden') return;
    if (indicator !== previousIndicator || !automationOverview) {
      refreshAutomationIndicator().catch(() => {});
    }
  }

  function handleAutomationStateMessage(message, _sender, sendResponse) {
    if (message?.type === 'CHATGPT_NOTIFIER_ATTACHMENT_PING') {
      sendResponse?.({
        ok: true,
        runtimeVersion: ATTACHMENT_RUNTIME_VERSION,
        extensionVersion
      });
      return false;
    }
    if (message?.type !== 'BUILD_AUTOMATION_STATE_CHANGED') return false;
    if (!ownsAutomationUi()) return false;
    const indicator = ensureAutomationIndicator();
    if (!indicator) return false;
    if (!message.overview) return false;
    applyAutomationOverview(message.overview);
    return false;
  }

  function handleVisibilityChange() {
    if (document.visibilityState !== 'hidden') refreshAutomationIndicator().catch(() => {});
  }

  function handleWindowFocus() {
    refreshAutomationIndicator().catch(() => {});
  }

  claimAutomationUi();
  ensureAutomationRuntimeStyle();
  removeStaleAutomationNodes();
  try { document.getElementById(AUTOMATION_INDICATOR_ID)?.remove(); } catch {}
  try { chrome.runtime.onMessage.addListener(handleAutomationStateMessage); } catch {}
  document.addEventListener('visibilitychange', handleVisibilityChange, true);
  window.addEventListener('focus', handleWindowFocus, true);
  let observedPathname = location.pathname;
  automationIndicatorObserver = new MutationObserver((records) => {
    if (!ownsAutomationUi()) return;
    // Reuse this existing observer to catch ChatGPT's pushState-only route
    // remounts; no extra observer, polling, or per-keystroke URL parsing.
    if (location.pathname !== observedPathname) {
      observedPathname = location.pathname;
      try { globalThis.__chatgptNotifierAutomationRouteRefreshRuntime?.scheduleSync?.(); } catch {}
    }
    if (!document.getElementById(AUTOMATION_RUNTIME_STYLE_ID)) ensureAutomationRuntimeStyle();
    if (Array.from(records || []).some((record) => record.type === 'attributes' && record.attributeName === MONITOR_WATCHDOG_STATE_ATTR)) {
      renderWatchdogControls();
    }
    maintainAutomationIndicator();
  });
  automationIndicatorObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [MONITOR_WATCHDOG_STATE_ATTR]
  });
  setTimeout(() => { maintainAutomationIndicator(); }, 100);

  globalThis.__chatgptNotifierAttachmentRuntime = Object.freeze({
    version: ATTACHMENT_RUNTIME_VERSION,
    extensionVersion,
    refreshForRoute,
    dispose() {
      try { if (heartbeatTimerId !== null) clearInterval(heartbeatTimerId); } catch {}
      try { if (heartbeatInitialTimerId !== null) clearTimeout(heartbeatInitialTimerId); } catch {}
      try { automationIndicatorObserver?.disconnect(); } catch {}
      try { chrome.runtime.onMessage.removeListener(handleAutomationStateMessage); } catch {}
      try { document.removeEventListener('visibilitychange', handleVisibilityChange, true); } catch {}
      try { window.removeEventListener('focus', handleWindowFocus, true); } catch {}
      try { document.getElementById(AUTOMATION_INDICATOR_ID)?.remove(); } catch {}
      try { watchdogPauseButton?.remove(); } catch {}
      try { watchdogResetButton?.remove(); } catch {}
      try {
        if (ownsAutomationUi()) {
          document.documentElement?.removeAttribute?.(PRIMARY_WATCHDOG_ATTR);
          document.documentElement?.removeAttribute?.(AUTOMATION_OWNER_ATTR);
        }
      } catch {}
    }
  });
})();
