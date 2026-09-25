'use strict';

(() => {
  const RUNTIME_VERSION = 3;
  const TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const USER_TURN_WAIT_MS = 8000;
  const ARM_RETRY_DELAY_MS = 250;
  const ARM_RETRY_COUNT = 12;
  const TERMINAL_DEBOUNCE_MS = 120;
  const DEFINITIVE_STOP_CODES = new Set([
    'PLANNING_ACTIVE',
    'COMPLETE_APPLIED',
    'COMPLETE_NO_CHANGES',
    'BLOCKED_HUMAN'
  ]);

  const previous = globalThis.__chatgptNotifierQuickContinueBridge;
  if (Number(previous?.version || 0) === RUNTIME_VERSION) {
    try { previous.refresh?.(); } catch {}
    return;
  }
  try { previous?.dispose?.(); } catch {}

  const abortController = new AbortController();
  let documentObserver = null;
  let terminalTimer = null;
  let actionGeneration = 0;
  let lastTerminalFingerprint = '';
  let terminalInFlightFingerprint = '';

  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function conversationIdentity() {
    try {
      const url = new URL(location.href);
      if (!['chatgpt.com', 'www.chatgpt.com'].includes(url.hostname)) return '';
      const parts = url.pathname.split('/').filter(Boolean);
      for (let index = parts.length - 2; index >= 0; index -= 1) {
        if (parts[index] !== 'c') continue;
        return decodeURIComponent(parts[index + 1] || '').trim();
      }
    } catch {}
    return '';
  }

  function roleOf(turn) {
    try {
      const direct = normalize(turn?.getAttribute?.('data-turn') || turn?.getAttribute?.('data-message-author-role') || '').toLowerCase();
      if (direct === 'user' || direct === 'assistant') return direct;
      if (turn?.querySelector?.('[data-message-author-role="user"]')) return 'user';
      if (turn?.querySelector?.('[data-message-author-role="assistant"]')) return 'assistant';
    } catch {}
    return '';
  }

  function turnId(turn, role, index) {
    return String(turn?.getAttribute?.('data-testid') || turn?.id || `${role}-${index}`).trim();
  }

  function turnNodes() {
    try { return Array.from(document.querySelectorAll(TURN_SELECTOR)); } catch { return []; }
  }

  function latestUserKey() {
    const nodes = turnNodes();
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      if (roleOf(nodes[index]) !== 'user') continue;
      const conversationId = conversationIdentity() || location.pathname;
      return `${conversationId}|${turnId(nodes[index], 'user', index)}`;
    }
    return '';
  }

  function quickActionFromLabel(labelValue) {
    const label = String(labelValue || '').trim();
    if (label === 'Send timestamped Continue') return 'continue';
    if (label === 'Send custom Project Continue') return 'project';
    if (/^Continue\s+.+/.test(label)) return 'project';
    return '';
  }

  function quickActionControlFromEvent(event) {
    if (event?.isTrusted !== true) return null;
    const target = event?.target;
    let control = null;
    try { control = target?.closest?.(`#${TOOLBAR_ID} button`); } catch {}
    if (!control || control.disabled === true || control.getAttribute?.('aria-disabled') === 'true') return null;
    return control;
  }

  function isDefinitiveStopStatus(codeValue) {
    const code = String(codeValue || '');
    try {
      if (globalThis.ChatGPTNotifierContinuationPolicy?.isDefinitiveStopStatusCode?.(code) === true) return true;
    } catch {}
    return DEFINITIVE_STOP_CODES.has(code);
  }

  function terminalStatusFromText(value) {
    const lines = String(value || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return '';
    const match = lines[lines.length - 1].match(/^\[GITHUB_STATUS: ([A-Z][A-Z0-9_]*)\]$/);
    if (!match) return '';
    const code = match[1];
    const parser = globalThis.ChatGPTNotifierStatusCode?.isStatusCode;
    if (typeof parser === 'function' && parser(code) !== true) return '';
    return isDefinitiveStopStatus(code) ? code : '';
  }

  function roleRoot(turn, role) {
    try {
      const selector = `[data-message-author-role="${role}"]`;
      return turn?.matches?.(selector) ? turn : turn?.querySelector?.(selector);
    } catch { return null; }
  }

  function fallbackLatestTerminal() {
    const nodes = turnNodes();
    let userIndex = -1;
    for (let index = 0; index < nodes.length; index += 1) if (roleOf(nodes[index]) === 'user') userIndex = index;
    if (userIndex < 0) return null;
    const conversationId = conversationIdentity();
    const promptKey = `${conversationId || location.pathname}|${turnId(nodes[userIndex], 'user', userIndex)}`;
    let code = '';
    for (let index = userIndex + 1; index < nodes.length; index += 1) {
      if (roleOf(nodes[index]) !== 'assistant') continue;
      const root = roleRoot(nodes[index], 'assistant');
      if (!root) continue;
      let blocks = [];
      try {
        blocks = Array.from(root.querySelectorAll('.markdown, [class*="prose"]'));
        blocks = blocks.filter((node) => !blocks.some((other) => other !== node && other.contains?.(node)));
      } catch {}
      const text = blocks.length
        ? blocks.map((node) => String(node?.innerText || node?.textContent || '')).filter(Boolean).join('\n')
        : String(root?.innerText || root?.textContent || '');
      const candidate = terminalStatusFromText(text);
      if (candidate) code = candidate;
    }
    return code ? { statusCode: code, promptKey, conversationId } : null;
  }

  function latestDefinitiveTerminal() {
    try {
      const snapshot = globalThis.__chatgptNotifierStatusDom?.latestAssistantSnapshot?.();
      const code = String(snapshot?.statusCode || '');
      if (code && isDefinitiveStopStatus(code)) {
        return {
          statusCode: code,
          promptKey: String(snapshot?.promptKey || ''),
          conversationId: String(snapshot?.conversationId || '')
        };
      }
    } catch {}
    return fallbackLatestTerminal();
  }

  async function forceDefinitiveTerminalStop() {
    const terminal = latestDefinitiveTerminal();
    if (!terminal?.statusCode) return false;
    const conversationId = conversationIdentity();
    if (!conversationId) return false;
    if (terminal.conversationId && String(terminal.conversationId) !== conversationId) return false;

    const promptKey = String(terminal.promptKey || latestUserKey() || '');
    const fingerprint = `${conversationId}|${promptKey}|${terminal.statusCode}`;
    if (fingerprint === lastTerminalFingerprint || fingerprint === terminalInFlightFingerprint) return false;
    terminalInFlightFingerprint = fingerprint;
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'PARK_CODE_WATCHDOG_FOR_TERMINAL_STATUS_FOR_SENDER',
        conversationId,
        promptKey,
        statusCode: terminal.statusCode
      });
      if (result?.ok === true) {
        lastTerminalFingerprint = fingerprint;
        return true;
      }
    } catch {}
    finally {
      if (terminalInFlightFingerprint === fingerprint) terminalInFlightFingerprint = '';
    }
    return false;
  }

  function recoveryNeedsResume(overview) {
    const recovery = overview?.recovery;
    if (!recovery) return false;
    if (recovery?.profile?.breakerOpen === true) return false;
    if (Number(recovery?.humanRun?.generationActions || 0) >= 12) return false;
    return recovery?.incident?.state === 'attention';
  }

  async function readAutomationOverview() {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'GET_BUILD_AUTOMATION_OVERVIEW_FOR_SENDER' });
      return result?.ok === true ? result : null;
    } catch {
      return null;
    }
  }

  async function enableAutomationForQuickAction() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const overview = await readAutomationOverview();
      if (!overview) return null;
      const needsEnable = overview.automationEnabled !== true || overview.pausedByUser === true;
      const needsResume = overview.automationEnabled === true && recoveryNeedsResume(overview);
      if (!needsEnable && !needsResume) return overview;

      const requestId = crypto.randomUUID();
      try {
        const result = await chrome.runtime.sendMessage({
          type: 'SET_BUILD_AUTOMATION_STATE_FOR_SENDER',
          enabled: true,
          resumeExistingRun: overview.pausedByUser === true || needsResume,
          tabId: overview.activeTabId,
          conversationId: overview.activeConversationId,
          expectedRevision: overview.stateRevision,
          requestId
        });
        if (result?.ok === true && String(result.requestId || '') === requestId && result.automationEnabled === true) return result;
        if (String(result?.reason || '') !== 'state-revision-mismatch') return null;
      } catch {
        return null;
      }
    }
    return null;
  }

  function waitForNewUserTurn(previousKey, timeoutMs = USER_TURN_WAIT_MS) {
    const immediate = latestUserKey();
    if (immediate && immediate !== previousKey) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      let settled = false;
      let observer = null;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try { observer?.disconnect(); } catch {}
        if (timer !== null) clearTimeout(timer);
        resolve(value || '');
      };
      const inspect = () => {
        const key = latestUserKey();
        if (key && key !== previousKey) finish(key);
      };
      const root = document.querySelector('main') || document.body || document.documentElement;
      if (root && typeof MutationObserver === 'function') {
        observer = new MutationObserver(inspect);
        observer.observe(root, { childList: true, subtree: true });
      }
      timer = setTimeout(() => finish(''), Math.max(0, Number(timeoutMs) || USER_TURN_WAIT_MS));
      inspect();
    });
  }

  async function armFreshQuickAction(action, previousUserKey, generation) {
    const enabledPromise = enableAutomationForQuickAction();
    const newUserKey = await waitForNewUserTurn(previousUserKey);
    if (!newUserKey || generation !== actionGeneration) return false;
    const enabled = await enabledPromise;
    if (!enabled || generation !== actionGeneration) return false;

    for (let attempt = 0; attempt < ARM_RETRY_COUNT; attempt += 1) {
      if (generation !== actionGeneration) return false;
      const requestId = crypto.randomUUID();
      try {
        const result = await chrome.runtime.sendMessage({
          type: 'ARM_CODE_WATCHDOG_FOR_SENDER',
          source: `quick-${action}-fresh-turn`,
          promptKey: newUserKey,
          requestId
        });
        if (result?.ok === true && String(result.requestId || '') === requestId) return true;
        if (!['watchdog-target-unavailable', 'target-conversation-changed'].includes(String(result?.reason || ''))) return false;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, ARM_RETRY_DELAY_MS));
    }
    return false;
  }

  function handleQuickAction(event) {
    const control = quickActionControlFromEvent(event);
    if (!control) return;
    const originalLabel = String(control.getAttribute?.('aria-label') || '');
    const action = quickActionFromLabel(originalLabel);
    if (!action) return;

    const previousUserKey = latestUserKey();
    const generation = ++actionGeneration;
    armFreshQuickAction(action, previousUserKey, generation).catch(() => false);
  }

  function scheduleTerminalInspection() {
    if (terminalTimer !== null) return;
    terminalTimer = setTimeout(() => {
      terminalTimer = null;
      forceDefinitiveTerminalStop().catch(() => false);
    }, TERMINAL_DEBOUNCE_MS);
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type !== 'CHATGPT_NOTIFIER_QUICK_BRIDGE_PING') return false;
    sendResponse?.({ ok: true, runtimeVersion: RUNTIME_VERSION });
    return false;
  }

  try { chrome.runtime.onMessage.addListener(handleRuntimeMessage); } catch {}
  try { window.addEventListener('click', handleQuickAction, { capture: true, signal: abortController.signal }); } catch {}
  try { document.addEventListener('visibilitychange', scheduleTerminalInspection, { signal: abortController.signal }); } catch {}
  try { window.addEventListener('focus', scheduleTerminalInspection, { signal: abortController.signal }); } catch {}

  if (typeof MutationObserver === 'function') {
    documentObserver = new MutationObserver(scheduleTerminalInspection);
    const root = document.documentElement || document;
    documentObserver.observe(root, { childList: true, subtree: true, characterData: true });
  }

  const runtime = {
    version: RUNTIME_VERSION,
    quickActionFromLabel,
    terminalStatusFromText,
    refresh() {
      scheduleTerminalInspection();
    },
    dispose() {
      try { abortController.abort(); } catch {}
      try { documentObserver?.disconnect(); } catch {}
      try { if (terminalTimer !== null) clearTimeout(terminalTimer); } catch {}
      try { chrome.runtime.onMessage.removeListener(handleRuntimeMessage); } catch {}
      if (globalThis.__chatgptNotifierQuickContinueBridge === runtime) delete globalThis.__chatgptNotifierQuickContinueBridge;
    }
  };
  globalThis.__chatgptNotifierQuickContinueBridge = Object.freeze(runtime);

  scheduleTerminalInspection();
})();
