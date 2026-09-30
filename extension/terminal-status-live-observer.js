'use strict';

(() => {
  const RUNTIME_VERSION = 4;
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const RETRY_DELAYS_MS = Object.freeze([0, 250, 1000, 3000]);
  const NO_STATUS_DIAGNOSTIC_DELAY_MS = 1500;
  const NO_STATUS_DIAGNOSTIC_MIN_INTERVAL_MS = 10000;
  const SCAN_DEBOUNCE_MS = 250;
  const MAX_SCAN_INTERVAL_MS = 1500;

  try { globalThis.__chatgptNotifierRenderedTerminalObserver?.dispose?.(); } catch {}

  const abortController = new AbortController();
  let observer = null;
  let scanTimer = null;
  let maxScanTimer = null;
  let diagnosticTimer = null;
  let retryTimers = [];
  let deliveredKey = '';
  let inFlightKey = '';
  let lastDiagnosticKey = '';
  let lastDiagnosticAt = 0;

  const inline = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function conversationIdentity() {
    try {
      const url = new URL(location.href);
      if (!['chatgpt.com', 'www.chatgpt.com'].includes(url.hostname)) return null;
      const parts = url.pathname.split('/').filter(Boolean);
      for (let index = parts.length - 2; index >= 0; index -= 1) {
        if (parts[index] !== 'c') continue;
        const id = decodeURIComponent(parts[index + 1] || '').trim();
        if (id) return { id, url: `https://chatgpt.com${url.pathname.replace(/\/+$/, '')}` };
      }
    } catch {}
    return null;
  }

  function turns() {
    try { return Array.from(document.querySelectorAll(TURN_SELECTOR)); } catch { return []; }
  }

  function roleOf(turn) {
    try {
      const direct = inline(turn?.getAttribute?.('data-turn') || turn?.getAttribute?.('data-message-author-role') || '').toLowerCase();
      if (direct === 'user' || direct === 'assistant') return direct;
      if (turn?.querySelector?.('[data-message-author-role="user"], [data-turn="user"]')) return 'user';
      if (turn?.querySelector?.('[data-message-author-role="assistant"], [data-turn="assistant"]')) return 'assistant';
    } catch {}
    return '';
  }

  function turnId(turn, role, index) {
    return String(
      turn?.getAttribute?.('data-testid')
      || turn?.getAttribute?.('data-message-id')
      || turn?.getAttribute?.('data-turn-id')
      || turn?.id
      || `${role}-${index}`
    ).trim();
  }

  function revisionOf(text) {
    const value = String(text || '');
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `${value.length}:${hash.toString(16).padStart(8, '0')}`;
  }

  function nodeText(node) {
    try { return String(node?.innerText || node?.textContent || '').replace(/\r\n?/g, '\n').trimEnd(); }
    catch { return ''; }
  }

  function latestIdentity() {
    const identity = conversationIdentity();
    if (!identity) return null;
    const nodes = turns();
    let userIndex = -1;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      if (roleOf(nodes[index]) === 'user') {
        userIndex = index;
        break;
      }
    }
    if (userIndex < 0) return null;

    let assistantIndex = -1;
    for (let index = userIndex + 1; index < nodes.length; index += 1) {
      if (roleOf(nodes[index]) === 'assistant') assistantIndex = index;
    }
    if (assistantIndex < 0) return null;

    const userTurn = nodes[userIndex];
    const assistantTurn = nodes[assistantIndex];
    const userId = turnId(userTurn, 'user', userIndex);
    const assistantId = turnId(assistantTurn, 'assistant', assistantIndex);
    const monitorSnapshot = (() => {
      try { return globalThis.__chatgptNotifierMonitorRuntime?.snapshot?.() || null; } catch { return null; }
    })();
    const promptKey = `${identity.id}|${userId}`;
    const monitorMatchesPrompt = String(monitorSnapshot?.promptKey || '') === promptKey;

    return {
      identity,
      assistantTurn,
      turnCount: nodes.length,
      snapshot: {
        conversationId: identity.id,
        conversationUrl: identity.url,
        documentId: String(monitorSnapshot?.documentId || ''),
        promptKey,
        promptRevision: monitorMatchesPrompt && monitorSnapshot?.promptRevision
          ? String(monitorSnapshot.promptRevision)
          : revisionOf(nodeText(userTurn)),
        assistantKey: monitorMatchesPrompt && monitorSnapshot?.assistantKey
          ? String(monitorSnapshot.assistantKey)
          : assistantId,
        assistantRevision: monitorMatchesPrompt && monitorSnapshot?.assistantRevision
          ? String(monitorSnapshot.assistantRevision)
          : revisionOf(nodeText(assistantTurn)),
        requestId: String(monitorSnapshot?.requestId || ''),
        requestPhase: String(monitorSnapshot?.requestPhase || ''),
        requestStartedAt: Math.max(0, Number(monitorSnapshot?.requestStartedAt || 0)),
        monitorRuntimeVersion: Math.max(0, Number(monitorSnapshot?.monitorRuntimeVersion || 0))
      }
    };
  }

  function detectedStatus(current) {
    if (!current) return '';
    const code = String(globalThis.ChatGPTNotifierRenderedTerminalStatus?.detect?.(current.assistantTurn) || '');
    return globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(code) === true ? code : '';
  }

  function statusForLatestAssistant() {
    const current = latestIdentity();
    if (!current) return null;
    const code = detectedStatus(current);
    if (!code) return null;
    return {
      ...current,
      statusCode: code,
      statusLine: `[GITHUB_STATUS: ${code}]`
    };
  }

  function clearRetryTimers() {
    for (const timer of retryTimers) {
      try { clearTimeout(timer); } catch {}
    }
    retryTimers = [];
  }

  function clearDiagnosticTimer() {
    if (diagnosticTimer === null) return;
    try { clearTimeout(diagnosticTimer); } catch {}
    diagnosticTimer = null;
  }

  function clearScanTimers() {
    if (scanTimer !== null) {
      try { clearTimeout(scanTimer); } catch {}
      scanTimer = null;
    }
    if (maxScanTimer !== null) {
      try { clearTimeout(maxScanTimer); } catch {}
      maxScanTimer = null;
    }
  }

  async function publishDetected(current) {
    const snapshot = current?.snapshot || null;
    if (!snapshot?.conversationId || !snapshot?.promptKey || !snapshot?.assistantKey || !snapshot?.assistantRevision) return false;
    const key = `${snapshot.promptKey}|${snapshot.assistantKey}|${snapshot.assistantRevision}|${current.statusCode}`;
    if (key === deliveredKey || key === inFlightKey) return key === deliveredKey;
    inFlightKey = key;
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'CHATGPT_RENDERED_TERMINAL_STATUS',
        statusCode: current.statusCode,
        statusLine: current.statusLine,
        snapshot
      });
      if (result?.ok === true && result?.stopped === true) {
        deliveredKey = key;
        clearRetryTimers();
        clearDiagnosticTimer();
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      if (inFlightKey === key) inFlightKey = '';
    }
  }

  async function publishNoStatusDiagnostic() {
    diagnosticTimer = null;
    const current = latestIdentity();
    if (current && detectedStatus(current)) return;

    const snapshot = current?.snapshot || {};
    const shape = current ? (() => {
      try { return globalThis.ChatGPTNotifierRenderedTerminalStatus?.inspect?.(current.assistantTurn) || {}; } catch { return {}; }
    })() : {};
    const safeShape = current ? {
      turnCount: Math.max(0, Number(current.turnCount || 0)),
      rootCount: Math.max(0, Number(shape.rootCount || 0)),
      precedingUserCount: Math.max(0, Number(shape.precedingUserCount || 0)),
      followingUserCount: Math.max(0, Number(shape.followingUserCount || 0)),
      foreignAssistantCount: Math.max(0, Number(shape.foreignAssistantCount || 0)),
      boundaryReason: String(shape.boundaryReason || 'unknown').slice(0, 40)
    } : {
      turnCount: turns().length,
      rootCount: 0,
      precedingUserCount: 0,
      followingUserCount: 0,
      foreignAssistantCount: 0,
      boundaryReason: 'identity-missing'
    };
    const key = [
      snapshot.assistantKey || 'none',
      snapshot.assistantRevision || 'none',
      safeShape.turnCount,
      safeShape.rootCount,
      safeShape.precedingUserCount,
      safeShape.followingUserCount,
      safeShape.foreignAssistantCount,
      safeShape.boundaryReason
    ].join('|');
    const now = Date.now();
    if (key === lastDiagnosticKey && now - lastDiagnosticAt < NO_STATUS_DIAGNOSTIC_MIN_INTERVAL_MS) return;
    lastDiagnosticKey = key;
    lastDiagnosticAt = now;
    try {
      await chrome.runtime.sendMessage({
        type: 'CHATGPT_RENDERED_TERMINAL_SCAN_DIAGNOSTIC',
        snapshot: {
          conversationId: snapshot.conversationId || '',
          requestId: snapshot.requestId || '',
          promptKey: snapshot.promptKey || '',
          assistantKey: snapshot.assistantKey || '',
          assistantRevision: snapshot.assistantRevision || ''
        },
        shape: safeShape
      });
    } catch {}
  }

  function scheduleNoStatusDiagnostic() {
    clearDiagnosticTimer();
    diagnosticTimer = setTimeout(() => {
      publishNoStatusDiagnostic().catch(() => false);
    }, NO_STATUS_DIAGNOSTIC_DELAY_MS);
  }

  function scan() {
    const currentIdentity = latestIdentity();
    if (!currentIdentity) {
      scheduleNoStatusDiagnostic();
      return;
    }
    const code = detectedStatus(currentIdentity);
    if (!code) {
      scheduleNoStatusDiagnostic();
      return;
    }
    clearDiagnosticTimer();
    const current = {
      ...currentIdentity,
      statusCode: code,
      statusLine: `[GITHUB_STATUS: ${code}]`
    };
    const key = `${current.snapshot.promptKey}|${current.snapshot.assistantKey}|${current.snapshot.assistantRevision}|${current.statusCode}`;
    if (key === deliveredKey || key === inFlightKey) return;
    clearRetryTimers();
    retryTimers = RETRY_DELAYS_MS.map((delayMs) => setTimeout(() => {
      const latest = statusForLatestAssistant();
      if (!latest) return;
      const latestKey = `${latest.snapshot.promptKey}|${latest.snapshot.assistantKey}|${latest.snapshot.assistantRevision}|${latest.statusCode}`;
      if (latestKey !== key || latestKey === deliveredKey) return;
      publishDetected(latest).catch(() => false);
    }, delayMs));
  }

  function runScheduledScan() {
    clearScanTimers();
    scan();
  }

  function scheduleScan() {
    if (scanTimer !== null) {
      try { clearTimeout(scanTimer); } catch {}
    }
    scanTimer = setTimeout(runScheduledScan, SCAN_DEBOUNCE_MS);
    if (maxScanTimer === null) {
      maxScanTimer = setTimeout(runScheduledScan, MAX_SCAN_INTERVAL_MS);
    }
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type === 'CHATGPT_RENDERED_TERMINAL_OBSERVER_PING') {
      sendResponse?.({ ok: true, runtimeVersion: RUNTIME_VERSION });
      return false;
    }
    if (message?.type === 'CHATGPT_RENDERED_TERMINAL_IDENTITY_QUERY') {
      const current = latestIdentity();
      sendResponse?.({ ok: Boolean(current?.snapshot), snapshot: current?.snapshot || null });
      return false;
    }
    return false;
  }

  try { chrome.runtime.onMessage.addListener(handleRuntimeMessage); } catch {}
  try {
    observer = new MutationObserver(scheduleScan);
    observer.observe(document, { childList: true, subtree: true, characterData: true });
  } catch {}
  try { document.addEventListener('visibilitychange', scheduleScan, { signal: abortController.signal }); } catch {}

  const runtime = Object.freeze({
    version: RUNTIME_VERSION,
    scan,
    latestIdentity,
    dispose() {
      try { abortController.abort(); } catch {}
      try { observer?.disconnect(); } catch {}
      clearScanTimers();
      clearRetryTimers();
      clearDiagnosticTimer();
      try { chrome.runtime.onMessage.removeListener(handleRuntimeMessage); } catch {}
      if (globalThis.__chatgptNotifierRenderedTerminalObserver === runtime) {
        delete globalThis.__chatgptNotifierRenderedTerminalObserver;
      }
    }
  });
  globalThis.__chatgptNotifierRenderedTerminalObserver = runtime;
  scheduleScan();
})();
