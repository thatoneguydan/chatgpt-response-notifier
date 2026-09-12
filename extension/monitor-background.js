'use strict';

(() => {
  if (globalThis.__chatgptNotifierMonitorBackground) return;

  const DB_NAME = 'chatgpt-response-notifier-monitor';
  const DB_VERSION = 1;
  const ENROLLMENT_STORE = 'enrollments';
  const RUN_STORE = 'runs';
  const ATTENTION_STORE = 'attention';
  const PROFILE_STORE = 'profile';
  const MAX_RUN_AGE_MS = 14 * 24 * 60 * 60 * 1000;
  const MAX_ATTENTION = 20;
  const REQUEST_FILTER = {
    urls: [
      'https://chatgpt.com/backend-api/f/conversation*',
      'https://chatgpt.com/backend-api/conversation*'
    ]
  };

  let databasePromise = null;
  let attentionFlushPromise = null;
  const requestTabs = new Map();
  const tabConversations = new Map();

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

  function normalizePathname(url) {
    try { return new URL(url).pathname.replace(/\/+$/, ''); } catch { return ''; }
  }

  function isAnswerStreamRequest(details) {
    if (details.tabId < 0 || details.method !== 'POST') return false;
    const path = normalizePathname(details.url);
    return path === '/backend-api/f/conversation' || path === '/backend-api/conversation';
  }

  function clone(value) {
    return value ? structuredClone(value) : value;
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(ENROLLMENT_STORE)) database.createObjectStore(ENROLLMENT_STORE, { keyPath: 'conversationId' });
        if (!database.objectStoreNames.contains(RUN_STORE)) database.createObjectStore(RUN_STORE, { keyPath: 'runKey' });
        if (!database.objectStoreNames.contains(ATTENTION_STORE)) database.createObjectStore(ATTENTION_STORE, { keyPath: 'attentionId' });
        if (!database.objectStoreNames.contains(PROFILE_STORE)) database.createObjectStore(PROFILE_STORE, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open monitored-build database.'));
      request.onblocked = () => reject(new Error('Monitored-build database upgrade was blocked.'));
    });
    databasePromise.catch(() => { databasePromise = null; });
    return databasePromise;
  }

  function requestResult(request, errorMessage) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(errorMessage));
    });
  }

  async function getRecord(storeName, key) {
    const database = await openDatabase();
    const transaction = database.transaction(storeName, 'readonly');
    return clone(await requestResult(transaction.objectStore(storeName).get(key), `Could not read ${storeName}.`)) || null;
  }

  async function putRecord(storeName, record) {
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(record);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error(`Could not write ${storeName}.`));
      transaction.onabort = () => reject(transaction.error || new Error(`${storeName} write was aborted.`));
    });
    return clone(record);
  }

  async function getAll(storeName) {
    const database = await openDatabase();
    const transaction = database.transaction(storeName, 'readonly');
    const records = await requestResult(transaction.objectStore(storeName).getAll(), `Could not list ${storeName}.`);
    return (Array.isArray(records) ? records : []).map(clone);
  }

  async function setEnrollment(identity, enabled, source = 'operator') {
    if (!identity?.id) return null;
    const existing = await getRecord(ENROLLMENT_STORE, identity.id);
    const now = Date.now();
    const record = {
      conversationId: identity.id,
      conversationUrl: identity.url,
      enabled: enabled === true,
      source: String(source || 'operator'),
      enrolledAt: existing?.enrolledAt || now,
      updatedAt: now
    };
    await putRecord(ENROLLMENT_STORE, record);
    return record;
  }

  async function getEnrollment(conversationId) {
    return await getRecord(ENROLLMENT_STORE, String(conversationId || ''));
  }

  function runKey(snapshot) {
    const conversationId = String(snapshot?.conversationId || '');
    const promptKey = String(snapshot?.promptKey || '');
    if (!conversationId || !promptKey) return '';
    return `${conversationId}|${promptKey}`;
  }

  function sanitizedSnapshot(snapshot = {}) {
    return {
      monitorRuntimeVersion: Number(snapshot.monitorRuntimeVersion || 0),
      policyVersion: Number(snapshot.policyVersion || 0),
      conversationId: String(snapshot.conversationId || ''),
      conversationUrl: String(snapshot.conversationUrl || ''),
      documentId: String(snapshot.documentId || ''),
      promptKey: String(snapshot.promptKey || ''),
      promptRevision: String(snapshot.promptRevision || ''),
      assistantKey: String(snapshot.assistantKey || ''),
      assistantRevision: String(snapshot.assistantRevision || ''),
      statusCode: String(snapshot.statusCode || ''),
      observable: snapshot.observable !== false,
      online: snapshot.online !== false,
      manualStopped: snapshot.manualStopped === true,
      hasDraft: snapshot.hasDraft === true,
      hasUpload: snapshot.hasUpload === true,
      stopGenerating: snapshot.stopGenerating === true,
      toolActivity: snapshot.toolActivity === true,
      stableTerminal: snapshot.stableTerminal === true,
      silentIdleConfirmations: Math.max(0, Number(snapshot.silentIdleConfirmations || 0)),
      requestPhase: String(snapshot.requestPhase || ''),
      requestId: String(snapshot.requestId || ''),
      requestStartedAt: Math.max(0, Number(snapshot.requestStartedAt || 0)),
      requestSettledAt: Math.max(0, Number(snapshot.requestSettledAt || 0)),
      workingDurationMs: Math.max(0, Number(snapshot.workingDurationMs || 0)),
      rateLimited: snapshot.rateLimited === true,
      authRequired: snapshot.authRequired === true,
      approvalRequired: snapshot.approvalRequired === true,
      explicitInterruption: snapshot.explicitInterruption === true,
      interruptionKind: String(snapshot.interruptionKind || '')
    };
  }

  async function latestRunForConversation(conversationId) {
    const records = (await getAll(RUN_STORE)).filter((item) => item.conversationId === conversationId);
    records.sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
    return records[0] || null;
  }

  async function openProfileBreaker(reason) {
    const now = Date.now();
    const current = await getRecord(PROFILE_STORE, 'recovery');
    return await putRecord(PROFILE_STORE, {
      key: 'recovery',
      breakerOpen: true,
      breakerReason: String(reason || 'rate-limited'),
      openedAt: current?.breakerOpen ? Number(current.openedAt || now) : now,
      nextProfileActionAt: Math.max(0, Number(current?.nextProfileActionAt || 0)),
      updatedAt: now
    });
  }

  async function readProfileState() {
    return await getRecord(PROFILE_STORE, 'recovery') || {
      key: 'recovery', breakerOpen: false, breakerReason: '', openedAt: 0, nextProfileActionAt: 0, updatedAt: 0
    };
  }

  async function updateRun(snapshotValue, sender = {}) {
    const snapshot = sanitizedSnapshot(snapshotValue);
    const key = runKey(snapshot);
    if (!key) return null;
    const current = await getRecord(RUN_STORE, key);
    const classification = globalThis.ChatGPTNotifierContinuationPolicy?.classifyObservation?.(snapshot) || {
      state: 'waiting', reason: 'monitor-policy-unavailable', automaticActionAllowed: false
    };
    const now = Date.now();
    const record = {
      ...(current || {}),
      runKey: key,
      runId: current?.runId || crypto.randomUUID(),
      conversationId: snapshot.conversationId,
      conversationUrl: snapshot.conversationUrl,
      promptKey: snapshot.promptKey,
      promptRevision: snapshot.promptRevision,
      ownerTabId: Number.isInteger(sender?.tab?.id) ? sender.tab.id : (current?.ownerTabId ?? null),
      ownerDocumentId: String(sender?.documentId || snapshot.documentId || current?.ownerDocumentId || ''),
      tabTitle: String(sender?.tab?.title || current?.tabTitle || 'ChatGPT'),
      state: classification.state,
      reason: classification.reason,
      classification,
      snapshot,
      budget: globalThis.ChatGPTNotifierContinuationPolicy?.normalizeBudget?.(current?.budget || {}) || (current?.budget || {}),
      createdAt: current?.createdAt || now,
      updatedAt: now
    };
    await putRecord(RUN_STORE, record);
    if (classification.openProfileBreaker) await openProfileBreaker(classification.reason);
    if (classification.state === 'attention') await ensureAttention(record, classification.reason);
    if (classification.state === 'coded-terminal') await resolveAttentionForRun(record.runKey, `coded:${snapshot.statusCode}`);
    return record;
  }

  function attentionPreview(reason) {
    const labels = {
      'status-missing': 'The response appears finished but has no valid final GitHub status footer.',
      'silent-stop-confirmed': 'The monitored request appears idle with no assistant response after repeated checks.',
      'rate-limited': 'ChatGPT reported a rate limit. Automatic recovery is paused until you explicitly resume it.',
      'auth-required': 'ChatGPT requires authentication. Automatic recovery will not interact with sign-in controls.',
      'approval-required': 'ChatGPT requires an approval or confirmation. Automatic recovery will not approve it.',
      'page-unobservable': 'The monitored ChatGPT page cannot currently be observed. No reload or Send action was attempted.',
      'owner-tab-closed': 'The monitored ChatGPT tab was closed before the run reached a visible terminal outcome.'
    };
    return labels[reason] || `The monitored build needs attention: ${reason}.`;
  }

  async function ensureAttention(run, reason) {
    if (!run?.runKey || !reason) return null;
    const attentionId = `attention:${run.runId}:${reason}`;
    const existing = await getRecord(ATTENTION_STORE, attentionId);
    if (existing) return existing;
    const now = Date.now();
    const record = {
      attentionId,
      eventKind: 'attention.required',
      runKey: run.runKey,
      runId: run.runId,
      conversationId: run.conversationId,
      conversationUrl: run.conversationUrl,
      title: run.tabTitle || 'ChatGPT',
      reason: String(reason),
      preview: attentionPreview(reason),
      delivered: false,
      acknowledged: false,
      createdAt: now,
      updatedAt: now
    };
    await putRecord(ATTENTION_STORE, record);
    await pruneAttention();
    flushAttention().catch(() => {});
    return record;
  }

  async function resolveAttentionForRun(key, resolution) {
    if (!key) return;
    const records = await getAll(ATTENTION_STORE);
    for (const record of records) {
      if (record.runKey !== key || record.acknowledged) continue;
      await putRecord(ATTENTION_STORE, {
        ...record,
        acknowledged: true,
        resolution: String(resolution || 'resolved'),
        updatedAt: Date.now()
      });
      try { if (typeof sendNative === 'function') sendNative({ type: 'toast.dismissEvent', notificationId: record.attentionId }); } catch {}
    }
  }

  async function pruneAttention() {
    const records = await getAll(ATTENTION_STORE);
    records.sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
    for (const stale of records.slice(MAX_ATTENTION)) {
      const database = await openDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(ATTENTION_STORE, 'readwrite');
        transaction.objectStore(ATTENTION_STORE).delete(stale.attentionId);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('Could not prune attention state.'));
      });
    }
  }

  async function flushAttention() {
    if (attentionFlushPromise) return await attentionFlushPromise;
    attentionFlushPromise = (async () => {
      if (typeof sendNativeRequest !== 'function') return;
      const records = (await getAll(ATTENTION_STORE))
        .filter((item) => !item.delivered && !item.acknowledged)
        .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
      for (const record of records) {
        const response = await sendNativeRequest({
          type: 'toast.show',
          notification: {
            id: record.attentionId,
            kind: 'attention.required',
            conversationId: record.conversationId,
            conversationUrl: record.conversationUrl,
            title: `Needs attention — ${record.title || 'ChatGPT'}`,
            preview: record.preview,
            statusCode: '',
            completedAt: new Date(record.createdAt).toISOString()
          }
        }, ['toast.accepted'], 5000, { queueIfDisconnected: false });
        if (!response || response.accepted !== true || String(response.notificationId || '') !== record.attentionId) return;
        await putRecord(ATTENTION_STORE, { ...record, delivered: true, updatedAt: Date.now() });
      }
    })().finally(() => { attentionFlushPromise = null; });
    return await attentionFlushPromise;
  }

  async function handleSnapshot(snapshot, sender) {
    const clean = sanitizedSnapshot(snapshot);
    if (!clean.conversationId || !clean.promptKey) return null;
    if (Number.isInteger(sender?.tab?.id)) tabConversations.set(sender.tab.id, clean.conversationId);

    const statusIsValid = Boolean(globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(clean.statusCode));
    let enrollment = await getEnrollment(clean.conversationId);
    if (statusIsValid && enrollment?.enabled !== true) {
      enrollment = await setEnrollment({ id: clean.conversationId, url: clean.conversationUrl }, true, 'coded-turn');
    }
    if (enrollment?.enabled !== true) return null;
    return await updateRun(clean, sender);
  }

  async function sendRequestPhase(tabId, phase, details) {
    if (!Number.isInteger(tabId) || tabId < 0) return;
    const message = {
      type: 'CHATGPT_MONITOR_REQUEST_PHASE',
      phase,
      requestId: String(details?.requestId || ''),
      observedAt: Date.now()
    };
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return;
    } catch {}
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.discarded === true || tab.frozen === true) return;
      await chrome.scripting.executeScript({ target: { tabId }, files: ['status-code.js', 'status-policy.js', 'monitor-script.js'] });
      await chrome.tabs.sendMessage(tabId, message);
    } catch {}
  }

  async function injectMonitorIntoExistingTabs() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); } catch { return; }
    for (const tab of tabs) {
      if (!Number.isInteger(tab.id)) continue;
      const identity = conversationFromUrl(tab.url || '');
      if (identity) tabConversations.set(tab.id, identity.id);
      if (tab.discarded === true || tab.frozen === true) {
        if (identity && (await getEnrollment(identity.id))?.enabled === true) {
          const run = await latestRunForConversation(identity.id);
          if (run && run.state !== 'coded-terminal') await ensureAttention(run, 'page-unobservable');
        }
        continue;
      }
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['status-code.js', 'status-policy.js', 'monitor-script.js'] }); } catch {}
    }
  }

  async function activeChatIdentity() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ active: true, currentWindow: true }); } catch { return null; }
    const tab = tabs[0];
    const identity = conversationFromUrl(tab?.url || '');
    return identity && Number.isInteger(tab?.id) ? { ...identity, tab } : null;
  }

  async function monitorOverview(identity = null) {
    const active = identity || await activeChatIdentity();
    const enrollment = active?.id ? await getEnrollment(active.id) : null;
    const run = active?.id ? await latestRunForConversation(active.id) : null;
    const attention = (await getAll(ATTENTION_STORE))
      .filter((item) => !item.acknowledged)
      .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
      .slice(0, MAX_ATTENTION);
    const profile = await readProfileState();
    let helperConnected = false;
    try { helperConnected = typeof bridgeSocket !== 'undefined' && bridgeSocket?.readyState === WebSocket.OPEN; } catch {}
    return {
      activeConversationId: active?.id || '',
      activeConversationUrl: active?.url || '',
      monitoring: enrollment?.enabled === true,
      enrollmentSource: enrollment?.source || '',
      run,
      attention,
      profile,
      helperConnected
    };
  }

  async function acknowledgeAttention(attentionId) {
    const record = await getRecord(ATTENTION_STORE, String(attentionId || ''));
    if (!record) return false;
    await putRecord(ATTENTION_STORE, { ...record, acknowledged: true, updatedAt: Date.now() });
    try { if (typeof sendNative === 'function') sendNative({ type: 'toast.dismissEvent', notificationId: record.attentionId }); } catch {}
    return true;
  }

  async function noteTabUnobservable(tabId, reason) {
    const conversationId = tabConversations.get(tabId) || '';
    if (!conversationId || (await getEnrollment(conversationId))?.enabled !== true) return;
    const run = await latestRunForConversation(conversationId);
    if (run && run.state !== 'coded-terminal') await ensureAttention(run, reason);
  }

  chrome.webRequest.onBeforeRequest.addListener((details) => {
    if (!isAnswerStreamRequest(details)) return;
    requestTabs.set(String(details.requestId || ''), details.tabId);
    sendRequestPhase(details.tabId, 'started', details).catch(() => {});
  }, REQUEST_FILTER);

  chrome.webRequest.onCompleted.addListener((details) => {
    if (!isAnswerStreamRequest(details)) return;
    requestTabs.delete(String(details.requestId || ''));
    sendRequestPhase(details.tabId, 'completed', details).catch(() => {});
  }, REQUEST_FILTER);

  chrome.webRequest.onErrorOccurred.addListener((details) => {
    if (!isAnswerStreamRequest(details)) return;
    requestTabs.delete(String(details.requestId || ''));
    sendRequestPhase(details.tabId, 'error', details).catch(() => {});
  }, REQUEST_FILTER);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'CHATGPT_MONITOR_STATE') {
      handleSnapshot(message.snapshot, sender).then((run) => sendResponse?.({ ok: true, monitored: Boolean(run), runKey: run?.runKey || '' }))
        .catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'GET_MONITOR_OVERVIEW') {
      monitorOverview().then((overview) => sendResponse?.({ ok: true, ...overview }))
        .catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'SET_ACTIVE_CHAT_MONITORING') {
      (async () => {
        const active = await activeChatIdentity();
        if (!active) { sendResponse?.({ ok: false, error: 'Open a ChatGPT conversation to change monitoring.' }); return; }
        const record = await setEnrollment(active, message.enabled === true, 'operator');
        if (message.enabled === true) {
          try {
            const result = await chrome.tabs.sendMessage(active.tab.id, { type: 'CHATGPT_MONITOR_QUERY' });
            if (result?.snapshot) await handleSnapshot(result.snapshot, { tab: active.tab, documentId: result.snapshot.documentId || '' });
          } catch {}
        }
        sendResponse?.({ ok: true, monitoring: record?.enabled === true });
      })().catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'ACK_RECOVERY_ATTENTION') {
      acknowledgeAttention(message.attentionId).then((acknowledged) => sendResponse?.({ ok: acknowledged }))
        .catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    return false;
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const identity = conversationFromUrl(changeInfo.url || tab?.url || '');
    if (identity) tabConversations.set(tabId, identity.id);
    if (changeInfo.discarded === true || changeInfo.frozen === true) noteTabUnobservable(tabId, 'page-unobservable').catch(() => {});
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    noteTabUnobservable(tabId, 'owner-tab-closed').catch(() => {});
    tabConversations.delete(tabId);
  });

  async function pruneOldRuns(now = Date.now()) {
    const records = await getAll(RUN_STORE);
    const database = await openDatabase();
    for (const record of records) {
      if (Number(record.createdAt || 0) <= 0 || now - Number(record.createdAt || 0) <= MAX_RUN_AGE_MS) continue;
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(RUN_STORE, 'readwrite');
        transaction.objectStore(RUN_STORE).delete(record.runKey);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('Could not prune monitored run.'));
      });
    }
  }

  globalThis.__chatgptNotifierMonitorBackground = Object.freeze({
    version: 1,
    getEnrollment,
    setEnrollment,
    latestRunForConversation,
    monitorOverview,
    ensureAttention,
    resolveAttentionForRun,
    readProfileState,
    updateRun,
    flushAttention
  });

  injectMonitorIntoExistingTabs().catch(() => {});
  pruneOldRuns().catch(() => {});
  flushAttention().catch(() => {});
})();
