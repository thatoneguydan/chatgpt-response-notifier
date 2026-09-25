'use strict';

(() => {
  const RUNTIME_VERSION = 1;
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const RETRY_DELAYS_MS = Object.freeze([0, 250, 1000, 3000]);

  try { globalThis.__chatgptNotifierRenderedTerminalObserver?.dispose?.(); } catch {}

  const abortController = new AbortController();
  let observer = null;
  let scanTimer = null;
  let retryTimers = [];
  let deliveredKey = '';
  let inFlightKey = '';

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

  function statusForLatestAssistant() {
    const current = latestIdentity();
    if (!current) return null;
    const code = String(globalThis.ChatGPTNotifierRenderedTerminalStatus?.detect?.(current.assistantTurn) || '');
    if (globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(code) !== true) return null;
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
      if (result?.ok === true) {
        deliveredKey = key;
        clearRetryTimers();
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      if (inFlightKey === key) inFlightKey = '';
    }
  }

  function scan() {
    scanTimer = null;
    const current = statusForLatestAssistant();
    if (!current) return;
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

  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = setTimeout(scan, 40);
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
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  } catch {}
  try { document.addEventListener('visibilitychange', scheduleScan, { signal: abortController.signal }); } catch {}

  const runtime = Object.freeze({
    version: RUNTIME_VERSION,
    scan,
    latestIdentity,
    dispose() {
      try { abortController.abort(); } catch {}
      try { observer?.disconnect(); } catch {}
      try { if (scanTimer !== null) clearTimeout(scanTimer); } catch {}
      clearRetryTimers();
      try { chrome.runtime.onMessage.removeListener(handleRuntimeMessage); } catch {}
      if (globalThis.__chatgptNotifierRenderedTerminalObserver === runtime) {
        delete globalThis.__chatgptNotifierRenderedTerminalObserver;
      }
    }
  });
  globalThis.__chatgptNotifierRenderedTerminalObserver = runtime;
  scheduleScan();
})();
