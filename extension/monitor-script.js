'use strict';

(() => {
  const RUNTIME_VERSION = 2;
  try { globalThis.__chatgptNotifierMonitorRuntime?.dispose?.(); } catch {}

  const abortController = new AbortController();
  const documentId = (() => { try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random()}`; } })();
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const STOP_SELECTOR = 'button[data-testid="stop-button"], button[data-testid="fruitjuice-stop-button"], button[aria-label="Stop generating"]';
  const WORK_START_LINE = '[GITHUB_WORK: START]';
  const thresholds = globalThis.ChatGPTNotifierContinuationPolicy?.thresholds || {};
  const MISSING_FOOTER_GRACE_MS = Number(thresholds.missingFooterGraceMs || 30_000);
  const SILENT_IDLE_FIRST_MS = Number(thresholds.silentIdleFirstMs || 90_000);
  const SILENT_IDLE_CONFIRM_MS = Number(thresholds.silentIdleConfirmMs || 30_000);

  let disposed = false;
  let observer = null;
  let publishTimer = null;
  let stableFooterTimer = null;
  let silentFirstTimer = null;
  let silentSecondTimer = null;
  let requestPhase = 'unknown';
  let requestStartedAt = 0;
  let requestSettledAt = 0;
  let requestId = '';
  let manualStopped = false;
  let manualStopPromptKey = '';
  let silentIdleConfirmations = 0;
  let stableTerminal = false;
  let lastIdentityKey = '';

  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function revisionOf(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `${text.length}:${hash.toString(16).padStart(8, '0')}`;
  }

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

  function roleRoot(turn, role) {
    try {
      const selector = `[data-message-author-role="${role}"]`;
      return turn?.matches?.(selector) ? turn : turn?.querySelector?.(selector);
    } catch { return null; }
  }

  function turnText(turn, role) {
    try {
      const roleNode = roleRoot(turn, role);
      const node = roleNode?.querySelector?.('.markdown, [class*="prose"]') || roleNode;
      return String(node?.innerText || node?.textContent || '').replace(/\r\n?/g, '\n').trimEnd();
    } catch { return ''; }
  }

  function assistantHasWorkStart(turn) {
    try {
      const roleNode = roleRoot(turn, 'assistant');
      const source = roleNode?.querySelector?.('.markdown, [class*="prose"]') || roleNode;
      if (!source) return false;
      const copy = source.cloneNode(true);
      for (const excluded of copy.querySelectorAll?.('pre, code, blockquote') || []) excluded.remove();
      const candidates = [copy, ...(copy.querySelectorAll?.('p, li, div, span') || [])];
      return candidates.some((candidate) => String(candidate.textContent || '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .some((line) => line.trim() === WORK_START_LINE));
    } catch { return false; }
  }

  function composerElement() {
    for (const selector of ['#prompt-textarea', 'textarea[data-testid="prompt-textarea"]', '[contenteditable="true"][data-testid="prompt-textarea"]']) {
      try {
        const node = document.querySelector(selector);
        if (node) return node;
      } catch {}
    }
    return null;
  }

  function composerHasDraft() {
    const node = composerElement();
    if (!node) return false;
    try {
      const value = 'value' in node ? node.value : (node.innerText || node.textContent || '');
      return normalize(value).length > 0;
    } catch { return false; }
  }

  function uploadPresent() {
    try {
      return Array.from(document.querySelectorAll('input[type="file"]')).some((input) => Number(input?.files?.length || 0) > 0);
    } catch { return false; }
  }

  function scopedApplicationState() {
    const result = {
      rateLimited: false,
      authRequired: false,
      approvalRequired: false,
      explicitInterruption: false,
      interruptionKind: ''
    };
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll('[role="alert"], [data-testid="toast"], [data-testid*="error"]')).slice(-12); } catch {}
    for (const node of nodes) {
      try { if (node.closest(TURN_SELECTOR)) continue; } catch {}
      const text = normalize(node?.innerText || node?.textContent || '').toLowerCase();
      if (!text) continue;
      if (/too many requests|rate limit|try again later/.test(text)) result.rateLimited = true;
      if (/session expired|please log in|please sign in|authentication required/.test(text)) result.authRequired = true;
      if (/approval required|requires approval|approve this action/.test(text)) result.approvalRequired = true;
      const interruption = [
        ['connection-interrupted', /connection interrupted|network error|connection lost/],
        ['systems-taking-longer', /systems? (?:are )?taking longer|taking longer than expected/],
        ['timed-out', /timed out|request timeout/],
        ['generation-error', /failed to (?:generate|respond)|something went wrong|there was an error/]
      ].find(([, pattern]) => pattern.test(text));
      if (interruption) {
        result.explicitInterruption = true;
        if (!result.interruptionKind) result.interruptionKind = interruption[0];
      }
    }
    return result;
  }

  function latestTurnState() {
    const identity = conversationIdentity();
    const nodes = turns();
    let userIndex = -1;
    for (let index = 0; index < nodes.length; index += 1) if (roleOf(nodes[index]) === 'user') userIndex = index;
    if (!identity || userIndex < 0) return { identity, promptKey: '', promptRevision: '', assistantKey: '', assistantRevision: '', statusCode: '', workStartSignal: false };

    const userId = turnId(nodes[userIndex], 'user', userIndex);
    const userText = turnText(nodes[userIndex], 'user');
    let assistantIndex = -1;
    let assistantText = '';
    for (let index = userIndex + 1; index < nodes.length; index += 1) {
      if (roleOf(nodes[index]) !== 'assistant') continue;
      const text = turnText(nodes[index], 'assistant');
      if (!text) continue;
      assistantIndex = index;
      assistantText = text;
    }
    const parsed = assistantText ? globalThis.ChatGPTNotifierStatusCode?.parseTerminalStatus?.(assistantText) : null;
    return {
      identity,
      promptKey: `${identity.id}|${userId}`,
      promptRevision: revisionOf(userText),
      assistantKey: assistantIndex >= 0 ? turnId(nodes[assistantIndex], 'assistant', assistantIndex) : '',
      assistantRevision: assistantText ? revisionOf(assistantText) : '',
      statusCode: String(parsed?.statusCode || ''),
      workStartSignal: assistantIndex >= 0 && assistantHasWorkStart(nodes[assistantIndex])
    };
  }

  function snapshot() {
    const turnState = latestTurnState();
    const app = scopedApplicationState();
    const promptChanged = turnState.promptKey && turnState.promptKey !== manualStopPromptKey;
    if (manualStopped && promptChanged) manualStopped = false;
    if (turnState.promptKey) manualStopPromptKey = turnState.promptKey;
    const stopGenerating = (() => { try { return Boolean(document.querySelector(STOP_SELECTOR)); } catch { return false; } })();
    const observable = Boolean(turnState.identity && document.documentElement && !disposed);
    return {
      monitorRuntimeVersion: RUNTIME_VERSION,
      policyVersion: Number(globalThis.ChatGPTNotifierContinuationPolicy?.monitorPolicyVersion || 0),
      conversationId: turnState.identity?.id || '',
      conversationUrl: turnState.identity?.url || '',
      documentId,
      promptKey: turnState.promptKey,
      promptRevision: turnState.promptRevision,
      assistantKey: turnState.assistantKey,
      assistantRevision: turnState.assistantRevision,
      statusCode: turnState.statusCode,
      workStartSignal: turnState.workStartSignal === true,
      observable,
      online: navigator.onLine !== false,
      manualStopped,
      hasDraft: composerHasDraft(),
      hasUpload: uploadPresent(),
      stopGenerating,
      toolActivity: false,
      stableTerminal,
      silentIdleConfirmations,
      requestPhase,
      requestId,
      requestStartedAt,
      requestSettledAt,
      workingDurationMs: requestStartedAt > 0 && requestPhase === 'started' ? Math.max(0, Date.now() - requestStartedAt) : 0,
      ...app
    };
  }

  function clearTimer(name) {
    const value = name === 'stable' ? stableFooterTimer : name === 'silent-first' ? silentFirstTimer : silentSecondTimer;
    if (value === null) return;
    clearTimeout(value);
    if (name === 'stable') stableFooterTimer = null;
    else if (name === 'silent-first') silentFirstTimer = null;
    else silentSecondTimer = null;
  }

  function resetStability() {
    stableTerminal = false;
    silentIdleConfirmations = 0;
    clearTimer('stable');
    clearTimer('silent-first');
    clearTimer('silent-second');
  }

  function scheduleStabilityChecks(current) {
    const identityKey = `${current.promptKey}|${current.assistantKey}|${current.assistantRevision}|${current.statusCode}|${current.stopGenerating}|${current.requestPhase}`;
    if (identityKey !== lastIdentityKey) {
      lastIdentityKey = identityKey;
      resetStability();
    }

    if (!current.promptKey || current.statusCode || current.stopGenerating || current.manualStopped || current.hasDraft || current.hasUpload || current.online === false) return;
    if (current.authRequired || current.approvalRequired || current.rateLimited) return;

    if (current.assistantKey) {
      if (stableFooterTimer === null) {
        const expected = `${current.promptKey}|${current.assistantKey}|${current.assistantRevision}`;
        stableFooterTimer = setTimeout(() => {
          stableFooterTimer = null;
          const next = snapshot();
          if (`${next.promptKey}|${next.assistantKey}|${next.assistantRevision}` !== expected || next.statusCode || next.stopGenerating) return;
          stableTerminal = true;
          publishNow();
        }, MISSING_FOOTER_GRACE_MS);
      }
      return;
    }

    if (!['completed', 'error'].includes(current.requestPhase)) return;
    if (silentFirstTimer === null && silentIdleConfirmations === 0) {
      const expectedPrompt = current.promptKey;
      silentFirstTimer = setTimeout(() => {
        silentFirstTimer = null;
        const next = snapshot();
        if (next.promptKey !== expectedPrompt || next.assistantKey || next.stopGenerating || !['completed', 'error'].includes(next.requestPhase)) return;
        silentIdleConfirmations = 1;
        publishNow();
        silentSecondTimer = setTimeout(() => {
          silentSecondTimer = null;
          const again = snapshot();
          if (again.promptKey !== expectedPrompt || again.assistantKey || again.stopGenerating || !['completed', 'error'].includes(again.requestPhase)) return;
          silentIdleConfirmations = 2;
          publishNow();
        }, SILENT_IDLE_CONFIRM_MS);
      }, SILENT_IDLE_FIRST_MS);
    }
  }

  function publishNow() {
    if (disposed) return;
    const current = snapshot();
    scheduleStabilityChecks(current);
    try { chrome.runtime.sendMessage({ type: 'CHATGPT_MONITOR_STATE', snapshot: current }).catch(() => {}); } catch {}
  }

  function schedulePublish() {
    if (disposed || publishTimer !== null) return;
    publishTimer = setTimeout(() => {
      publishTimer = null;
      publishNow();
    }, 200);
  }

  function onTrustedPointer(event) {
    if (event?.isTrusted !== true || !(event.target instanceof Element)) return;
    if (!event.target.closest(STOP_SELECTOR) || composerHasDraft()) return;
    manualStopped = true;
    manualStopPromptKey = latestTurnState().promptKey || manualStopPromptKey;
    resetStability();
    schedulePublish();
  }

  function setRequestPhase(message) {
    const phase = String(message?.phase || '');
    if (!['started', 'completed', 'error'].includes(phase)) return;
    const incomingId = String(message?.requestId || '');
    if (phase === 'started') {
      requestPhase = 'started';
      requestId = incomingId;
      requestStartedAt = Number(message?.observedAt || Date.now());
      requestSettledAt = 0;
      manualStopped = false;
      resetStability();
    } else if (!requestId || !incomingId || requestId === incomingId) {
      requestPhase = phase;
      requestId = incomingId || requestId;
      requestSettledAt = Number(message?.observedAt || Date.now());
    }
    schedulePublish();
  }

  const messageListener = (message, _sender, sendResponse) => {
    if (message?.type === 'CHATGPT_MONITOR_QUERY') {
      const current = snapshot();
      scheduleStabilityChecks(current);
      sendResponse?.({ ok: true, snapshot: current });
      return false;
    }
    if (message?.type === 'CHATGPT_MONITOR_REQUEST_PHASE') {
      setRequestPhase(message);
      sendResponse?.({ ok: true, documentId });
      return false;
    }
    return false;
  };

  chrome.runtime.onMessage.addListener(messageListener);
  try { document.addEventListener('pointerdown', onTrustedPointer, { capture: true, signal: abortController.signal }); } catch {}
  try { window.addEventListener('online', schedulePublish, { signal: abortController.signal }); } catch {}
  try { window.addEventListener('offline', schedulePublish, { signal: abortController.signal }); } catch {}
  try { document.addEventListener('visibilitychange', schedulePublish, { signal: abortController.signal }); } catch {}

  const root = document.querySelector('main') || document.body || document.documentElement;
  if (root && typeof MutationObserver === 'function') {
    observer = new MutationObserver(schedulePublish);
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-testid', 'aria-label', 'aria-disabled', 'disabled'] });
  }

  globalThis.__chatgptNotifierMonitorRuntime = Object.freeze({
    version: RUNTIME_VERSION,
    documentId,
    workStartLine: WORK_START_LINE,
    snapshot,
    dispose() {
      disposed = true;
      abortController.abort();
      observer?.disconnect();
      if (publishTimer !== null) clearTimeout(publishTimer);
      clearTimer('stable');
      clearTimer('silent-first');
      clearTimer('silent-second');
      try { chrome.runtime.onMessage.removeListener(messageListener); } catch {}
    }
  });

  schedulePublish();
})();
