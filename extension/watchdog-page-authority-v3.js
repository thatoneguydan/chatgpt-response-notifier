'use strict';

(() => {
  const RUNTIME_VERSION = 3;
  const RUNTIME_KEY = '__chatgptNotifierWatchdogPageAuthorityV3';
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const USER_TURN_WAIT_MS = 8000;
  const ARM_RETRY_DELAY_MS = 200;
  const ARM_RETRY_COUNT = 15;
  const TERMINAL_DEBOUNCE_MS = 80;
  const TERMINAL_RETRY_MS = 250;
  const TERMINAL_RETRY_COUNT = 20;
  const DEFINITIVE_STOP_CODES = new Set([
    'PLANNING_ACTIVE',
    'COMPLETE_APPLIED',
    'COMPLETE_NO_CHANGES',
    'BLOCKED_HUMAN'
  ]);

  const previous = globalThis[RUNTIME_KEY];
  if (Number(previous?.version || 0) === RUNTIME_VERSION) {
    try { previous.refresh?.(); } catch {}
    return;
  }
  try { previous?.dispose?.(); } catch {}

  const abortController = new AbortController();
  let documentObserver = null;
  let terminalTimer = null;
  let terminalRetryTimer = null;
  let terminalRetryFingerprint = '';
  let terminalRetryCount = 0;
  let terminalInFlightFingerprint = '';
  let lastTerminalFingerprint = '';
  let manualArmToken = 0;
  let manualArmPendingKey = '';

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

    const valid = [];
    for (const line of lines) {
      const match = line.match(/^\[GITHUB_STATUS: ([A-Z][A-Z0-9_]*)\]$/);
      if (!match) continue;
      const code = match[1];
      const parser = globalThis.ChatGPTNotifierStatusCode?.isStatusCode;
      if (typeof parser === 'function' && parser(code) !== true) continue;
      if (isDefinitiveStopStatus(code)) valid.push(code);
    }
    if (!valid.length) return '';
    const distinct = new Set(valid);
    if (distinct.size !== 1) return '';

    const finalLine = lines[lines.length - 1];
    const finalMatch = finalLine.match(/^\[GITHUB_STATUS: ([A-Z][A-Z0-9_]*)\]$/);
    return finalMatch && distinct.has(finalMatch[1]) ? finalMatch[1] : '';
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
    for (let index = 0; index < nodes.length; index += 1) {
      if (roleOf(nodes[index]) === 'user') userIndex = index;
    }
    if (userIndex < 0) return null;

    const conversationId = conversationIdentity();
    const promptKey = `${conversationId || location.pathname}|${turnId(nodes[userIndex], 'user', userIndex)}`;
    let code = '';
    for (let index = userIndex + 1; index < nodes.length; index += 1) {
      if (roleOf(nodes[index]) !== 'assistant') continue;
      const root = roleRoot(nodes[index], 'assistant') || nodes[index];
      let text = '';
      try {
        const blocks = Array.from(root.querySelectorAll?.('.markdown, [class*="prose"]') || [])
          .filter((node, nodeIndex, all) => !all.some((other, otherIndex) => otherIndex !== nodeIndex && other?.contains?.(node)));
        text = blocks.length
          ? blocks.map((node) => String(node?.innerText || node?.textContent || '')).filter(Boolean).join('\n')
          : String(root?.innerText || root?.textContent || '');
      } catch {
        text = String(root?.innerText || root?.textContent || '');
      }
      const candidate = terminalStatusFromText(text);
      if (candidate) code = candidate;
    }
    return code ? { statusCode: code, promptKey, conversationId, requestStartedAt: 0 } : null;
  }

  function latestDefinitiveTerminal() {
    try {
      const snapshot = globalThis.__chatgptNotifierStatusDom?.latestAssistantSnapshot?.();
      const code = String(snapshot?.statusCode || '');
      if (code && isDefinitiveStopStatus(code)) {
        return {
          statusCode: code,
          promptKey: String(snapshot?.promptKey || ''),
          conversationId: String(snapshot?.conversationId || ''),
          requestStartedAt: Math.max(0, Number(snapshot?.requestStartedAt || 0))
        };
      }
    } catch {}
    return fallbackLatestTerminal();
  }

  function clearTerminalRetry() {
    if (terminalRetryTimer !== null) {
      try { clearTimeout(terminalRetryTimer); } catch {}
      terminalRetryTimer = null;
    }
    terminalRetryFingerprint = '';
    terminalRetryCount = 0;
  }

  function scheduleTerminalRetry(fingerprint) {
    if (!fingerprint || fingerprint === lastTerminalFingerprint) return;
    if (terminalRetryFingerprint !== fingerprint) {
      clearTerminalRetry();
      terminalRetryFingerprint = fingerprint;
    }
    if (terminalRetryCount >= TERMINAL_RETRY_COUNT || terminalRetryTimer !== null) return;
    terminalRetryCount += 1;
    terminalRetryTimer = setTimeout(() => {
      terminalRetryTimer = null;
      forceDefinitiveTerminalStop().catch(() => false);
    }, TERMINAL_RETRY_MS);
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
        type: 'FORCE_PARK_CODE_WATCHDOG_TERMINAL_V3',
        conversationId,
        promptKey,
        requestStartedAt: Math.max(0, Number(terminal.requestStartedAt || 0)),
        statusCode: terminal.statusCode
      });
      if (result?.ok === true && result?.stopped === true) {
        lastTerminalFingerprint = fingerprint;
        clearTerminalRetry();
        return true;
      }
      scheduleTerminalRetry(fingerprint);
    } catch {
      scheduleTerminalRetry(fingerprint);
    } finally {
      if (terminalInFlightFingerprint === fingerprint) terminalInFlightFingerprint = '';
    }
    return false;
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

  async function readAutomationOverview() {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'GET_BUILD_AUTOMATION_OVERVIEW_FOR_SENDER' });
      return result?.ok === true ? result : null;
    } catch {
      return null;
    }
  }

  async function armFreshTrustedSubmission(previousUserKey, token, source) {
    const newUserKey = await waitForNewUserTurn(previousUserKey);
    if (!newUserKey || token !== manualArmToken) return false;

    const overview = await readAutomationOverview();
    if (overview?.automationEnabled !== true || overview?.pausedByUser === true) return false;

    for (let attempt = 0; attempt < ARM_RETRY_COUNT; attempt += 1) {
      if (token !== manualArmToken) return false;
      const requestId = crypto.randomUUID();
      try {
        const result = await chrome.runtime.sendMessage({
          type: 'ARM_CODE_WATCHDOG_FOR_SENDER',
          source: String(source || 'trusted-manual-fresh-turn'),
          requestId
        });
        if (result?.ok === true && String(result.requestId || '') === requestId) return true;
        if (!['watchdog-target-unavailable', 'target-conversation-changed'].includes(String(result?.reason || ''))) return false;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, ARM_RETRY_DELAY_MS));
    }
    return false;
  }

  function scheduleTrustedSubmissionArm(source) {
    const previousUserKey = latestUserKey();
    if (manualArmPendingKey === previousUserKey) return;
    const token = ++manualArmToken;
    manualArmPendingKey = previousUserKey;
    armFreshTrustedSubmission(previousUserKey, token, source)
      .catch(() => false)
      .finally(() => {
        if (token === manualArmToken) manualArmPendingKey = '';
      });
  }

  function composerElementFor(node) {
    if (!node) return null;
    try {
      const direct = node.closest?.('#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid="prompt-textarea"]');
      if (direct) return direct;
      const container = node.closest?.('form, [data-type="unified-composer"], [data-testid*="composer" i]');
      return container?.querySelector?.('#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid="prompt-textarea"]') || null;
    } catch {
      return null;
    }
  }

  function quickToolbarSendControl(node) {
    let control = null;
    try { control = node?.closest?.(`#${TOOLBAR_ID} button`); } catch {}
    if (!control || control.disabled === true || control.getAttribute?.('aria-disabled') === 'true') return null;
    const label = String(control.getAttribute?.('aria-label') || '').trim();
    if (label === 'Send timestamped Continue' || label === 'Send custom Project Continue' || /^Continue\s+.+/.test(label)) return control;
    return null;
  }

  function nativeSendControl(node) {
    let button = null;
    try { button = node?.closest?.('button'); } catch {}
    if (!button || button.disabled === true || button.getAttribute?.('aria-disabled') === 'true') return null;
    if (!composerElementFor(button)) return null;
    const testId = String(button.getAttribute?.('data-testid') || '').toLowerCase();
    const aria = String(button.getAttribute?.('aria-label') || '').toLowerCase();
    if (testId.includes('send-button') || /^send(?:\s|$)/.test(aria) || aria.includes('send message')) return button;
    return null;
  }

  function handleTrustedClick(event) {
    if (event?.isTrusted !== true) return;
    if (quickToolbarSendControl(event.target)) {
      scheduleTrustedSubmissionArm('quick-toolbar-fresh-turn-v3');
      return;
    }
    if (nativeSendControl(event.target)) scheduleTrustedSubmissionArm('trusted-send-click-v3');
  }

  function handleTrustedKeydown(event) {
    if (event?.isTrusted !== true || event?.key !== 'Enter') return;
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
    if (!composerElementFor(event.target)) return;
    scheduleTrustedSubmissionArm('trusted-enter-submit-v3');
  }

  function handleTrustedSubmit(event) {
    if (event?.isTrusted !== true) return;
    if (!composerElementFor(event.target)) return;
    scheduleTrustedSubmissionArm('trusted-form-submit-v3');
  }

  function scheduleTerminalInspection() {
    if (terminalTimer !== null) return;
    terminalTimer = setTimeout(() => {
      terminalTimer = null;
      forceDefinitiveTerminalStop().catch(() => false);
    }, TERMINAL_DEBOUNCE_MS);
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type !== 'CHATGPT_NOTIFIER_WATCHDOG_PAGE_AUTHORITY_PING') return false;
    sendResponse?.({ ok: true, runtimeVersion: RUNTIME_VERSION });
    return false;
  }

  try { chrome.runtime.onMessage.addListener(handleRuntimeMessage); } catch {}
  try { window.addEventListener('click', handleTrustedClick, { capture: true, signal: abortController.signal }); } catch {}
  try { window.addEventListener('keydown', handleTrustedKeydown, { capture: true, signal: abortController.signal }); } catch {}
  try { window.addEventListener('submit', handleTrustedSubmit, { capture: true, signal: abortController.signal }); } catch {}
  try { document.addEventListener('visibilitychange', scheduleTerminalInspection, { signal: abortController.signal }); } catch {}
  try { window.addEventListener('focus', scheduleTerminalInspection, { signal: abortController.signal }); } catch {}

  if (typeof MutationObserver === 'function') {
    documentObserver = new MutationObserver(scheduleTerminalInspection);
    const root = document.documentElement || document;
    documentObserver.observe(root, { childList: true, subtree: true, characterData: true });
  }

  const runtime = Object.freeze({
    version: RUNTIME_VERSION,
    refresh() {
      scheduleTerminalInspection();
    },
    dispose() {
      try { abortController.abort(); } catch {}
      try { documentObserver?.disconnect(); } catch {}
      try { if (terminalTimer !== null) clearTimeout(terminalTimer); } catch {}
      clearTerminalRetry();
      try { chrome.runtime.onMessage.removeListener(handleRuntimeMessage); } catch {}
      if (globalThis[RUNTIME_KEY] === runtime) delete globalThis[RUNTIME_KEY];
    }
  });

  globalThis[RUNTIME_KEY] = runtime;
  scheduleTerminalInspection();
})();
