'use strict';

(() => {
  if (globalThis.__chatgptNotifierObservationScheduler?.version === 1) return;

  const DB_NAME = 'chatgpt-response-notifier-observation-scheduler';
  const DB_VERSION = 1;
  const STORE = 'deadlines';
  const ALARM = 'chatgpt-notifier-observation-deadline';
  const QUERY_TIMEOUT_MS = 5_000;
  const REINSPECT_DELAY_MS = 1_000;
  const KINDS = Object.freeze({
    missingFooter: 'missing-footer',
    silentFirst: 'silent-first',
    silentConfirm: 'silent-confirm',
    longThinking: 'long-thinking'
  });

  let databasePromise = null;
  let processing = Promise.resolve();
  const policy = () => globalThis.ChatGPTNotifierContinuationPolicy || null;
  const text = (value) => String(value || '');
  const num = (value) => Math.max(0, Number(value || 0));

  function generationKey(snapshot = {}) {
    const conversationId = text(snapshot.conversationId);
    const promptKey = text(snapshot.promptKey);
    return conversationId && promptKey ? `${conversationId}|${promptKey}` : '';
  }

  function keyFor(generation, kind) {
    return generation && kind ? `${generation}|${kind}` : '';
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'deadlineKey' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open observation scheduler database.'));
      request.onblocked = () => reject(new Error('Observation scheduler database upgrade was blocked.'));
    });
    databasePromise.catch(() => { databasePromise = null; });
    return databasePromise;
  }

  function resultOf(request, message) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(message));
    });
  }

  async function getRecord(key) {
    const database = await openDatabase();
    return await resultOf(database.transaction(STORE, 'readonly').objectStore(STORE).get(key), 'Could not read observation deadline.') || null;
  }

  async function allRecords() {
    const database = await openDatabase();
    const records = await resultOf(database.transaction(STORE, 'readonly').objectStore(STORE).getAll(), 'Could not list observation deadlines.');
    return Array.isArray(records) ? records : [];
  }

  async function putRecord(record) {
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(record);
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
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).delete(key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not delete observation deadline.'));
      transaction.onabort = () => reject(transaction.error || new Error('Observation deadline delete was aborted.'));
    });
  }

  async function clearGeneration(generation, keepKinds = []) {
    if (!generation) return;
    const keep = new Set(keepKinds);
    for (const record of await allRecords()) {
      if (record.generationKey === generation && !keep.has(record.kind)) await deleteRecord(record.deadlineKey);
    }
  }

  async function armAlarm() {
    if (!chrome.alarms) return;
    const scheduled = (await allRecords())
      .filter((record) => num(record.dueAt) > 0)
      .sort((a, b) => num(a.dueAt) - num(b.dueAt));
    if (!scheduled.length) {
      try { await chrome.alarms.clear(ALARM); } catch {}
      return;
    }
    try { await chrome.alarms.create(ALARM, { when: Math.max(Date.now() + 250, num(scheduled[0].dueAt)) }); } catch {}
  }

  function blocked(snapshot = {}) {
    return snapshot.online === false || snapshot.manualStopped === true || snapshot.authRequired === true ||
      snapshot.approvalRequired === true || snapshot.rateLimited === true || snapshot.hasDraft === true ||
      snapshot.hasUpload === true || snapshot.explicitInterruption === true;
  }

  function identity(snapshot = {}) {
    return {
      conversationId: text(snapshot.conversationId),
      promptKey: text(snapshot.promptKey),
      promptRevision: text(snapshot.promptRevision),
      assistantKey: text(snapshot.assistantKey),
      assistantRevision: text(snapshot.assistantRevision),
      requestStartedAt: num(snapshot.requestStartedAt),
      requestSettledAt: num(snapshot.requestSettledAt)
    };
  }

  function samePrompt(record, snapshot = {}) {
    return Boolean(snapshot.conversationId === record.conversationId && snapshot.promptKey === record.promptKey &&
      (!record.promptRevision || text(snapshot.promptRevision) === record.promptRevision));
  }

  function sameAssistant(record, snapshot = {}) {
    return text(snapshot.assistantKey) === record.assistantKey && text(snapshot.assistantRevision) === record.assistantRevision;
  }

  async function upsert(snapshot, sender, kind, dueAt) {
    const generation = generationKey(snapshot);
    const deadlineKey = keyFor(generation, kind);
    const tabId = sender?.tab?.id;
    if (!deadlineKey || !Number.isInteger(tabId)) return null;
    const currentIdentity = identity(snapshot);
    const existing = await getRecord(deadlineKey);
    const unchanged = existing && Object.entries(currentIdentity).every(([key, value]) => existing[key] === value);
    if (unchanged && num(existing.dueAt) > 0) {
      const documentId = text(sender.documentId || snapshot.documentId);
      if (existing.tabId !== tabId || existing.documentId !== documentId) {
        await putRecord({ ...existing, tabId, documentId, updatedAt: Date.now() });
      }
      return existing;
    }
    const now = Date.now();
    return await putRecord({
      deadlineKey,
      generationKey: generation,
      kind,
      tabId,
      documentId: text(sender.documentId || snapshot.documentId),
      token: crypto.randomUUID(),
      dueAt: Math.max(now + 1, Number(dueAt || now + 1)),
      state: 'scheduled',
      deferReason: '',
      ...currentIdentity,
      createdAt: unchanged ? num(existing.createdAt) : now,
      updatedAt: now
    });
  }

  async function observe(snapshot = {}, sender = {}) {
    if (snapshot.workerObservationSynthetic === true) return;
    const thresholds = policy()?.thresholds;
    const tabId = sender?.tab?.id;
    if (!thresholds || !snapshot.conversationId || !snapshot.promptKey || !Number.isInteger(tabId)) return;
    const generation = generationKey(snapshot);

    if (snapshot.statusCode || blocked(snapshot) || snapshot.stopGenerating === true || snapshot.toolActivity === true) {
      await clearGeneration(generation);
      await armAlarm();
      return;
    }

    if (snapshot.assistantKey) {
      if (snapshot.stableTerminal === true || snapshot.hasStatusEvidence === true) await clearGeneration(generation);
      else {
        await clearGeneration(generation, [KINDS.missingFooter]);
        await upsert(snapshot, sender, KINDS.missingFooter, Date.now() + num(thresholds.missingFooterGraceMs));
      }
      await armAlarm();
      return;
    }

    if (['completed', 'error'].includes(text(snapshot.requestPhase))) {
      if (num(snapshot.silentIdleConfirmations) >= 2) await clearGeneration(generation);
      else if (num(snapshot.silentIdleConfirmations) === 1) {
        await clearGeneration(generation, [KINDS.silentConfirm]);
        await upsert(snapshot, sender, KINDS.silentConfirm, Date.now() + num(thresholds.silentIdleConfirmMs));
      } else {
        await clearGeneration(generation, [KINDS.silentFirst]);
        await upsert(snapshot, sender, KINDS.silentFirst, (num(snapshot.requestSettledAt) || Date.now()) + num(thresholds.silentIdleFirstMs));
      }
      await armAlarm();
      return;
    }

    if (text(snapshot.requestPhase) === 'started' && num(snapshot.requestStartedAt) > 0) {
      await clearGeneration(generation, [KINDS.longThinking]);
      await upsert(snapshot, sender, KINDS.longThinking, num(snapshot.requestStartedAt) + num(thresholds.longThinkingDiagnosticMs));
      await armAlarm();
      return;
    }

    await clearGeneration(generation);
    await armAlarm();
  }

  function boundedPromise(promise, timeoutMs, timeoutValue = null) {
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

  async function query(record) {
    let tab;
    try { tab = await chrome.tabs.get(record.tabId); } catch { return { ok: false, reason: 'owner-tab-closed' }; }
    if (tab.discarded === true || tab.frozen === true) return { ok: false, reason: 'page-unobservable', deferred: true };

    const ask = async () => {
      const reply = await boundedPromise(chrome.tabs.sendMessage(record.tabId, { type: 'CHATGPT_MONITOR_QUERY', observationToken: record.token }), QUERY_TIMEOUT_MS);
      return reply?.snapshot && typeof reply.snapshot === 'object' ? reply.snapshot : reply;
    };
    let snapshot = await ask();
    if (snapshot?.conversationId) return { ok: true, snapshot };

    const injected = await boundedPromise(
      chrome.scripting.executeScript({ target: { tabId: record.tabId }, files: ['status-code.js', 'status-policy.js', 'monitor-script.js', 'observation-relay.js'] }),
      QUERY_TIMEOUT_MS
    );
    if (!injected) return { ok: false, reason: 'page-unobservable', deferred: true };
    snapshot = await ask();
    return snapshot?.conversationId ? { ok: true, snapshot } : { ok: false, reason: 'page-unobservable', deferred: true };
  }

  async function defer(record, reason) {
    const current = await getRecord(record.deadlineKey);
    if (!current || current.token !== record.token) return;
    await putRecord({ ...current, state: 'deferred', deferReason: text(reason || 'page-unobservable'), dueAt: 0, updatedAt: Date.now() });
  }

  async function relaySynthetic(record, snapshot) {
    const current = await getRecord(record.deadlineKey);
    if (!current || current.token !== record.token || !samePrompt(current, snapshot)) return false;
    const reply = await boundedPromise(chrome.tabs.sendMessage(record.tabId, {
      type: 'CHATGPT_OBSERVATION_SYNTHETIC',
      expectedToken: record.token,
      snapshot: { ...snapshot, workerObservationSynthetic: true }
    }), QUERY_TIMEOUT_MS);
    return reply?.ok === true;
  }

  async function processRecord(record) {
    const current = await getRecord(record.deadlineKey);
    if (!current || current.token !== record.token || num(current.dueAt) > Date.now()) return;
    const inspected = await query(current);
    if (!inspected.ok) {
      if (inspected.deferred) await defer(current, inspected.reason);
      else await deleteRecord(current.deadlineKey);
      return;
    }
    const snapshot = inspected.snapshot;
    if (!samePrompt(current, snapshot) || snapshot.statusCode || blocked(snapshot) || snapshot.stopGenerating === true || snapshot.toolActivity === true) {
      await deleteRecord(current.deadlineKey);
      return;
    }

    if (current.kind === KINDS.missingFooter) {
      if (!snapshot.assistantKey || !sameAssistant(current, snapshot) || snapshot.hasStatusEvidence === true) {
        await deleteRecord(current.deadlineKey);
        return;
      }
      await relaySynthetic(current, { ...snapshot, stableTerminal: true });
      await deleteRecord(current.deadlineKey);
      return;
    }

    if (current.kind === KINDS.silentFirst || current.kind === KINDS.silentConfirm) {
      if (snapshot.assistantKey || !['completed', 'error'].includes(text(snapshot.requestPhase))) {
        await deleteRecord(current.deadlineKey);
        return;
      }
      if (current.kind === KINDS.silentFirst) {
        await deleteRecord(current.deadlineKey);
        await upsert(snapshot, { tab: { id: current.tabId }, documentId: snapshot.documentId }, KINDS.silentConfirm, Date.now() + num(policy()?.thresholds?.silentIdleConfirmMs || 30_000));
        await relaySynthetic(current, { ...snapshot, silentIdleConfirmations: Math.max(1, num(snapshot.silentIdleConfirmations)) });
      } else {
        await relaySynthetic(current, { ...snapshot, silentIdleConfirmations: 2 });
        await deleteRecord(current.deadlineKey);
      }
      return;
    }

    if (current.kind === KINDS.longThinking) {
      if (text(snapshot.requestPhase) !== 'started' || num(snapshot.requestStartedAt) !== current.requestStartedAt || snapshot.assistantKey) {
        await deleteRecord(current.deadlineKey);
        return;
      }
      await relaySynthetic(current, { ...snapshot, workingDurationMs: Math.max(num(snapshot.workingDurationMs), Date.now() - current.requestStartedAt) });
      await deleteRecord(current.deadlineKey);
    }
  }

  async function processDue() {
    processing = processing.then(async () => {
      const due = (await allRecords()).filter((record) => num(record.dueAt) > 0 && num(record.dueAt) <= Date.now()).sort((a, b) => num(a.dueAt) - num(b.dueAt));
      for (const record of due) await processRecord(record);
      await armAlarm();
    }).catch(() => {});
    return await processing;
  }

  async function resumeTab(tabId) {
    if (!Number.isInteger(tabId)) return;
    for (const record of await allRecords()) {
      if (record.tabId !== tabId || record.state !== 'deferred') continue;
      await putRecord({ ...record, state: 'scheduled', deferReason: '', dueAt: Date.now() + REINSPECT_DELAY_MS, token: crypto.randomUUID(), updatedAt: Date.now() });
    }
    await armAlarm();
  }

  chrome.alarms?.onAlarm?.addListener((alarm) => {
    if (alarm?.name === ALARM) processDue().catch(() => {});
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === 'CHATGPT_MONITOR_STATE' && message.snapshot) observe(message.snapshot, sender).catch(() => {});
    return false;
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo?.status === 'complete' || changeInfo?.discarded === false || changeInfo?.frozen === false || tab?.active === true) resumeTab(tabId).catch(() => {});
  });
  chrome.tabs.onActivated.addListener((info) => resumeTab(info?.tabId).catch(() => {}));
  chrome.tabs.onRemoved.addListener((tabId) => {
    (async () => {
      for (const record of await allRecords()) if (record.tabId === tabId) await deleteRecord(record.deadlineKey);
      await armAlarm();
    })().catch(() => {});
  });

  globalThis.__chatgptNotifierObservationScheduler = Object.freeze({
    version: 1,
    alarmName: ALARM,
    queryTimeoutMs: QUERY_TIMEOUT_MS,
    observe,
    processDue,
    resumeTab
  });
  armAlarm().catch(() => {});
})();
