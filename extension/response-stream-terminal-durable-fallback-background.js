'use strict';

(() => {
  if (globalThis.__chatgptNotifierStreamTerminalDurableFallback) return;

  const RUNTIME_VERSION = 2;
  const RETRY_DELAYS_MS = Object.freeze([75, 350, 1200]);
  const inFlight = new Map();

  function monitor() {
    return globalThis.__chatgptNotifierMonitorBackground || null;
  }

  function delivery() {
    return globalThis.__chatgptNotifierDeliveryReliability || null;
  }

  function coordinatorState() {
    return globalThis.__chatgptNotifierCoordinator || null;
  }

  function isDefinitiveStop(statusCode) {
    const code = String(statusCode || '');
    return globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(code) === true
      && globalThis.ChatGPTNotifierContinuationPolicy?.isDefinitiveStopStatusCode?.(code) === true;
  }

  function recordDiagnostic(status, fields = {}) {
    try { delivery()?.record?.(status, fields); } catch {}
  }

  function sleep(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(delayMs || 0))));
  }

  function targetForSender(sender) {
    const api = monitor();
    if (typeof api?.chatTargetFromTab !== 'function') return null;
    try { return api.chatTargetFromTab(sender?.tab) || null; } catch { return null; }
  }

  async function queryMonitorSnapshot(sender) {
    const tabId = sender?.tab?.id;
    const chromeDocumentId = String(sender?.documentId || '');
    if (!Number.isInteger(tabId) || !chromeDocumentId) return null;
    try {
      const response = await chrome.tabs.sendMessage(
        tabId,
        { type: 'CHATGPT_MONITOR_QUERY' },
        { documentId: chromeDocumentId }
      );
      return response?.snapshot || response || null;
    } catch {
      return null;
    }
  }

  function exactRequestCandidate(snapshotValue, expected) {
    const snapshot = snapshotValue || null;
    if (!snapshot) return null;
    if (String(snapshot.conversationId || '') !== expected.conversationId) return null;

    const requestId = String(snapshot.requestId || '');
    const requestStartedAt = Math.max(0, Number(snapshot.requestStartedAt || 0));
    const requestPhase = String(snapshot.requestPhase || '');
    if (!requestId || !requestStartedAt || !['started', 'completed', 'error'].includes(requestPhase)) return null;
    if (requestStartedAt !== expected.requestStartedAt) return null;

    const snapshotPromptKey = String(snapshot.promptKey || '');
    if (snapshotPromptKey && snapshotPromptKey !== expected.promptKey) return null;

    return {
      requestId,
      requestStartedAt,
      monitorRuntimeId: String(snapshot.documentId || ''),
      identitySource: expected.identitySource
    };
  }

  function exactDurableRunCandidate(runValue, expected) {
    const run = runValue || null;
    if (!run) return null;
    if (String(run.conversationId || '') !== expected.conversationId) return null;
    if (!Number.isInteger(run.ownerTabId) || run.ownerTabId !== expected.tabId) return null;
    if (String(run.ownerDocumentId || '') !== expected.chromeDocumentId) return null;

    const runPromptKey = String(run.promptKey || run.snapshot?.promptKey || '');
    if (!runPromptKey || runPromptKey !== expected.promptKey) return null;

    return exactRequestCandidate(run.snapshot, {
      conversationId: expected.conversationId,
      promptKey: expected.promptKey,
      requestStartedAt: expected.requestStartedAt,
      identitySource: 'durable-run'
    });
  }

  async function exactStoppedRequestIdentity(statusCode, sender) {
    const target = targetForSender(sender);
    const tabId = sender?.tab?.id;
    const chromeDocumentId = String(sender?.documentId || '');
    if (!target?.id || !Number.isInteger(tabId) || !chromeDocumentId) return null;
    if (Number.isInteger(target?.tab?.id) && target.tab.id !== tabId) return null;

    const api = monitor();
    const [enrollment, snapshot, watchdog, durableRun] = await Promise.all([
      api?.getEnrollment?.(target.id).catch?.(() => null) || null,
      queryMonitorSnapshot(sender),
      api?.readCodeWatchdog?.(target.id).catch?.(() => null) || null,
      api?.latestRunForConversation?.(target.id).catch?.(() => null) || null
    ]);
    if (enrollment?.enabled !== true || enrollment?.userPaused === true) return null;

    if (!watchdog || watchdog.stopped !== true) return null;
    if (String(watchdog.stopReason || '') !== `status:${statusCode}`) return null;
    if (Math.max(0, Number(watchdog.deadlineAt || 0)) !== 0) return null;

    const requestStartedAt = Math.max(0, Number(watchdog.lastRequestStartedAt || 0));
    const promptKey = String(watchdog.lastPromptKey || '');
    if (!requestStartedAt || !promptKey || !promptKey.startsWith(`${target.id}|`)) return null;

    const expected = {
      conversationId: String(target.id),
      promptKey,
      requestStartedAt,
      tabId,
      chromeDocumentId,
      identitySource: 'page-snapshot'
    };

    const candidate = exactRequestCandidate(snapshot, expected)
      || exactDurableRunCandidate(durableRun, expected);
    if (!candidate) return null;

    return {
      conversationId: String(target.id),
      conversationUrl: String(target.url || sender?.tab?.url || ''),
      promptKey,
      requestId: candidate.requestId,
      requestStartedAt: candidate.requestStartedAt,
      monitorRuntimeId: candidate.monitorRuntimeId,
      chromeDocumentId,
      tabId,
      statusCode,
      identitySource: candidate.identitySource,
      transport: 'stream-terminal-durable-fallback'
    };
  }

  async function queueFallbackNotification(statusCode, sender) {
    const identity = await exactStoppedRequestIdentity(statusCode, sender);
    if (!identity) return null;

    const sharedDelivery = globalThis.__chatgptNotifierDeliveryDedupeHook;
    const state = coordinatorState();
    if (!sharedDelivery?.reserveRequestDelivery
      || !sharedDelivery?.commitRequestDelivery
      || !sharedDelivery?.releaseRequestDelivery
      || typeof state?.queueNotification !== 'function') return null;

    const notificationId = crypto.randomUUID();
    const reservation = await sharedDelivery.reserveRequestDelivery(identity, {
      tabId: identity.tabId,
      documentId: identity.chromeDocumentId,
      requestId: identity.requestId,
      notificationId,
      claimSource: 'response-stream-terminal-durable-fallback'
    });
    if (!reservation?.reserved) {
      if (String(reservation?.record?.state || '') === 'committed') {
        return String(reservation?.record?.notificationId || 'already-delivered');
      }
      return null;
    }

    const notification = {
      id: notificationId,
      conversationId: identity.conversationId,
      conversationUrl: identity.conversationUrl,
      title: String(sender?.tab?.title || 'ChatGPT').trim() || 'ChatGPT',
      preview: 'Response finished.',
      statusCode: identity.statusCode,
      completedAt: new Date().toISOString()
    };
    const fingerprint = `stream-fallback|${identity.conversationId}|${identity.requestId}|${identity.statusCode}`;

    try {
      await state.queueNotification('', notification, fingerprint);
      if (typeof rememberNotificationHistory === 'function') {
        await rememberNotificationHistory(notification, fingerprint);
      }
      if (typeof finalizeRecovery === 'function') await finalizeRecovery(identity.conversationId);
      await sharedDelivery.commitRequestDelivery(reservation.deliveryKey, {
        notificationId,
        claimSource: 'response-stream-terminal-durable-fallback'
      });
      recordDiagnostic('response-stream-terminal-fallback-queued', {
        tabId: identity.tabId,
        reason: `status=${identity.statusCode};watchdog=exact-stopped-request;identity=${identity.identitySource}`,
        conversationId: identity.conversationId,
        notificationId,
        chromeDocumentId: identity.chromeDocumentId,
        requestId: identity.requestId,
        monitorRuntimeId: identity.monitorRuntimeId
      });
      if (typeof flushNotificationOutbox === 'function') flushNotificationOutbox().catch(() => {});
      return notificationId;
    } catch {
      await sharedDelivery.releaseRequestDelivery(reservation.deliveryKey).catch(() => {});
      recordDiagnostic('response-stream-terminal-fallback-error', {
        tabId: identity.tabId,
        reason: `status=${identity.statusCode};durable-notification-queue-failed`,
        conversationId: identity.conversationId,
        chromeDocumentId: identity.chromeDocumentId,
        requestId: identity.requestId,
        monitorRuntimeId: identity.monitorRuntimeId
      });
      return null;
    }
  }

  async function handleTerminalStatus(message, sender) {
    const statusCode = String(message?.statusCode || '');
    if (!isDefinitiveStop(statusCode)) return null;
    const tabId = sender?.tab?.id;
    const chromeDocumentId = String(sender?.documentId || '');
    if (!Number.isInteger(tabId) || !chromeDocumentId) return null;

    const key = `${tabId}|${chromeDocumentId}|${statusCode}`;
    if (inFlight.has(key)) return await inFlight.get(key);
    const run = (async () => {
      for (const delayMs of RETRY_DELAYS_MS) {
        await sleep(delayMs);
        const notificationId = await queueFallbackNotification(statusCode, sender);
        if (notificationId) return notificationId;
      }
      recordDiagnostic('response-stream-terminal-fallback-unroutable', {
        tabId,
        reason: `status=${statusCode};exact-stopped-request-identity-unavailable`,
        chromeDocumentId
      });
      return null;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, run);
    return await run;
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== 'CHATGPT_RESPONSE_STREAM_TERMINAL_STATUS') return false;
    handleTerminalStatus(message, sender).catch(() => {});
    return false;
  });

  globalThis.__chatgptNotifierStreamTerminalDurableFallback = Object.freeze({
    version: RUNTIME_VERSION,
    handleTerminalStatus,
    exactStoppedRequestIdentity
  });
})();
