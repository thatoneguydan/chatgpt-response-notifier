'use strict';

(() => {
  if (globalThis.__chatgptNotifierTerminalWatchdogAuthority) return;

  const RUNTIME_VERSION = 2;
  const DB_NAME = 'chatgpt-response-notifier-monitor';
  const DB_VERSION = 1;
  const PROFILE_STORE = 'profile';
  const WATCHDOG_PREFIX = 'code-watchdog:';
  const RESOLVED_NOTIFICATION_STATES = new Set(['notification-queued', 'notification-acked', 'continued', 'closed-by-user', 'superseded']);

  let databasePromise = null;

  function conversationFromUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''));
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

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open watchdog database.'));
      request.onblocked = () => reject(new Error('Watchdog database is blocked.'));
    });
    databasePromise.catch(() => { databasePromise = null; });
    return databasePromise;
  }

  async function readWatchdog(conversationId) {
    const database = await openDatabase();
    const transaction = database.transaction(PROFILE_STORE, 'readonly');
    return await new Promise((resolve, reject) => {
      const request = transaction.objectStore(PROFILE_STORE).get(`${WATCHDOG_PREFIX}${conversationId}`);
      request.onsuccess = () => resolve(request.result ? structuredClone(request.result) : null);
      request.onerror = () => reject(request.error || new Error('Could not read watchdog.'));
    });
  }

  async function writeWatchdog(record) {
    if (!record?.conversationId) return null;
    const database = await openDatabase();
    const next = {
      ...record,
      key: `${WATCHDOG_PREFIX}${record.conversationId}`,
      watchdogRevision: Math.max(0, Number(record.watchdogRevision || 0)) + 1,
      updatedAt: Date.now()
    };
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(PROFILE_STORE, 'readwrite');
      transaction.objectStore(PROFILE_STORE).put(next);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not reset watchdog attempts.'));
      transaction.onabort = () => reject(transaction.error || new Error('Watchdog attempt reset was aborted.'));
    });
    return next;
  }

  function isDefinitiveStop(statusCode) {
    const parser = globalThis.ChatGPTNotifierStatusCode;
    const policy = globalThis.ChatGPTNotifierContinuationPolicy;
    return parser?.isStatusCode?.(statusCode) === true
      && policy?.isDefinitiveStopStatusCode?.(statusCode) === true;
  }

  async function resetStoppedAttempts(conversationId, statusCode) {
    const current = await readWatchdog(conversationId).catch(() => null);
    if (!current || current.stopped !== true) return current;
    if (String(current.stopReason || '') !== `status:${statusCode}`) return current;
    return await writeWatchdog({
      ...current,
      sendCount: 0,
      waitingForRequestStart: false,
      lastAutomaticSentAt: 0,
      lastAutomaticPromptKey: '',
      lastAutomaticParentPromptKey: '',
      deadlineAt: 0,
      retryAt: 0,
      retryReason: ''
    });
  }

  async function publishOverview(target) {
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    if (!target || typeof monitor?.monitorOverview !== 'function' || typeof monitor?.publishAutomationOverview !== 'function') return;
    try {
      const overview = await monitor.monitorOverview(target);
      await monitor.publishAutomationOverview(target, overview);
    } catch {}
  }

  function targetForSender(sender) {
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    if (typeof monitor?.chatTargetFromTab !== 'function') return null;
    try { return monitor.chatTargetFromTab(sender?.tab) || null; } catch { return null; }
  }

  async function automationActive(target) {
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    try {
      const enrollment = await monitor?.getEnrollment?.(String(target?.id || ''));
      return enrollment?.enabled === true && enrollment?.userPaused !== true;
    } catch {
      return false;
    }
  }

  async function parkDefinitiveStatus(message, sender, target, statusCode) {
    const lifecycle = globalThis.__chatgptNotifierWatchdogRequestLifecycleFix;
    if (typeof lifecycle?.parkTerminalStatusForSender !== 'function') return false;
    const result = await lifecycle.parkTerminalStatusForSender({
      conversationId: target.id,
      promptKey: String(message?.snapshot?.promptKey || message?.promptKey || ''),
      statusCode
    }, sender);
    if (result?.ok !== true) return false;
    await resetStoppedAttempts(target.id, statusCode).catch(() => null);
    await publishOverview(target);
    return true;
  }

  function normalizedRenderedSnapshot(message, target) {
    const raw = message?.snapshot || null;
    if (!raw || String(raw.conversationId || '') !== String(target?.id || '')) return null;
    const promptKey = String(raw.promptKey || '');
    const assistantKey = String(raw.assistantKey || '');
    const assistantRevision = String(raw.assistantRevision || '');
    if (!promptKey || !assistantKey || !assistantRevision) return null;
    if (!promptKey.startsWith(`${target.id}|`)) return null;
    return {
      conversationId: target.id,
      conversationUrl: target.url,
      documentId: String(raw.documentId || ''),
      requestId: String(raw.requestId || ''),
      promptKey,
      promptRevision: String(raw.promptRevision || ''),
      assistantKey,
      revision: assistantRevision,
      statusCode: String(message?.statusCode || ''),
      statusLine: String(message?.statusLine || `[GITHUB_STATUS: ${String(message?.statusCode || '')}]`),
      responseBody: '',
      responseText: ''
    };
  }

  async function noteRenderedRun(snapshot, sender) {
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    if (typeof monitor?.updateRun !== 'function') return;
    try {
      await monitor.updateRun({
        conversationId: snapshot.conversationId,
        conversationUrl: snapshot.conversationUrl,
        documentId: snapshot.documentId,
        requestId: snapshot.requestId,
        promptKey: snapshot.promptKey,
        promptRevision: snapshot.promptRevision,
        assistantKey: snapshot.assistantKey,
        assistantRevision: snapshot.revision,
        statusCode: snapshot.statusCode,
        hasStatusEvidence: true,
        requestPhase: 'completed',
        stopGenerating: false,
        toolActivity: false,
        stableTerminal: true,
        observable: true,
        online: true,
        manualStopped: false,
        authRequired: false,
        approvalRequired: false,
        rateLimited: false,
        hasDraft: false,
        hasUpload: false,
        silentIdleConfirmations: 0
      }, sender);
    } catch {}
  }

  async function queueRenderedNotification(message, sender, target, statusCode, source) {
    if (!await automationActive(target)) return false;
    const snapshot = normalizedRenderedSnapshot({ ...message, statusCode }, target);
    if (!snapshot) return false;
    const state = globalThis.__chatgptNotifierCoordinator;
    if (!state || typeof state.claimTurn !== 'function' || typeof queueDurableNotification !== 'function') return false;

    await noteRenderedRun(snapshot, sender);

    const fingerprint = `status|${snapshot.conversationId}|${snapshot.promptKey}|${snapshot.assistantKey}|${snapshot.revision}`;
    const owner = {
      tabId: Number.isInteger(sender?.tab?.id) ? sender.tab.id : null,
      documentId: String(sender?.documentId || snapshot.documentId || ''),
      fingerprint,
      notificationId: crypto.randomUUID(),
      notificationTitle: String(sender?.tab?.title || 'ChatGPT').trim() || 'ChatGPT',
      notificationPreview: 'Response finished.'
    };
    const claim = await state.claimTurn(snapshot, owner);
    let record = claim?.record || null;
    if (!record) return false;

    if (!claim.claimed) {
      if (RESOLVED_NOTIFICATION_STATES.has(String(record.state || ''))) return true;
      if (record.statusCode && String(record.statusCode) !== statusCode) return false;
      const updated = await state.updateTurn(record.turnKey, {
        statusCode,
        statusLine: snapshot.statusLine,
        actionReason: String(record.actionReason || source || 'rendered-terminal-authority')
      }).catch(() => null);
      if (updated) record = updated;
    }

    const deliveryRecord = {
      ...record,
      conversationId: snapshot.conversationId,
      conversationUrl: snapshot.conversationUrl,
      documentId: snapshot.documentId,
      promptKey: snapshot.promptKey,
      assistantKey: snapshot.assistantKey,
      revision: snapshot.revision,
      statusCode,
      statusLine: snapshot.statusLine,
      fingerprint: String(record.fingerprint || fingerprint),
      notificationPreview: String(record.notificationPreview || 'Response finished.')
    };
    await queueDurableNotification(deliveryRecord, source || 'rendered-terminal-authority');
    try {
      globalThis.__chatgptNotifierDeliveryReliability?.record?.('rendered-terminal-notification-queued', {
        tabId: sender?.tab?.id,
        conversationId: target.id,
        notificationId: deliveryRecord.notificationId,
        reason: source || 'rendered-terminal-authority'
      });
    } catch {}
    return true;
  }

  async function identityFromPage(tabId) {
    if (!Number.isInteger(tabId)) return null;
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_RENDERED_TERMINAL_IDENTITY_QUERY' });
      return result?.ok === true && result.snapshot ? result.snapshot : null;
    } catch {
      return null;
    }
  }

  async function handleRenderedTerminal(message, sender) {
    const statusCode = String(message?.statusCode || '');
    if (!isDefinitiveStop(statusCode)) return { ok: false, reason: 'not-definitive-stop-status' };
    const target = targetForSender(sender);
    if (!target?.id || !Number.isInteger(target?.tab?.id)) return { ok: false, reason: 'watchdog-target-unavailable' };
    if (String(message?.snapshot?.conversationId || '') !== target.id) return { ok: false, reason: 'target-conversation-changed' };
    if (!await automationActive(target)) return { ok: false, reason: 'automation-not-active' };

    const [stopped, notified] = await Promise.all([
      parkDefinitiveStatus(message, sender, target, statusCode).catch(() => false),
      queueRenderedNotification(message, sender, target, statusCode, 'rendered-terminal-authority').catch(() => false)
    ]);
    await publishOverview(target);
    return { ok: stopped || notified, stopped, notified, statusCode };
  }

  async function stopFromStream(message, sender) {
    const statusCode = String(message?.statusCode || '');
    if (!isDefinitiveStop(statusCode)) return false;
    const target = targetForSender(sender);
    if (!target?.id || !Number.isInteger(target?.tab?.id)) return false;
    if (!await automationActive(target)) return false;

    const stopped = await parkDefinitiveStatus(message, sender, target, statusCode).catch(() => false);
    const snapshot = await identityFromPage(target.tab.id);
    const notified = snapshot
      ? await queueRenderedNotification({
          ...message,
          statusCode,
          statusLine: `[GITHUB_STATUS: ${statusCode}]`,
          snapshot
        }, sender, target, statusCode, 'stream-terminal-authority').catch(() => false)
      : false;
    await publishOverview(target);
    return stopped || notified;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'CHATGPT_RENDERED_TERMINAL_STATUS') {
      handleRenderedTerminal(message, sender)
        .then((result) => sendResponse?.(result))
        .catch((error) => sendResponse?.({ ok: false, reason: 'rendered-terminal-handler-failed', error: String(error?.message || error) }));
      return true;
    }
    if (message?.type === 'CHATGPT_RESPONSE_STREAM_TERMINAL_STATUS') {
      stopFromStream(message, sender).catch(() => false);
      return false;
    }
    return false;
  });

  globalThis.__chatgptNotifierTerminalWatchdogAuthority = Object.freeze({
    version: RUNTIME_VERSION,
    handleRenderedTerminal,
    stopFromStream,
    queueRenderedNotification,
    resetStoppedAttempts
  });
})();
