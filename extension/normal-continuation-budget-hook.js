'use strict';

(() => {
  if (globalThis.__chatgptNotifierNormalContinuationBudgetHook) return;
  const originalRequestContinuation = globalThis.requestContinuation;
  if (typeof originalRequestContinuation !== 'function') return;

  const REQUEST_FILTER = {
    urls: [
      'https://chatgpt.com/backend-api/f/conversation*',
      'https://chatgpt.com/backend-api/conversation*'
    ]
  };
  const watchers = new Map();
  const codedCompletionRequests = new Set();
  const codedSnapshotObservations = new Set();

  function normalizePathname(url) {
    try { return new URL(url).pathname.replace(/\/+$/, ''); } catch { return ''; }
  }
  function isAnswerStreamRequest(details) {
    if (details.tabId < 0 || details.method !== 'POST') return false;
    const path = normalizePathname(details.url);
    return path === '/backend-api/f/conversation' || path === '/backend-api/conversation';
  }
  function conversationId(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''));
      const parts = url.pathname.split('/').filter(Boolean);
      for (let index = parts.length - 2; index >= 0; index -= 1) {
        if (parts[index] === 'c') return decodeURIComponent(parts[index + 1] || '').trim();
      }
    } catch {}
    return '';
  }

  function startWatch(tabId) {
    const existing = watchers.get(tabId);
    if (existing) existing.finish({ accepted: false, reason: 'superseded-normal-watch' });
    let requestId = '';
    let settled = false;
    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    const timer = setTimeout(() => watcher.finish({ accepted: false, reason: 'request-evidence-timeout' }), 12_000);
    const watcher = {
      promise,
      get requestId() { return requestId; },
      setRequestId(value) { if (!requestId) requestId = String(value || ''); },
      finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (watchers.get(tabId) === watcher) watchers.delete(tabId);
        resolvePromise({ requestId, ...(result || {}) });
      }
    };
    watchers.set(tabId, watcher);
    return watcher;
  }

  chrome.webRequest.onBeforeRequest.addListener((details) => {
    if (!isAnswerStreamRequest(details)) return;
    const watcher = watchers.get(details.tabId);
    if (!watcher || watcher.requestId) return;
    watcher.setRequestId(details.requestId);
  }, REQUEST_FILTER);

  chrome.webRequest.onHeadersReceived.addListener((details) => {
    if (!isAnswerStreamRequest(details)) return;
    const watcher = watchers.get(details.tabId);
    if (!watcher || !watcher.requestId || watcher.requestId !== String(details.requestId || '')) return;
    const accepted = details.statusCode >= 200 && details.statusCode < 300;
    watcher.finish({ accepted, reason: accepted ? 'request-accepted' : 'request-rejected', statusCode: details.statusCode });
  }, REQUEST_FILTER);

  chrome.webRequest.onErrorOccurred.addListener((details) => {
    if (!isAnswerStreamRequest(details)) return;
    const watcher = watchers.get(details.tabId);
    if (!watcher || !watcher.requestId || watcher.requestId !== String(details.requestId || '')) return;
    watcher.finish({ accepted: false, reason: 'request-error', error: String(details.error || '') });
  }, REQUEST_FILTER);

  async function observeCodedCompletion(tabId, requestId) {
    if (!Number.isInteger(tabId)) return null;
    if (typeof queryTerminalStatus !== 'function' || typeof coordinator !== 'function') return null;

    const status = await queryTerminalStatus(tabId, '', 30_000);
    const statusCode = String(status?.statusCode || '');
    if (!globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(statusCode)) return null;
    if (!status?.conversationId || !status?.documentId || !status?.promptKey || !status?.assistantKey || !status?.revision) return null;

    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch { return null; }
    if (tab?.discarded === true || tab?.frozen === true) return null;
    if (conversationId(tab?.url) !== String(status.conversationId)) return null;

    const state = coordinator();
    if (!state) return null;
    const owner = {
      tabId,
      documentId: String(status.documentId),
      fingerprint: `status|${String(status.conversationId)}|${String(status.promptKey)}|${String(status.assistantKey)}|${String(status.revision)}`,
      notificationId: crypto.randomUUID(),
      notificationTitle: String(tab?.title || 'ChatGPT').trim() || 'ChatGPT',
      notificationPreview: typeof truncateResponse === 'function'
        ? truncateResponse(status?.responseBody || status?.responseText)
        : 'Response finished.'
    };
    const claim = await state.claimTurn(status, owner);
    if (!claim?.claimed) {
      if (typeof flushNotificationOutbox === 'function') flushNotificationOutbox().catch(() => {});
      return null;
    }

    const record = claim.record;
    if (!record?.turnKey) return null;
    try { activeTurnKeys.add(record.turnKey); } catch {}
    try {
      if (statusCode !== 'INCOMPLETE_LIMIT') {
        return await queueDurableNotification(record, 'coded-completion-status-observer');
      }
      return await handleContinuationClaim(record, status, tabId, String(status.documentId));
    } finally {
      try { activeTurnKeys.delete(record.turnKey); } catch {}
    }
  }

  function scheduleObservedStatusDelivery(message, sender) {
    if (message?.type !== 'CHATGPT_MONITOR_STATE') return;
    const snapshot = message?.snapshot || {};
    const statusCode = String(snapshot.statusCode || '');
    if (!globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(statusCode)) return;
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId)) return;
    const logicalKey = [
      tabId,
      String(snapshot.conversationId || ''),
      String(snapshot.promptKey || ''),
      String(snapshot.assistantKey || ''),
      statusCode,
      String(snapshot.assistantRevision || '')
    ].join('|');
    if (!snapshot.conversationId || !snapshot.promptKey || !snapshot.assistantKey || codedSnapshotObservations.has(logicalKey)) return;
    codedSnapshotObservations.add(logicalKey);
    if (codedSnapshotObservations.size > 200) codedSnapshotObservations.delete(codedSnapshotObservations.values().next().value);
    Promise.resolve()
      .then(() => observeCodedCompletion(tabId, `monitor-status:${logicalKey}`))
      .catch((error) => console.warn('Observed coded status delivery failed', error));
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    scheduleObservedStatusDelivery(message, sender);
    return false;
  });

  chrome.webRequest.onCompleted.addListener((details) => {
    if (!isAnswerStreamRequest(details)) return;
    if (details.statusCode < 200 || details.statusCode >= 300) return;
    const requestKey = `${details.tabId}|${String(details.requestId || '')}`;
    if (codedCompletionRequests.has(requestKey)) return;
    codedCompletionRequests.add(requestKey);
    observeCodedCompletion(details.tabId, details.requestId)
      .catch((error) => console.warn('Coded completion observation failed', error))
      .finally(() => codedCompletionRequests.delete(requestKey));
  }, REQUEST_FILTER);

  globalThis.requestContinuation = async function boundedRequestContinuation(tabId, senderDocumentId, expected) {
    const recovery = globalThis.__chatgptNotifierBoundedRecovery;
    if (!recovery) return await originalRequestContinuation(tabId, senderDocumentId, expected);

    // Pause is an automation veto, not just a recovery preference. Check the
    // authoritative combined setting immediately before spending a continuation
    // action so a late operator Pause cannot race through the old path.
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    let enrollment = null;
    try { enrollment = await monitor?.getEnrollment?.(String(expected?.conversationId || '')); } catch {}
    if (enrollment?.enabled !== true || enrollment?.recoveryEnabled !== true || enrollment?.userPaused === true) {
      return {
        ok: false,
        clicked: false,
        reason: 'build-automation-paused',
        documentId: senderDocumentId || ''
      };
    }

    const admission = await recovery.admitNormalContinuation({
      conversationId: String(expected?.conversationId || ''),
      conversationUrl: String(expected?.conversationUrl || ''),
      documentId: String(expected?.documentId || senderDocumentId || ''),
      promptKey: String(expected?.promptKey || ''),
      promptRevision: String(expected?.promptRevision || ''),
      assistantKey: String(expected?.assistantKey || ''),
      assistantRevision: String(expected?.revision || ''),
      tabId
    });
    if (!admission?.allowed) {
      return { ok: false, clicked: false, reason: `bounded-${admission?.reason || 'continuation-not-admitted'}`, documentId: senderDocumentId || '' };
    }

    const watcher = startWatch(tabId);
    let action = null;
    try { action = await originalRequestContinuation(tabId, senderDocumentId, expected); }
    catch { action = null; }
    if (!action?.clicked) watcher.finish({ accepted: false, reason: action?.reason || 'continuation-not-clicked' });
    const evidence = await watcher.promise;
    let sameConversation = false;
    try { sameConversation = conversationId((await chrome.tabs.get(tabId))?.url) === String(expected?.conversationId || ''); } catch {}
    const confirmed = action?.ok === true && Boolean(action?.continuationUserKey) && evidence?.accepted === true && sameConversation;

    await recovery.finishNormalContinuation(admission, {
      success: confirmed,
      uncertain: action?.clicked === true && !confirmed,
      newPromptKey: confirmed ? String(action.continuationUserKey) : '',
      conversationId: String(expected?.conversationId || ''),
      parentGenerationKey: `${String(expected?.conversationId || '')}|${String(expected?.promptKey || '')}`
    });
    return action || { ok: false, clicked: false, reason: 'continuation-command-unreachable', documentId: senderDocumentId || '' };
  };

  chrome.tabs.onRemoved.addListener((tabId) => {
    const watcher = watchers.get(tabId);
    if (watcher) watcher.finish({ accepted: false, reason: 'owner-tab-closed' });
  });

  globalThis.__chatgptNotifierNormalContinuationBudgetHook = Object.freeze({
    version: 4,
    observeCodedCompletion,
    scheduleObservedStatusDelivery
  });
})();