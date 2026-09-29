'use strict';

(() => {
  if (globalThis.__chatgptNotifierStreamTerminalSnapshotNotification) return;

  const RUNTIME_VERSION = 1;
  const RETRY_DELAYS_MS = Object.freeze([75, 350, 1200]);
  const inFlight = new Map();

  function monitor() {
    return globalThis.__chatgptNotifierMonitorBackground || null;
  }

  function authority() {
    return globalThis.__chatgptNotifierTerminalWatchdogAuthority || null;
  }

  function delivery() {
    return globalThis.__chatgptNotifierDeliveryReliability || null;
  }

  function record(status, fields = {}) {
    try { delivery()?.record?.(status, fields); } catch {}
  }

  function sleep(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(delayMs || 0))));
  }

  function isDefinitiveStop(statusCode) {
    const code = String(statusCode || '');
    return globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(code) === true
      && globalThis.ChatGPTNotifierContinuationPolicy?.isDefinitiveStopStatusCode?.(code) === true;
  }

  function targetForSender(sender) {
    const api = monitor();
    if (typeof api?.chatTargetFromTab !== 'function') return null;
    try { return api.chatTargetFromTab(sender?.tab) || null; } catch { return null; }
  }

  function exactSnapshot(message, target) {
    const raw = message?.snapshot || null;
    if (!raw || !target?.id) return null;
    if (String(raw.conversationId || '') !== String(target.id)) return null;

    const promptKey = String(raw.promptKey || '');
    const assistantKey = String(raw.assistantKey || '');
    const assistantRevision = String(raw.assistantRevision || '');
    const requestId = String(raw.requestId || '');
    const requestStartedAt = Math.max(0, Number(raw.requestStartedAt || 0));
    if (!promptKey || !promptKey.startsWith(`${target.id}|`)) return null;
    if (!assistantKey || !assistantRevision || !requestId || !requestStartedAt) return null;

    return {
      conversationId: String(target.id),
      documentId: String(raw.documentId || ''),
      promptKey,
      promptRevision: String(raw.promptRevision || ''),
      assistantKey,
      assistantRevision,
      requestId,
      requestPhase: String(raw.requestPhase || ''),
      requestStartedAt,
      monitorRuntimeVersion: Math.max(0, Number(raw.monitorRuntimeVersion || 0))
    };
  }

  async function exactStoppedWatchdog(statusCode, sender, target, snapshot) {
    const api = monitor();
    if (typeof api?.getEnrollment !== 'function' || typeof api?.readCodeWatchdog !== 'function') return false;

    const [enrollment, watchdog] = await Promise.all([
      api.getEnrollment(String(target.id)).catch(() => null),
      api.readCodeWatchdog(String(target.id)).catch(() => null)
    ]);
    if (enrollment?.enabled !== true || enrollment?.userPaused === true) return false;
    if (!watchdog || watchdog.stopped !== true) return false;
    if (String(watchdog.stopReason || '') !== `status:${statusCode}`) return false;
    if (Math.max(0, Number(watchdog.deadlineAt || 0)) !== 0) return false;
    if (Number.isInteger(watchdog.ownerTabId) && watchdog.ownerTabId !== sender?.tab?.id) return false;
    if (Math.max(0, Number(watchdog.lastRequestStartedAt || 0)) !== snapshot.requestStartedAt) return false;
    if (String(watchdog.lastPromptKey || '') !== snapshot.promptKey) return false;
    return true;
  }

  async function queueExactSnapshotNotification(message, sender) {
    const statusCode = String(message?.statusCode || '');
    if (!isDefinitiveStop(statusCode)) return false;
    const target = targetForSender(sender);
    if (!target?.id || !Number.isInteger(sender?.tab?.id)) return false;

    const snapshot = exactSnapshot(message, target);
    if (!snapshot) {
      record('stream-terminal-snapshot-invalid', {
        tabId: sender?.tab?.id,
        reason: `status=${statusCode};exact-monitor-snapshot-unavailable`,
        conversationId: target.id,
        chromeDocumentId: sender?.documentId
      });
      return false;
    }

    const queueRenderedNotification = authority()?.queueRenderedNotification;
    if (typeof queueRenderedNotification !== 'function') return false;

    for (const delayMs of RETRY_DELAYS_MS) {
      await sleep(delayMs);
      if (!await exactStoppedWatchdog(statusCode, sender, target, snapshot)) continue;

      const queued = await queueRenderedNotification({
        ...message,
        statusCode,
        statusLine: `[GITHUB_STATUS: ${statusCode}]`,
        snapshot
      }, sender, target, statusCode, 'stream-terminal-snapshot-authority').catch(() => false);
      if (!queued) continue;

      record('stream-terminal-snapshot-notification-queued', {
        tabId: sender?.tab?.id,
        reason: `status=${statusCode};delay=${delayMs};watchdog=exact-stopped-request`,
        conversationId: target.id,
        requestId: snapshot.requestId,
        monitorRuntimeId: snapshot.documentId,
        chromeDocumentId: sender?.documentId
      });
      return true;
    }

    record('stream-terminal-snapshot-notification-unroutable', {
      tabId: sender?.tab?.id,
      reason: `status=${statusCode};exact-stopped-watchdog-snapshot-mismatch`,
      conversationId: target.id,
      requestId: snapshot.requestId,
      monitorRuntimeId: snapshot.documentId,
      chromeDocumentId: sender?.documentId
    });
    return false;
  }

  function handleTerminalStatus(message, sender) {
    if (message?.type !== 'CHATGPT_RESPONSE_STREAM_TERMINAL_STATUS') return false;
    const statusCode = String(message?.statusCode || '');
    const target = targetForSender(sender);
    const snapshot = exactSnapshot(message, target);
    const key = [
      sender?.tab?.id ?? '',
      String(sender?.documentId || ''),
      statusCode,
      snapshot?.promptKey || '',
      snapshot?.requestId || ''
    ].join('|');
    if (inFlight.has(key)) return false;
    const run = queueExactSnapshotNotification(message, sender)
      .catch(() => false)
      .finally(() => inFlight.delete(key));
    inFlight.set(key, run);
    return false;
  }

  chrome.runtime.onMessage.addListener(handleTerminalStatus);

  globalThis.__chatgptNotifierStreamTerminalSnapshotNotification = Object.freeze({
    version: RUNTIME_VERSION,
    exactSnapshot,
    exactStoppedWatchdog,
    queueExactSnapshotNotification
  });
})();
