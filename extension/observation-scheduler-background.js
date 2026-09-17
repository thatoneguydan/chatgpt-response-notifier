'use strict';

(() => {
  if (globalThis.__chatgptNotifierObservationScheduler?.version === 1) return;

  const DB_NAME = 'chatgpt-response-notifier-observation-scheduler';
  const DB_VERSION = 1;
  const STORE_NAME = 'deadlines';
  const ALARM_NAME = 'chatgpt-notifier-observation-deadline';
  const QUERY_TIMEOUT_MS = 5_000;
  const REINSPECT_DELAY_MS = 1_000;
  const KINDS = Object.freeze({
    missingFooter: 'missing-footer',
    silentFirst: 'silent-first',
    silentConfirm: 'silent-confirm',
    longThinking: 'long-thinking'
  });

  let databasePromise = null;
  let schedulingPromise = Promise.resolve();
  const policy = () => globalThis.ChatGPTNotifierContinuationPolicy || null;
  const bounded = () => globalThis.__chatgptNotifierBoundedRecovery || null;

  const text = (value) => String(value || '');
  const number = (value) => Math.max(0, Number(value || 0));

  function generationKey(snapshot = {}) {
    const conversationId = text(snapshot.conversationId);
    const promptKey = text(snapshot.promptKey);
    return conversationId && promptKey ? `${conversationId}|${promptKey}` : '';
  }

  function deadlineKey(generation, kind) {
    return generation && kind ? `${generation}|${kind}` : '';
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'deadlineKey' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open observation scheduler database.'));
      request.onblocked = () => reject(new Error('Observation scheduler database upgrade was blocked.'));
    });
    databasePromise.catch(() => { databasePromise = null; });
    return databasePromise;
  }

  function requestResult(request, message) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(message));
    });
  }

  async function getRecord(key) {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    return await requestResult(transaction.objectStore(STORE_NAME).get(key), 'Could not read observation deadline.') || null;
  }

  async function getAllRecords() {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const result = await requestResult(transaction.objectStore(STORE_NAME).getAll(), 'Could not list observation deadlines.');
    return Array.isArray(result) ? result : [];
  }

  async function putRecord(record) {
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(record);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not write observation deadline.'));
      transaction.onabort = () => reject(transaction.error || new Error('Observation deadline write was aborted.'));
    });
    return record;
  }

  async function deleteRecord(key) {
    if (!key) return;
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not delete observation deadline.'));
      transaction.onabort = () => reject(transaction.error || new Error('Observation deadline delete was aborted.'));
    });
  }

  async function deleteGenerationDeadlines(generation, exceptKinds = []) {
    if (!generation) return;
    const keep = new Set(exceptKinds);
    const records = await getAllRecords();
    for (const record of records) {
      if (record.generationKey !== generation || keep.has(record.kind)) continue;
      await deleteRecord(record.deadlineKey);
    }
  }

  async function scheduleEarliestAlarm() {
    if (!chrome.alarms) return;
    const records = (await getAllRecords())
      .filter((record) => Number(record.dueAt || 0) > 0)
      .sort((left, right) => Number(left.dueAt || 0) - Number(right.dueAt || 0));
    if (!records.length) {
      try { await chrome.alarms.clear(ALARM_NAME); } catch {}
      return;
    }
    try { await chrome.alarms.create(ALARM_NAME, { when: Math.max(Date.now() + 250, Number(records[0].dueAt)) }); } catch {}
  }

  function safetyBlocked(snapshot = {}) {
    return snapshot.online === false || snapshot.manualStopped === true || snapshot.authRequired === true ||
      snapshot.approvalRequired === true || snapshot.rateLimited === true || snapshot.hasDraft === true ||
      snapshot.hasUpload === true || snapshot.explicitInterruption === true;
  }

  function identityFields(snapshot = {}) {
    return {
      conversationId: text(snapshot.conversationId),
      promptKey: text(snapshot.promptKey),
      promptRevision: text(snapshot.promptRevision),
      assistantKey: text(snapshot.assistantKey),
      assistantRevision: text(snapshot.assistantRevision),
      requestStartedAt: number(snapshot.requestStartedAt),
      requestSettledAt: number(snapshot.requestSettledAt)
    };
  }

  function samePrompt(record, snapshot = {}) {
    return Boolean(
      snapshot.conversationId && snapshot.conversationId === record.conversationId &&
      snapshot.promptKey && snapshot.promptKey === record.promptKey &&
      (!record.promptRevision || text(snapshot.promptRevision) === record.promptRevision)
    );
  }

  function sameAssistant(record, snapshot = {}) {
    return text(snapshot.assistantKey) === record.assistantKey && text(snapshot.assistantRevision) === record.assistantRevision;
  }

  async function upsertDeadline(snapshot, sender, kind, dueAt) {
    const generation = generationKey(snapshot);
    const key = deadlineKey(generation, kind);
    if (!key || !Number.isInteger(sender?.tab?.id)) return null;
    const existing = await getRecord(key);
    const identity = identityFields(snapshot);
    const sameIdentity = existing &&
      existing.conversationId === identity.conversationId &&
      existing.promptKey === identity.promptKey &&
      existing.promptRevision === identity.promptRevision &&
      existing.assistantKey === identity.assistantKey &&
      existing.assistantRevision === identity.assistantRevision &&
      existing.requestStartedAt === identity.requestStartedAt &&
      existing.requestSettledAt === identity.requestSettledAt;
    if (sameIdentity && Number(existing.dueAt || 0) > 0) {
      if (existing.tabId !== sender.tab.id || existing.documentId !== text(sender.documentId || snapshot.documentId)) {
        await putRecord({ ...existing, tabId: sender.tab.id, documentId: text(sender.documentId || snapshot.documentId), updatedAt: Date.now() });
      }
      return existing;
    }
    const now = Date.now();
    return await putRecord({
      deadlineKey: key,
      generationKey: generation,
      kind,
      tabId: sender.tab.id,
      documentId: text(sender.documentId || snapshot.documentId),
      token: crypto.randomUUID(),
      dueAt: Math.max(now + 1, Number(dueAt || now + 1)),
      state: 'scheduled',
      deferReason: '',
      ...identity,
      createdAt: sameIdentity ? number(existing.createdAt) : now,
      updatedAt: now
    });
  }

  async function observeSnapshot(snapshot = {}, sender = {}) {
    const thresholds = policy()?.thresholds;
    if (!thresholds || !snapshot.conversationId || !snapshot.promptKey || !Number.isInteger(sender?.tab?.id)) return;
    const generation = generationKey(snapshot);

    if (snapshot.statusCode || safetyBlocked(snapshot)) {
      await deleteGenerationDeadlines(generation);
      await scheduleEarliestAlarm();
      return;
    }

    if (snapshot.stopGenerating === true || snapshot.toolActivity === true) {
      await deleteGenerationDeadlines(generation);
      await scheduleEarliestAlarm();
      return;
    }

    if (snapshot.assistantKey) {
      if (snapshot.stableTerminal === true || snapshot.hasStatusEvidence === true) {
        await deleteGenerationDeadlines(generation);
      } else {
        await deleteGenerationDeadlines(generation, [KINDS.missingFooter]);
        await upsertDeadline(snapshot, sender, KINDS.missingFooter, Date.now() + Number(thresholds.missingFooterGraceMs));
      }
      await scheduleEarliestAlarm();
      return;
    }

    if (['completed', 'error'].includes(text(snapshot.requestPhase))) {
      if (Number(snapshot.silentIdleConfirmations || 0) >= 2) {
        await deleteGenerationDeadlines(generation);
      } else if (Number(snapshot.silentIdleConfirmations || 0) === 1) {
        await deleteGenerationDeadlines(generation, [KINDS.silentConfirm]);
        await upsertDeadline(snapshot, sender, KINDS.silentConfirm, Date.now() + Number(thresholds.silentIdleConfirmMs));
      } else {
        await deleteGenerationDeadlines(generation, [KINDS.silentFirst]);
        const settledBase = number(snapshot.requestSettledAt) || Date.now();
        await upsertDeadline(snapshot, sender, KINDS.silentFirst, settledBase + Number(thresholds.silentIdleFirstMs));
      }
      await scheduleEarliestAlarm();
      return;
    }

    if (text(snapshot.requestPhase) === 'started' && number(snapshot.requestStartedAt) > 0) {
      await deleteGenerationDeadlines(generation, [KINDS.longThinking]);
      await upsertDeadline(snapshot, sender, KINDS.longThinking, number(snapshot.requestStartedAt) + Number(thresholds.longThinkingDiagnosticMs));
      await scheduleEarliestAlarm();
      return;
    }

    await deleteGenerationDeadlines(generation);
    await scheduleEarliestAlarm();
  }

  function withDeadline(promise, timeoutMs, timeoutValue) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(timeoutValue);
      }, timeoutMs);
      Promise.resolve(promise).then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(timeoutValue);
      });
    });
  }

  async function queryTab(record) {
    let tab;
    try { tab = await chrome.tabs.get(record.tabId); } catch { return { ok: false, reason: 'owner-tab-closed' }; }
    if (tab.discarded === true || tab.frozen === true) return { ok: false, reason: 'page-unobservable', deferred: true };

    const query = () => withDeadline(
      chrome.tabs.sendMessage(record.tabId, { type: 'CHATGPT_MONITOR_QUERY', observationToken: record.token }),
      QUERY_TIMEOUT_MS,
      null
    );
    let result = await query();
    let snapshot = result?.snapshot && typeof result.snapshot === 'object' ? result.snapshot : result;
    if (snapshot?.conversationId) return { ok: true, snapshot, tab };

    const injected = await withDeadline(
      chrome.scripting.executeScript({ target: { tabId: record.tabId }, files: ['status-code.js', 'status-policy.js', 'monitor-script.js'] }),
      QUERY_TIMEOUT_MS,
      null
    );
    if (!injected) return { ok: false, reason: 'page-unobservable', deferred: true };
    result = await query();
    snapshot = result?.snapshot && typeof result.snapshot === 'object' ? result.snapshot : result;
    if (snapshot?.conversationId) return { ok: true, snapshot, tab };
    return { ok: false, reason: 'page-unobservable', deferred: true };
  }

  async function deferRecord(record, reason) {
    const current = await getRecord(record.deadlineKey);
    if (!current || current.token !== record.token) return;
    await putRecord({ ...current, state: 'deferred', deferReason: text(reason || 'page-unobservable'), dueAt: 0, updatedAt: Date.now() });
  }

  async function ingestSynthetic(record, snapshot) {
    const current = await getRecord(record.deadlineKey);
    if (!current || current.token !== record.token) return false;
    if (!samePrompt(current, snapshot)) {
      await deleteRecord(record.deadlineKey);
      return false;
    }
    const ingest = bounded()?.ingestObservation;
    if (typeof ingest !== 'function') return false;
    await ingest(snapshot, { tab: { id: record.tabId }, documentId: text(snapshot.documentId || current.documentId) });
    return true;
  }

  async function processDeadline(record) {
    const current = await getRecord(record.deadlineKey);
    if (!current || current.token !== record.token || Number(current.dueAt || 0) > Date.now()) return;
    const inspected = await queryTab(current);
    if (!inspected.ok) {
      if (inspected.deferred) await deferRecord(current, inspected.reason);
      else await deleteRecord(current.deadlineKey);
      return;
    }
    const snapshot = inspected.snapshot;
    if (!samePrompt(current, snapshot)) {
      await deleteRecord(current.deadlineKey);
      return;
    }
    if (snapshot.statusCode || safetyBlocked(snapshot) || snapshot.stopGenerating === true || snapshot.toolActivity === true) {
      await deleteRecord(current.deadlineKey);
      return;
    }

    if (current.kind === KINDS.missingFooter) {
      if (!snapshot.assistantKey || !sameAssistant(current, snapshot) || snapshot.hasStatusEvidence === true) {
        await deleteRecord(current.deadlineKey);
        return;
      }
      await ingestSynthetic(current, { ...snapshot, stableTerminal: true });
      await deleteRecord(current.deadlineKey);
      return;
    }

    if (current.kind === KINDS.silentFirst || current.kind === KINDS.silentConfirm) {
      if (snapshot.assistantKey || !['completed', 'error'].includes(text(snapshot.requestPhase))) {
        await deleteRecord(current.deadlineKey);
        return;
      }
      if (current.kind === KINDS.silentFirst) {
        await ingestSynthetic(current, { ...snapshot, silentIdleConfirmations: Math.max(1, Number(snapshot.silentIdleConfirmations || 0)) });
        await deleteRecord(current.deadlineKey);
        await upsertDeadline(snapshot, { tab: { id: current.tabId }, documentId: snapshot.documentId }, KINDS.silentConfirm, Date.now() + Number(policy()?.thresholds?.silentIdleConfirmMs || 30_000));
      } else {
        await ingestSynthetic(current, { ...snapshot, silentIdleConfirmations: 2 });
        await deleteRecord(current.deadlineKey);
      }
      return;
    }

    if (current.kind === KINDS.longThinking) {
      if (text(snapshot.requestPhase) !== 'started' || number(snapshot.requestStartedAt) !== current.requestStartedAt || snapshot.assistantKey) {
        await deleteRecord(current.deadlineKey);
        return;
      }
      const workingDurationMs = Math.max(Number(snapshot.workingDurationMs || 0), Date.now() - current.requestStartedAt);
      await ingestSynthetic(current, { ...snapshot, workingDurationMs });
      await deleteRecord(current.deadlineKey);
    }
  }

  async function processDueDeadlines() {
    schedulingPromise = schedulingPromise.then(async () => {
      const due = (await getAllRecords())
        .filter((record) => Number(record.dueAt || 0) > 0 && Number(record.dueAt) <= Date.now())
        .sort((left, right) => Number(left.dueAt) - Number(right.dueAt));
      for (const record of due) await processDeadline(record);
      await scheduleEarliestAlarm();
    }).catch(() => {});
    return await schedulingPromise;
  }

  async function resumeTab(tabId) {
    if (!Number.isInteger(tabId)) return;
    const records = await getAllRecords();
    for (const record of records) {
      if (record.tabId !== tabId || record.state !== 'deferred') continue;
      await putRecord({ ...record, state: 'scheduled', deferReason: '', dueAt: Date.now() + REINSPECT_DELAY_MS, token: crypto.randomUUID(), updatedAt: Date.now() });
    }
    await scheduleEarliestAlarm();
  }

  if (chrome.alarms?.onAlarm) {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm?.name !== ALARM_NAME) return;
      processDueDeadlines().catch(() => {});
    });
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== 'CHATGPT_MONITOR_STATE' || !message.snapshot) return false;
    observeSnapshot(message.snapshot, sender).catch(() => {});
    return false;
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo?.status === 'complete' || changeInfo?.discarded === false || changeInfo?.frozen === false || tab?.active === true) {
      resumeTab(tabId).catch(() => {});
    }
  });
  chrome.tabs.onActivated.addListener((activeInfo) => resumeTab(activeInfo?.tabId).catch(() => {}));
  chrome.tabs.onRemoved.addListener((tabId) => {
    (async () => {
      for (const record of await getAllRecords()) if (record.tabId === tabId) await deleteRecord(record.deadlineKey);
      await scheduleEarliestAlarm();
    })().catch(() => {});
  });

  globalThis.__chatgptNotifierObservationScheduler = Object.freeze({
    version: 1,
    alarmName: ALARM_NAME,
    queryTimeoutMs: QUERY_TIMEOUT_MS,
    observeSnapshot,
    processDueDeadlines,
    resumeTab
  });

  scheduleEarliestAlarm().catch(() => {});
})();
