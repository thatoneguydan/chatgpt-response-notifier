'use strict';

(() => {
  if (globalThis.__chatgptNotifierNormalContinuationBudgetHook) return;
  if (!globalThis.__chatgptNotifierDeliveryReliability) {
    try { importScripts('delivery-reliability-background.js'); } catch (error) {
      console.warn('Delivery reliability layer failed to load', error);
    }
  }
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
  const observationRuns = new Map();

  function reliability() {
    return globalThis.__chatgptNotifierDeliveryReliability || null;
  }

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

  function observationMatchesStatus(observation, status) {
    if (!observation || !status) return false;
    if (!globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(String(status.statusCode || ''))) return false;
    if (String(status.conversationId || '') !== String(observation.conversationId || '')) return false;
    if (String(status.promptKey || '') !== String(observation.promptKey || '')) return false;
    if (observation.promptRevision && String(status.promptRevision || '') !== String(observation.promptRevision || '')) return false;
    if (String(status.assistantKey || '') !== String(observation.assistantKey || '')) return false;
    if (String(status.revision || '') !== String(observation.assistantRevision || '')) return false;
    if (String(status.statusCode || '') !== String(observation.statusCode || '')) return false;
    return true;
  }

  async function tabForObservation(observation) {
    let tab = null;
    try { tab = await chrome.tabs.get(observation.tabId); } catch { return { state: 'closed', tab: null }; }
    if (tab?.discarded === true || tab?.frozen === true) return { state: 'temporarily-unavailable', tab };
    if (conversationId(tab?.url) !== String(observation.conversationId || '')) return { state: 'superseded', tab };
    return { state: 'current', tab };
  }

  async function terminateClaimedTurn(record, stateName, reason) {
    const state = typeof coordinator === 'function' ? coordinator() : null;
    try {
      await state?.updateTurn?.(record?.turnKey, {
        state: stateName,
        actionReason: String(reason || stateName)
      });
    } catch {}
  }

  function deliveryCorrelation(observation) {
    return String(observation?.correlationId || '');
  }

  async function processObservation(observationKey) {
    if (!observationKey) return null;
    if (observationRuns.has(observationKey)) return await observationRuns.get(observationKey);

    const run = (async () => {
      const delivery = reliability();
      if (!delivery) return null;

      let observation = await delivery.getObservation(observationKey);
      if (!observation || !['pending', 'in-flight'].includes(String(observation.state || ''))) return null;
      if (Number(observation.nextAttemptAt || 0) > Date.now()) {
        await delivery.scheduleObservationAlarm();
        return null;
      }

      observation = await delivery.noteObservationAttempt(observationKey);
      if (!observation || !['pending', 'in-flight'].includes(String(observation.state || ''))) return null;

      let claimedRecord = null;
      let statusRuntimeId = '';
      try {
        const beforeQuery = await tabForObservation(observation);
        if (beforeQuery.state === 'closed') {
          await delivery.resolveObservation(observationKey, 'owner-tab-closed');
          return null;
        }
        if (beforeQuery.state === 'superseded') {
          await delivery.resolveObservation(observationKey, 'conversation-superseded-before-query');
          return null;
        }
        if (beforeQuery.state !== 'current') {
          await delivery.deferObservation(observationKey, 'tab-temporarily-unavailable');
          return null;
        }

        let status = null;
        try {
          status = await queryTerminalStatus(observation.tabId, observation.chromeDocumentId, 10_000);
        } catch (error) {
          await delivery.deferObservation(observationKey, `status-query-error:${String(error?.message || error || 'unknown')}`);
          return null;
        }

        if (!status) {
          await delivery.deferObservation(observationKey, 'status-query-unavailable');
          return null;
        }

        statusRuntimeId = String(status.documentId || '');
        if (!observationMatchesStatus(observation, status)) {
          await delivery.resolveObservation(observationKey, 'terminal-identity-superseded', { statusRuntimeId });
          return null;
        }

        const afterQuery = await tabForObservation(observation);
        if (afterQuery.state === 'closed') {
          await delivery.resolveObservation(observationKey, 'owner-tab-closed', { statusRuntimeId });
          return null;
        }
        if (afterQuery.state === 'superseded') {
          await delivery.resolveObservation(observationKey, 'conversation-superseded-after-query', { statusRuntimeId });
          return null;
        }
        if (afterQuery.state !== 'current') {
          await delivery.deferObservation(observationKey, 'tab-temporarily-unavailable-after-query', { statusRuntimeId });
          return null;
        }

        const currentObservation = await delivery.getObservation(observationKey);
        if (!currentObservation || !['pending', 'in-flight'].includes(String(currentObservation.state || ''))) return null;

        const state = typeof coordinator === 'function' ? coordinator() : null;
        if (!state) {
          await delivery.deferObservation(observationKey, 'coordinator-unavailable', { statusRuntimeId });
          return null;
        }

        const owner = {
          tabId: observation.tabId,
          documentId: statusRuntimeId,
          fingerprint: `status|${String(status.conversationId)}|${String(status.promptKey)}|${String(status.assistantKey)}|${String(status.revision)}`,
          notificationId: crypto.randomUUID(),
          notificationTitle: String(afterQuery.tab?.title || 'ChatGPT').trim() || 'ChatGPT',
          notificationPreview: typeof truncateResponse === 'function'
            ? truncateResponse(status?.responseBody || status?.responseText)
            : 'Response finished.'
        };
        const claim = await state.claimTurn(status, owner);
        if (!claim?.claimed) {
          const existing = claim?.record || null;
          if (!existing?.turnKey) {
            await delivery.deferObservation(observationKey, `claim-refused:${String(claim?.reason || 'unknown')}`, { statusRuntimeId });
            return null;
          }

          if (activeTurnKeys.has(String(existing.turnKey))) {
            await delivery.deferObservation(observationKey, 'turn-owned-by-active-delivery', { statusRuntimeId });
            return null;
          }

          if (['continued', 'notification-queued', 'notification-acked', 'closed-by-user', 'superseded'].includes(String(existing.state || ''))) {
            await delivery.resolveObservation(observationKey, `existing-${String(existing.state || 'resolved')}`, { statusRuntimeId });
            if (typeof flushNotificationOutbox === 'function') flushNotificationOutbox().catch(() => {});
            return null;
          }

          const recovered = {
            ...existing,
            ownerChromeDocumentId: observation.chromeDocumentId,
            statusRuntimeId,
            monitorRuntimeId: observation.monitorRuntimeId,
            deliveryCorrelationId: deliveryCorrelation(observation)
          };
          await queueDurableNotification(recovered, `observation-reconciled-${String(existing.state || 'unknown')}-without-replay`);
          await delivery.resolveObservation(observationKey, 'notification-queued-from-unresolved-claim', { statusRuntimeId });
          return recovered.notificationId || null;
        }

        claimedRecord = {
          ...claim.record,
          ownerChromeDocumentId: observation.chromeDocumentId,
          statusRuntimeId,
          monitorRuntimeId: observation.monitorRuntimeId,
          deliveryCorrelationId: deliveryCorrelation(observation)
        };
        try { activeTurnKeys.add(claimedRecord.turnKey); } catch {}
        await state.updateTurn(claimedRecord.turnKey, {
          ownerChromeDocumentId: observation.chromeDocumentId,
          statusRuntimeId,
          monitorRuntimeId: observation.monitorRuntimeId,
          deliveryCorrelationId: deliveryCorrelation(observation)
        });
        delivery.record('turn-claimed', {
          correlationId: deliveryCorrelation(observation),
          tabId: observation.tabId,
          attempt: Number(observation.attempts || 0),
          conversationId: observation.conversationId,
          notificationId: claimedRecord.notificationId,
          chromeDocumentId: observation.chromeDocumentId,
          statusRuntimeId,
          monitorRuntimeId: observation.monitorRuntimeId
        });

        if (String(status.statusCode || '') !== 'INCOMPLETE_LIMIT') {
          const notificationId = await queueDurableNotification(claimedRecord, 'coded-completion-status-observer');
          await delivery.resolveObservation(observationKey, 'notification-queued', { statusRuntimeId });
          return notificationId;
        }

        let verifiedStatus = null;
        try {
          verifiedStatus = await queryTerminalStatus(observation.tabId, observation.chromeDocumentId, 5_000);
        } catch {}
        const beforeSend = await tabForObservation(observation);
        const liveObservation = await delivery.getObservation(observationKey);
        if (!liveObservation || !['pending', 'in-flight'].includes(String(liveObservation.state || ''))) {
          await terminateClaimedTurn(claimedRecord, 'closed-by-user', 'observation-cancelled-before-continuation');
          return null;
        }
        if (beforeSend.state === 'closed') {
          await terminateClaimedTurn(claimedRecord, 'closed-by-user', 'owner-tab-closed-before-continuation');
          await delivery.resolveObservation(observationKey, 'owner-tab-closed-before-continuation', { statusRuntimeId });
          return null;
        }
        if (beforeSend.state === 'superseded' || !observationMatchesStatus(observation, verifiedStatus)) {
          await terminateClaimedTurn(claimedRecord, 'superseded', 'terminal-identity-superseded-before-continuation');
          await delivery.resolveObservation(observationKey, 'terminal-identity-superseded-before-continuation', {
            statusRuntimeId: String(verifiedStatus?.documentId || statusRuntimeId)
          });
          return null;
        }
        if (beforeSend.state !== 'current') {
          const notificationId = await queueDurableNotification(claimedRecord, 'page-unavailable-before-continuation');
          await delivery.resolveObservation(observationKey, 'notification-queued-page-unavailable', { statusRuntimeId });
          return notificationId;
        }

        const result = await handleContinuationClaim(
          claimedRecord,
          verifiedStatus,
          observation.tabId,
          observation.chromeDocumentId
        );
        await delivery.resolveObservation(
          observationKey,
          result ? 'notification-queued-after-continuation-refusal' : 'continuation-confirmed',
          { statusRuntimeId: String(verifiedStatus?.documentId || statusRuntimeId) }
        );
        return result;
      } catch (error) {
        const delivery = reliability();
        if (claimedRecord?.turnKey) {
          try {
            const notificationId = await queueDurableNotification(claimedRecord, 'observation-error-after-claim-without-replay');
            await delivery?.resolveObservation?.(observationKey, 'notification-queued-after-observation-error', { statusRuntimeId });
            return notificationId;
          } catch {}
        }
        await delivery?.deferObservation?.(
          observationKey,
          `observation-error:${String(error?.message || error || 'unknown')}`,
          { statusRuntimeId }
        );
        return null;
      } finally {
        if (claimedRecord?.turnKey) {
          try { activeTurnKeys.delete(claimedRecord.turnKey); } catch {}
        }
      }
    })().finally(() => observationRuns.delete(observationKey));

    observationRuns.set(observationKey, run);
    return await run;
  }

  async function scheduleObservedStatusDelivery(message, sender) {
    if (message?.type !== 'CHATGPT_MONITOR_STATE') return null;
    const snapshot = message?.snapshot || {};
    const statusCode = String(snapshot.statusCode || '');
    if (!globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(statusCode)) return null;
    const tabId = sender?.tab?.id;
    const chromeDocumentId = String(sender?.documentId || '');
    if (!Number.isInteger(tabId) || !chromeDocumentId) {
      reliability()?.record?.('monitor-terminal-unroutable', {
        tabId,
        reason: chromeDocumentId ? 'tab-id-missing' : 'chrome-document-id-missing',
        conversationId: snapshot.conversationId,
        monitorRuntimeId: snapshot.documentId
      });
      return null;
    }
    if (!snapshot.conversationId || !snapshot.promptKey || !snapshot.assistantKey || !snapshot.assistantRevision) return null;

    const delivery = reliability();
    if (!delivery) return null;
    const observation = await delivery.enqueueObservation({
      tabId,
      chromeDocumentId,
      monitorRuntimeId: String(snapshot.documentId || ''),
      conversationId: String(snapshot.conversationId || ''),
      conversationUrl: String(snapshot.conversationUrl || sender?.tab?.url || ''),
      promptKey: String(snapshot.promptKey || ''),
      promptRevision: String(snapshot.promptRevision || ''),
      assistantKey: String(snapshot.assistantKey || ''),
      assistantRevision: String(snapshot.assistantRevision || ''),
      statusCode
    });
    if (!observation) return null;

    delivery.record('monitor-terminal-seen', {
      correlationId: observation.correlationId,
      tabId,
      attempt: Number(observation.attempts || 0),
      conversationId: observation.conversationId,
      chromeDocumentId,
      monitorRuntimeId: observation.monitorRuntimeId,
      reason: observation.state === 'pending' ? 'new-or-pending-observation' : `existing-${String(observation.state || 'unknown')}`
    });

    if (!['pending', 'in-flight'].includes(String(observation.state || ''))) return null;
    return await processObservation(observation.observationKey);
  }

  async function resumePendingObservations(tabId = null) {
    const delivery = reliability();
    if (!delivery) return;
    const pending = await delivery.listPendingObservations(Number.isInteger(tabId) ? tabId : null);
    const now = Date.now();
    for (const observation of pending) {
      if (Number(observation.nextAttemptAt || 0) > now) continue;
      await processObservation(observation.observationKey);
    }
    await delivery.scheduleObservationAlarm();
  }

  async function observeCodedCompletion(tabId, requestId) {
    reliability()?.record?.('request-completion-wake', {
      tabId,
      reason: requestId ? `request-${String(requestId).slice(-16)}` : 'request-completed'
    });
    await resumePendingObservations(tabId);
    return null;
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    scheduleObservedStatusDelivery(message, sender)
      .catch((error) => console.warn('Observed coded status delivery failed', error));
    return false;
  });

  chrome.webRequest.onCompleted.addListener((details) => {
    if (!isAnswerStreamRequest(details)) return;
    if (details.statusCode < 200 || details.statusCode >= 300) return;
    const requestKey = `${details.tabId}|${String(details.requestId || '')}`;
    if (codedCompletionRequests.has(requestKey)) return;
    codedCompletionRequests.add(requestKey);
    observeCodedCompletion(details.tabId, details.requestId)
      .catch((error) => console.warn('Coded completion wake failed', error))
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
    const delivery = reliability();
    if (!delivery) return;
    delivery.listPendingObservations(tabId)
      .then(async (pending) => {
        for (const observation of pending) {
          await delivery.resolveObservation(observation.observationKey, 'owner-tab-closed');
        }
        await delivery.scheduleObservationAlarm();
      })
      .catch(() => {});
  });

  globalThis.__chatgptNotifierNormalContinuationBudgetHook = Object.freeze({
    version: 5,
    observeCodedCompletion,
    scheduleObservedStatusDelivery,
    resumePendingObservations,
    processObservation
  });

  queueMicrotask(() => resumePendingObservations().catch(() => {}));
})();