'use strict';

(() => {
  const RUNTIME_VERSION = 7;
  const TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const previous = globalThis.__chatgptNotifierQuickContinueBridgeRuntime;
  if (Number(previous?.version || 0) === RUNTIME_VERSION) return;
  try { previous?.dispose?.(); } catch {}

  let disposed = false;
  let observer = null;
  let lastSettingsJson = '';

  function toolbar() {
    try { return document.getElementById(TOOLBAR_ID); } catch { return null; }
  }

  function quickContinueActionFromEvent(event) {
    if (event?.isTrusted !== true) return '';
    let control = null;
    try { control = event?.target?.closest?.(`#${TOOLBAR_ID} button`); } catch {}
    if (!control || control.disabled === true || control.getAttribute?.('aria-disabled') === 'true') return '';
    const label = String(control.getAttribute?.('aria-label') || '').trim();
    if (label === 'Send timestamped Continue') return 'continue';
    if (label === 'Send custom Project Continue') return 'project';
    if (/^Continue\s+.+/.test(label)) return 'project';
    return '';
  }

  function watchdogSettingsFromToolbar() {
    const root = toolbar();
    if (!root) return null;
    const raw = String(root.dataset?.watchdogSettings || '');
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }

  async function syncStatusPolicySettings() {
    if (disposed) return false;
    const root = toolbar();
    const raw = String(root?.dataset?.watchdogSettings || '');
    if (!raw || raw === lastSettingsJson) return false;
    const settings = watchdogSettingsFromToolbar();
    if (!settings) return false;
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'SET_CODE_WATCHDOG_SETTINGS_FOR_SENDER',
        settings
      });
      if (result?.ok === true) {
        lastSettingsJson = raw;
        return true;
      }
    } catch {}
    return false;
  }

  async function enableAutomationForQuickAction() {
    if (disposed) return false;
    let before = null;
    try { before = await chrome.runtime.sendMessage({ type: 'GET_BUILD_AUTOMATION_OVERVIEW_FOR_SENDER' }); } catch {}
    if (before?.ok !== true) return false;
    if (before.automationEnabled === true && before.pausedByUser !== true) return true;
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'SET_BUILD_AUTOMATION_STATE_FOR_SENDER',
        enabled: true,
        resumeExistingRun: before.pausedByUser === true,
        tabId: before.activeTabId,
        conversationId: before.activeConversationId,
        expectedRevision: before.stateRevision,
        requestId: crypto.randomUUID()
      });
      return result?.ok === true && result.automationEnabled === true;
    } catch {
      return false;
    }
  }

  function handleQuickAction(event) {
    if (!quickContinueActionFromEvent(event)) return;
    enableAutomationForQuickAction().catch(() => false);
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type !== 'CHATGPT_NOTIFIER_QUICK_BRIDGE_PING') return false;
    sendResponse?.({ ok: true, runtimeVersion: RUNTIME_VERSION });
    return false;
  }

  function handleMutations(records) {
    if (disposed) return;
    const settingsChanged = Array.from(records || []).some((record) =>
      record.type === 'attributes'
      && record.attributeName === 'data-watchdog-settings'
      && record.target?.id === TOOLBAR_ID
    );
    if (settingsChanged || !lastSettingsJson) syncStatusPolicySettings().catch(() => false);
  }

  try { window.addEventListener('click', handleQuickAction, { capture: true }); } catch {}
  try { chrome.runtime.onMessage.addListener(handleRuntimeMessage); } catch {}
  if (typeof MutationObserver === 'function') {
    observer = new MutationObserver(handleMutations);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-watchdog-settings']
    });
  }
  setTimeout(() => { syncStatusPolicySettings().catch(() => false); }, 0);

  const runtime = Object.freeze({
    version: RUNTIME_VERSION,
    dispose() {
      if (disposed) return;
      disposed = true;
      try { observer?.disconnect(); } catch {}
      try { window.removeEventListener('click', handleQuickAction, { capture: true }); } catch {}
      try { chrome.runtime.onMessage.removeListener(handleRuntimeMessage); } catch {}
      if (globalThis.__chatgptNotifierQuickContinueBridgeRuntime === runtime) {
        delete globalThis.__chatgptNotifierQuickContinueBridgeRuntime;
      }
    }
  });

  globalThis.__chatgptNotifierQuickContinueBridgeRuntime = runtime;
})();
