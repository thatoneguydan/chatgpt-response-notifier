'use strict';

(() => {
  if (globalThis.__chatgptNotifierBoundedRecovery) return;

  const DB_NAME = 'chatgpt-response-notifier-bounded-recovery';
  const DB_VERSION = 1;
  const HUMAN_RUN_STORE = 'human-runs';
  const GENERATION_STORE = 'generations';
  const INCIDENT_STORE = 'incidents';
  const PROFILE_STORE = 'profile';
  const MAPPING_STORE = 'automatic-prompts';
  const PROFILE_KEY = 'recovery';
  const ALARM_NAME = 'chatgpt-notifier-recovery-deadline';
  const RELOAD_RECONCILE_MS = 15_000;
  const REQUEST_EVIDENCE_TIMEOUT_MS = 12_000;
  const REQUEST_FILTER = {
    urls: [
      'https://chatgpt.com/backend-api/f/conversation*',
      'https://chatgpt.com/backend-api/conversation*'
    ]
  };

  let databasePromise = null;
  let processingPromise = null;
  const requestWatchers = new Map();

  const model = () => globalThis.ChatGPTNotifierRecoveryModel || null;
  const policy = () => globalThis.ChatGPTNotifierContinuationPolicy || null;
  const monitor = () => globalThis.__chatgptNotifierMonitorBackground || null;
  const clone = (value) => value ? structuredClone(value) : value;

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

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(HUMAN_RUN_STORE)) database.createObjectStore(HUMAN_RUN_STORE, { keyPath: 'humanRunId' });
        if (!database.objectStoreNames.contains(GENERATION_STORE)) database.createObjectStore(GENERATION_STORE, { keyPath: 'generationKey' });
        if (!database.objectStoreNames.contains(INCIDENT_STORE)) database.createObjectStore(INCIDENT_STORE, { keyPath: 'incidentId' });
        if (!database.objectStoreNames.contains(PROFILE_STORE)) database.createObjectStore(PROFILE_STORE, { keyPath: 'key' });
        if (!database.objectStoreNames.contains(MAPPING_STORE)) database.createObjectStore(MAPPING_STORE, { keyPath: 'promptKey' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open bounded recovery database.'));
      request.onblocked = () => reject(new Error('Bounded recovery database upgrade was blocked.'));
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
    const result = await requestResult(transaction.objectStore(storeName).getAll(), `Could not list ${storeName}.`);
    return (Array.isArray(result) ? result : []).map(clone);
  }

  async function deleteRecord(storeName, key) {
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).delete(key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error(`Could not delete ${storeName}.`));
    });
  }

  async function readProfile() {
    return model()?.normalizeProfile?.(await getRecord(PROFILE_STORE, PROFILE_KEY)) || {
      breakerOpen: false, breakerReason: '', activeLease: null, nextProfileActionAt: 0, updatedAt: 0
    };
  }

  async function writeProfile(profile) {
    return await putRecord(PROFILE_STORE, { key: PROFILE_KEY, ...model().normalizeProfile(profile) });
  }

  async function openBreaker(reason) {
    const current = await readProfile();
    return await writeProfile({
      ...current,
      breakerOpen: true,
      breakerReason: String(reason || 'automation-stopped'),
      activeLease: null,
      updatedAt: Date.now()
    });
  }

  async function recoveryEnrollment(conversationId) {
    try { return await monitor()?.getEnrollment?.(String(conversationId || '')); } catch { return null; }
  }

  function generationKey(conversationId, promptKey) {
    if (!conversationId || !promptKey) return '';
    return `${conversationId}|${promptKey}`;
  }

  async function createHumanRun(snapshot) {
    const now = Date.now();
    const record = model().normalizeHumanRun({
      humanRunId: crypto.randomUUID(),
      conversationId: snapshot.conversationId,
      originPromptKey: snapshot.promptKey,
      originPromptRevision: snapshot.promptRevision,
      generationActions: 0,
      resumeCount: 0,
      state: 'active',
      createdAt: now,
      updatedAt: now
    });
    await putRecord(HUMAN_RUN_STORE, record);
    return record;
  }

  async function ensureGeneration(snapshot, sender = {}) {
    const key = generationKey(snapshot.conversationId, snapshot.promptKey);
    if (!key) return null;
    const existing = await getRecord(GENERATION_STORE, key);
    if (existing) return existing;

    const mapping = await getRecord(MAPPING_STORE, snapshot.promptKey);
    let humanRun = mapping?.humanRunId ? await getRecord(HUMAN_RUN_STORE, mapping.humanRunId) : null;
    if (!humanRun) humanRun = await createHumanRun(snapshot);
    const now = Date.now();
    const record = {
      generationKey: key,
      humanRunId: humanRun.humanRunId,
      conversationId: snapshot.conversationId,
      conversationUrl: snapshot.conversationUrl,
      promptKey: snapshot.promptKey,
      promptRevision: snapshot.promptRevision,
      automatic: Boolean(mapping?.humanRunId),
      parentGenerationKey: String(mapping?.parentGenerationKey || ''),
      actionId: String(mapping?.actionId || ''),
      ownerTabId: Number.isInteger(sender?.tab?.id) ? sender.tab.id : null,
      ownerDocumentId: String(sender?.documentId || snapshot.documentId || ''),
      snapshot: { ...snapshot },
      classification: null,
      state: 'observing',
      createdAt: now,
      updatedAt: now
    };
    await putRecord(GENERATION_STORE, record);
    return record;
  }

  async function registerAutomaticPrompt({ promptKey, conversationId, humanRunId, parentGenerationKey = '', actionId = '' } = {}) {
    if (!promptKey || !conversationId || !humanRunId) return false;
    const now = Date.now();
    await putRecord(MAPPING_STORE, {
      promptKey: String(promptKey),
      conversationId: String(conversationId),
      humanRunId: String(humanRunId),
      parentGenerationKey: String(parentGenerationKey),
      actionId: String(actionId),
      createdAt: now
    });

    const key = generationKey(conversationId, promptKey);
    const generation = await getRecord(GENERATION_STORE, key);
    if (generation && generation.humanRunId !== humanRunId) {
      const provisional = await getRecord(HUMAN_RUN_STORE, generation.humanRunId);
      if (provisional) await putRecord(HUMAN_RUN_STORE, { ...provisional, state: 'superseded-by-automatic-lineage', updatedAt: now });
      await putRecord(GENERATION_STORE, {
        ...generation,
        humanRunId,
        automatic: true,
        parentGenerationKey: String(parentGenerationKey),
        actionId: String(actionId),
        updatedAt: now
      });
    }
    return true;
  }

  async function incidentForGeneration(key) {
    const incidents = (await getAll(INCIDENT_STORE))
      .filter((item) => item.generationKey === key && !['resolved', 'dismissed'].includes(String(item.state || '')))
      .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
    return incidents[0] || null;
  }

  async function ensureIncident(generation, classification) {
    const current = await incidentForGeneration(generation.generationKey);
    if (current && current.reason === classification.reason) return current;
    if (current) await putRecord(INCIDENT_STORE, { ...current, state: 'resolved', resolution: `superseded:${classification.reason}`, updatedAt: Date.now() });

    const previous = (await getAll(INCIDENT_STORE)).filter((item) => item.humanRunId === generation.humanRunId);
    const ordinal = previous.length + 1;
    const now = Date.now();
    const record = model().normalizeIncident({
      incidentId: crypto.randomUUID(),
      humanRunId: generation.humanRunId,
      generationKey: generation.generationKey,
      reason: classification.reason,
      ordinal,
      state: 'scheduled',
      budget: {},
      nextEligibleAt: model().firstEligibleAt(classification.reason, now, ordinal),
      createdAt: now,
      updatedAt: now
    });
    await putRecord(INCIDENT_STORE, record);
    return record;
  }

  async function raiseAttention(generation, reason) {
    try {
      await monitor()?.raiseAttention?.({
        runKey: generation.generationKey,
        runId: generation.humanRunId,
        conversationId: generation.conversationId,
        conversationUrl: generation.conversationUrl,
        tabTitle: generation.tabTitle || 'ChatGPT'
      }, String(reason || 'automation-stopped'));
    } catch {}
  }

  async function resolveIncidents(generationKeyValue, resolution) {
    for (const incident of await getAll(INCIDENT_STORE)) {
      if (incident.generationKey !== generationKeyValue || ['resolved', 'dismissed'].includes(String(incident.state || ''))) continue;
      await putRecord(INCIDENT_STORE, { ...incident, state: 'resolved', inFlight: null, resolution: String(resolution || 'resolved'), nextEligibleAt: 0, updatedAt: Date.now() });
    }
    await scheduleEarliestWake();
  }

  async function queryTabSnapshot(tabId) {
    if (!Number.isInteger(tabId)) return { ok: false, reason: 'owner-tab-missing' };
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return { ok: false, reason: 'owner-tab-closed' }; }
    if (tab.discarded === true || tab.frozen === true) return { ok: false, reason: 'page-unobservable' };
    const identity = conversationFromUrl(tab.url);
    if (!identity) return { ok: false, reason: 'conversation-unavailable' };
    try {
      const snapshot = await chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_MONITOR_QUERY' });
      if (snapshot?.conversationId) return { ok: true, tab, identity, snapshot };
    } catch {}
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['status-code.js', 'status-policy.js', 'monitor-script.js'] });
      const snapshot = await chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_MONITOR_QUERY' });
      if (snapshot?.conversationId) return { ok: true, tab, identity, snapshot };
    } catch {}
    return { ok: false, reason: 'page-unobservable', tab, identity };
  }

  async function scheduleEarliestWake() {
    if (!chrome.alarms) return;
    const incidents = await getAll(INCIDENT_STORE);
    const pending = incidents
      .filter((item) => ['scheduled', 'reconciling'].includes(String(item.state || '')) && Number(item.nextEligibleAt || 0) > 0)
      .sort((left, right) => Number(left.nextEligibleAt || 0) - Number(right.nextEligibleAt || 0));
    if (!pending.length) {
      try { await chrome.alarms.clear(ALARM_NAME); } catch {}
      return;
    }
    const when = Math.max(Date.now() + 1_000, Number(pending[0].nextEligibleAt));
    try { await chrome.alarms.create(ALARM_NAME, { when }); } catch {}
  }

  function requestWatch(tabId, conversationId) {
    const prior = requestWatchers.get(tabId);
    if (prior) prior.finish({ accepted: false, reason: 'superseded-request-watch' });
    let requestId = '';
    let settled = false;
    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    const timer = setTimeout(() => watcher.finish({ accepted: false, reason: 'request-evidence-timeout' }), REQUEST_EVIDENCE_TIMEOUT_MS);
    const watcher = {
      tabId,
      conversationId,
      promise,
      get requestId() { return requestId; },
      setRequestId(value) { if (!requestId) requestId = String(value || ''); },
      finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (requestWatchers.get(tabId) === watcher) requestWatchers.delete(tabId);
        resolvePromise({ requestId, ...(result || {}) });
      }
    };
    requestWatchers.set(tabId, watcher);
    return watcher;
  }

  chrome.webRequest.onBeforeRequest.addListener((details) => {
    if (!isAnswerStreamRequest(details)) return;
    const watcher = requestWatchers.get(details.tabId);
    if (!watcher || watcher.requestId) return;
    watcher.setRequestId(details.requestId);
  }, REQUEST_FILTER);

  chrome.webRequest.onHeadersReceived.addListener((details) => {
    if (!isAnswerStreamRequest(details)) return;
    const watcher = requestWatchers.get(details.tabId);
    if (!watcher || !watcher.requestId || watcher.requestId !== String(details.requestId || '')) return;
    const accepted = details.statusCode >= 200 && details.statusCode < 300;
    watcher.finish({ accepted, statusCode: details.statusCode, reason: accepted ? 'request-accepted' : 'request-rejected' });
  }, REQUEST_FILTER);

  chrome.webRequest.onErrorOccurred.addListener((details) => {
    if (!isAnswerStreamRequest(details)) return;
    const watcher = requestWatchers.get(details.tabId);
    if (!watcher || !watcher.requestId || watcher.requestId !== String(details.requestId || '')) return;
    watcher.finish({ accepted: false, reason: 'request-error', error: String(details.error || '') });
  }, REQUEST_FILTER);

  async function claimAction(kind, generation, incident, observation, options = {}) {
    const database = await openDatabase();
    const leaseId = crypto.randomUUID();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction([HUMAN_RUN_STORE, INCIDENT_STORE, PROFILE_STORE], 'readwrite');
      const humans = transaction.objectStore(HUMAN_RUN_STORE);
      const incidents = transaction.objectStore(INCIDENT_STORE);
      const profiles = transaction.objectStore(PROFILE_STORE);
      const humanRequest = humans.get(generation.humanRunId);
      const incidentRequest = incident?.incidentId ? incidents.get(incident.incidentId) : null;
      const profileRequest = profiles.get(PROFILE_KEY);
      let humanReady = false;
      let incidentReady = !incidentRequest;
      let profileReady = false;
      let result = null;

      const inspect = () => {
        if (!humanReady || !incidentReady || !profileReady || result) return;
        const humanRun = humanRequest.result;
        const liveIncident = incidentRequest?.result || null;
        const profile = profileRequest.result || { key: PROFILE_KEY };
        if (!humanRun) { result = { allowed: false, reason: 'human-run-missing' }; return; }
        const claimed = model().claimAction(kind, humanRun, liveIncident, profile, observation, {
          now: Date.now(),
          leaseId,
          recoveryEnabled: options.recoveryEnabled === true
        });
        result = claimed;
        if (!claimed.allowed) {
          if (claimed.reason === 'profile-action-spacing' && liveIncident) {
            incidents.put({ ...liveIncident, state: 'scheduled', nextEligibleAt: Math.max(Number(profile.nextProfileActionAt || 0), Date.now() + 1_000), updatedAt: Date.now() });
          }
          return;
        }
        humans.put(claimed.humanRun);
        profiles.put({ key: PROFILE_KEY, ...claimed.profile });
        if (liveIncident) incidents.put(claimed.incident);
      };

      humanRequest.onsuccess = () => { humanReady = true; inspect(); };
      humanRequest.onerror = () => reject(humanRequest.error || new Error('Could not claim human run.'));
      if (incidentRequest) {
        incidentRequest.onsuccess = () => { incidentReady = true; inspect(); };
        incidentRequest.onerror = () => reject(incidentRequest.error || new Error('Could not claim incident.'));
      }
      profileRequest.onsuccess = () => { profileReady = true; inspect(); };
      profileRequest.onerror = () => reject(profileRequest.error || new Error('Could not claim profile action lease.'));
      transaction.oncomplete = () => resolve(result || { allowed: false, reason: 'claim-transaction-empty' });
      transaction.onerror = () => reject(transaction.error || new Error('Recovery action claim failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Recovery action claim aborted.'));
    });
  }

  async function finishClaim(claim, incident, result = {}) {
    if (!claim?.allowed) return;
    const humanRun = await getRecord(HUMAN_RUN_STORE, claim.humanRun.humanRunId) || claim.humanRun;
    const liveIncident = incident?.incidentId ? (await getRecord(INCIDENT_STORE, incident.incidentId) || incident) : null;
    const profile = await readProfile();
    const finished = model().finishAction(humanRun, liveIncident, profile, {
      leaseId: claim.leaseId,
      uncertain: result.uncertain === true,
      state: result.state || 'observing'
    }, { now: Date.now() });
    await putRecord(HUMAN_RUN_STORE, finished.humanRun);
    await writeProfile(finished.profile);
    if (liveIncident) {
      const updated = {
        ...finished.incident,
        nextEligibleAt: Number(result.nextEligibleAt || 0),
        resolution: String(result.resolution || ''),
        updatedAt: Date.now()
      };
      await putRecord(INCIDENT_STORE, updated);
      if (result.uncertain) {
        const generation = await getRecord(GENERATION_STORE, updated.generationKey);
        if (generation) await raiseAttention(generation, result.reason || 'action-outcome-uncertain');
      }
    }
    await scheduleEarliestWake();
  }

  async function performReload(claim, generation, incident) {
    let tab;
    try { tab = await chrome.tabs.get(generation.ownerTabId); } catch {
      await finishClaim(claim, incident, { uncertain: true, state: 'attention', reason: 'owner-tab-closed' });
      return;
    }
    const identity = conversationFromUrl(tab.url);
    if (!identity || identity.id !== generation.conversationId || tab.discarded === true || tab.frozen === true) {
      await finishClaim(claim, incident, { uncertain: true, state: 'attention', reason: tab.discarded || tab.frozen ? 'page-unobservable' : 'conversation-changed-before-reload' });
      return;
    }
    try {
      await chrome.tabs.reload(generation.ownerTabId);
    } catch {
      await finishClaim(claim, incident, { uncertain: true, state: 'attention', reason: 'reload-call-failed' });
      return;
    }
    await putRecord(INCIDENT_STORE, {
      ...(await getRecord(INCIDENT_STORE, incident.incidentId) || claim.incident),
      state: 'reconciling',
      preReloadDocumentId: String(generation.snapshot?.documentId || generation.ownerDocumentId || ''),
      nextEligibleAt: Date.now() + RELOAD_RECONCILE_MS,
      updatedAt: Date.now()
    });
    await scheduleEarliestWake();
  }

  async function reconcileReload(incident, generation, humanRun, profile) {
    const inspected = await queryTabSnapshot(generation.ownerTabId);
    if (!inspected.ok) {
      if (Date.now() < Number(incident.nextEligibleAt || 0)) return;
      const claim = { allowed: true, leaseId: incident.inFlight?.leaseId, humanRun, incident, profile };
      await finishClaim(claim, incident, { uncertain: true, state: 'attention', reason: inspected.reason });
      return;
    }
    const decision = model().postReloadDecision(inspected.snapshot, {
      conversationId: generation.conversationId,
      promptKey: generation.promptKey,
      documentId: String(incident.preReloadDocumentId || generation.snapshot?.documentId || '')
    });
    const claim = { allowed: true, leaseId: incident.inFlight?.leaseId, humanRun, incident, profile };
    if (decision.state === 'resolved') {
      await finishClaim(claim, incident, { state: 'resolved', resolution: decision.reason });
      return;
    }
    if (decision.state === 'observing') {
      await finishClaim(claim, incident, { state: 'observing', resolution: decision.reason });
      return;
    }
    if (decision.state === 'scheduled') {
      await finishClaim(claim, incident, { state: 'scheduled', nextEligibleAt: Date.now() + model().thresholds.profileActionSpacingMs, resolution: decision.reason });
      await putRecord(INCIDENT_STORE, {
        ...(await getRecord(INCIDENT_STORE, incident.incidentId)),
        reason: decision.reason,
        state: 'scheduled',
        nextEligibleAt: Date.now() + model().thresholds.profileActionSpacingMs,
        updatedAt: Date.now()
      });
      return;
    }
    await finishClaim(claim, incident, { uncertain: true, state: 'attention', reason: decision.reason });
  }

  async function performMessageAction(kind, claim, generation, incident, observation) {
    const watcher = requestWatch(generation.ownerTabId, generation.conversationId);
    let result = null;
    try {
      result = await chrome.tabs.sendMessage(generation.ownerTabId, {
        type: 'CHATGPT_BOUNDED_RECOVERY_COMMAND',
        kind,
        expected: {
          conversationId: generation.conversationId,
          documentId: String(observation.documentId || generation.ownerDocumentId || ''),
          promptKey: generation.promptKey,
          promptRevision: generation.promptRevision,
          assistantKey: String(observation.assistantKey || ''),
          assistantRevision: String(observation.assistantRevision || '')
        }
      });
    } catch {}
    if (!result?.clicked) watcher.finish({ accepted: false, reason: result?.reason || 'recovery-command-unreachable' });
    const requestEvidence = await watcher.promise;
    let currentIdentity = null;
    try { currentIdentity = conversationFromUrl((await chrome.tabs.get(generation.ownerTabId))?.url); } catch {}
    const confirmed = result?.ok === true && Boolean(result?.newPromptKey) && requestEvidence?.accepted === true && currentIdentity?.id === generation.conversationId;
    if (!confirmed) {
      await finishClaim(claim, incident, {
        uncertain: result?.clicked === true,
        state: 'attention',
        reason: [result?.reason, requestEvidence?.reason, currentIdentity?.id === generation.conversationId ? '' : 'conversation-changed-after-action'].filter(Boolean).join('+') || 'recovery-message-unconfirmed'
      });
      return;
    }
    await registerAutomaticPrompt({
      promptKey: result.newPromptKey,
      conversationId: generation.conversationId,
      humanRunId: generation.humanRunId,
      parentGenerationKey: generation.generationKey,
      actionId: claim.leaseId
    });
    await finishClaim(claim, incident, { state: 'resolved', resolution: `${kind}-confirmed` });
  }

  async function processIncident(incidentId) {
    if (processingPromise) return await processingPromise;
    processingPromise = (async () => {
      const incident = await getRecord(INCIDENT_STORE, incidentId);
      if (!incident || ['resolved', 'dismissed', 'attention'].includes(String(incident.state || ''))) return;
      const generation = await getRecord(GENERATION_STORE, incident.generationKey);
      const humanRun = generation ? await getRecord(HUMAN_RUN_STORE, generation.humanRunId) : null;
      const profile = await readProfile();
      if (!generation || !humanRun) return;
      const enrollment = await recoveryEnrollment(generation.conversationId);
      if (enrollment?.enabled !== true || enrollment?.recoveryEnabled !== true) return;

      if (incident.inFlight) {
        if (incident.inFlight.kind === 'reload') {
          await reconcileReload(incident, generation, humanRun, profile);
        } else {
          await openBreaker('action-interrupted-uncertain');
          await putRecord(INCIDENT_STORE, { ...incident, state: 'attention', budget: { ...incident.budget, uncertainAction: true }, inFlight: null, nextEligibleAt: 0, updatedAt: Date.now() });
          await raiseAttention(generation, 'action-interrupted-uncertain');
        }
        return;
      }

      if (Number(incident.nextEligibleAt || 0) > Date.now()) return;
      const inspected = await queryTabSnapshot(generation.ownerTabId);
      if (!inspected.ok) {
        await putRecord(INCIDENT_STORE, { ...incident, state: 'attention', nextEligibleAt: 0, updatedAt: Date.now() });
        await raiseAttention(generation, inspected.reason);
        return;
      }
      if (inspected.snapshot.conversationId !== generation.conversationId || inspected.snapshot.promptKey !== generation.promptKey) {
        await putRecord(INCIDENT_STORE, { ...incident, state: 'attention', nextEligibleAt: 0, updatedAt: Date.now() });
        await raiseAttention(generation, 'request-identity-changed-before-recovery');
        return;
      }
      const classification = policy()?.classifyObservation?.(inspected.snapshot) || generation.classification || {};
      const candidate = model().recoveryCandidate(classification, inspected.snapshot, incident);
      if (!candidate.kind) {
        if (['coded-terminal', 'work-resumed-after-reload'].includes(candidate.reason) || classification.state === 'working') {
          await putRecord(INCIDENT_STORE, { ...incident, state: 'resolved', resolution: candidate.reason || 'work-resumed', nextEligibleAt: 0, updatedAt: Date.now() });
        } else {
          await putRecord(INCIDENT_STORE, { ...incident, state: 'attention', nextEligibleAt: 0, updatedAt: Date.now() });
          await raiseAttention(generation, candidate.reason || classification.reason || 'automation-stopped');
        }
        return;
      }

      const claimed = await claimAction(candidate.kind, generation, incident, inspected.snapshot, { recoveryEnabled: true });
      if (!claimed.allowed) {
        const live = await getRecord(INCIDENT_STORE, incident.incidentId) || incident;
        if (claimed.reason === 'profile-action-spacing') {
          await scheduleEarliestWake();
        } else {
          await putRecord(INCIDENT_STORE, { ...live, state: 'attention', nextEligibleAt: 0, updatedAt: Date.now() });
          await raiseAttention(generation, claimed.reason);
        }
        return;
      }
      if (candidate.kind === 'reload') await performReload(claimed, generation, incident);
      else await performMessageAction(candidate.kind, claimed, generation, incident, inspected.snapshot);
    })().finally(() => { processingPromise = null; scheduleEarliestWake().catch(() => {}); });
    return await processingPromise;
  }

  async function handleSnapshot(snapshot, sender = {}) {
    if (!snapshot?.conversationId || !snapshot?.promptKey) return;
    const enrollment = await recoveryEnrollment(snapshot.conversationId);
    if (enrollment?.enabled !== true) return;
    const generation = await ensureGeneration(snapshot, sender);
    if (!generation) return;
    const classification = policy()?.classifyObservation?.(snapshot) || { state: 'waiting', reason: 'policy-unavailable' };
    const updated = {
      ...generation,
      ownerTabId: Number.isInteger(sender?.tab?.id) ? sender.tab.id : generation.ownerTabId,
      ownerDocumentId: String(sender?.documentId || snapshot.documentId || generation.ownerDocumentId || ''),
      snapshot: { ...snapshot },
      classification,
      state: classification.state,
      updatedAt: Date.now()
    };
    await putRecord(GENERATION_STORE, updated);

    if (classification.openProfileBreaker) {
      await openBreaker(classification.reason);
      await raiseAttention(updated, classification.reason);
      return;
    }
    if (classification.state === 'coded-terminal') {
      await resolveIncidents(updated.generationKey, `coded:${snapshot.statusCode}`);
      return;
    }
    if (enrollment.recoveryEnabled !== true) return;

    const provisional = model().recoveryCandidate(classification, snapshot, { budget: {} });
    if (!provisional.kind) return;
    const incident = await ensureIncident(updated, classification);
    if (Number(incident.nextEligibleAt || 0) <= Date.now()) processIncident(incident.incidentId).catch(() => {});
    await scheduleEarliestWake();
  }

  async function admitNormalContinuation(identity = {}) {
    const snapshot = {
      conversationId: String(identity.conversationId || ''),
      conversationUrl: String(identity.conversationUrl || ''),
      documentId: String(identity.documentId || ''),
      promptKey: String(identity.promptKey || ''),
      promptRevision: String(identity.promptRevision || ''),
      assistantKey: String(identity.assistantKey || ''),
      assistantRevision: String(identity.assistantRevision || ''),
      observable: true,
      online: true,
      manualStopped: false,
      hasDraft: false,
      hasUpload: false,
      stopGenerating: false,
      toolActivity: false
    };
    let generation = await getRecord(GENERATION_STORE, generationKey(snapshot.conversationId, snapshot.promptKey));
    if (!generation) generation = await ensureGeneration(snapshot, { tab: { id: identity.tabId }, documentId: identity.documentId });
    if (!generation) return { allowed: false, reason: 'generation-missing' };
    return await claimAction('normal-continue', generation, null, snapshot, { recoveryEnabled: false });
  }

  async function finishNormalContinuation(admission, result = {}) {
    if (!admission?.allowed) return;
    const humanRun = await getRecord(HUMAN_RUN_STORE, admission.humanRun.humanRunId) || admission.humanRun;
    const profile = await readProfile();
    const finished = model().finishAction(humanRun, null, profile, {
      leaseId: admission.leaseId,
      uncertain: result.uncertain === true,
      state: result.success ? 'observing' : 'attention'
    }, { now: Date.now() });
    await putRecord(HUMAN_RUN_STORE, finished.humanRun);
    await writeProfile(finished.profile);
    if (result.success && result.newPromptKey) {
      await registerAutomaticPrompt({
        promptKey: result.newPromptKey,
        conversationId: result.conversationId,
        humanRunId: humanRun.humanRunId,
        parentGenerationKey: result.parentGenerationKey || '',
        actionId: admission.leaseId
      });
    }
    if (result.uncertain) await openBreaker('normal-continuation-outcome-uncertain');
  }

  async function resumeConversation(conversationId) {
    const profile = await readProfile();
    if (profile.activeLease) return { ok: false, reason: 'action-still-in-flight' };
    const generations = (await getAll(GENERATION_STORE)).filter((item) => item.conversationId === conversationId).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    const generation = generations[0];
    if (!generation) return { ok: false, reason: 'no-recovery-run' };
    const humanRun = await getRecord(HUMAN_RUN_STORE, generation.humanRunId);
    if (!humanRun) return { ok: false, reason: 'human-run-missing' };
    await putRecord(HUMAN_RUN_STORE, { ...humanRun, generationActions: 0, resumeCount: Number(humanRun.resumeCount || 0) + 1, state: 'active', updatedAt: Date.now() });
    await writeProfile({ ...profile, breakerOpen: false, breakerReason: '', activeLease: null, nextProfileActionAt: Date.now(), updatedAt: Date.now() });
    for (const incident of await getAll(INCIDENT_STORE)) {
      if (incident.humanRunId !== humanRun.humanRunId || ['resolved', 'dismissed'].includes(String(incident.state || ''))) continue;
      await putRecord(INCIDENT_STORE, { ...incident, state: 'dismissed', resolution: 'operator-resume', nextEligibleAt: 0, inFlight: null, updatedAt: Date.now() });
    }
    return { ok: true, humanRunId: humanRun.humanRunId };
  }

  async function overview(conversationId) {
    const generations = (await getAll(GENERATION_STORE)).filter((item) => item.conversationId === conversationId).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    const generation = generations[0] || null;
    const humanRun = generation ? await getRecord(HUMAN_RUN_STORE, generation.humanRunId) : null;
    const incident = generation ? await incidentForGeneration(generation.generationKey) : null;
    const profile = await readProfile();
    return {
      generation: generation ? { generationKey: generation.generationKey, humanRunId: generation.humanRunId, state: generation.state, reason: generation.classification?.reason || '' } : null,
      humanRun: humanRun ? { humanRunId: humanRun.humanRunId, generationActions: Number(humanRun.generationActions || 0), resumeCount: Number(humanRun.resumeCount || 0), state: humanRun.state } : null,
      incident: incident ? { incidentId: incident.incidentId, state: incident.state, reason: incident.reason, budget: incident.budget, nextEligibleAt: incident.nextEligibleAt } : null,
      profile: { breakerOpen: profile.breakerOpen, breakerReason: profile.breakerReason, actionInFlight: Boolean(profile.activeLease), nextProfileActionAt: profile.nextProfileActionAt }
    };
  }

  async function reconstructAfterRestart() {
    const profile = await readProfile();
    if (profile.activeLease) {
      const incident = profile.activeLease.incidentId ? await getRecord(INCIDENT_STORE, profile.activeLease.incidentId) : null;
      if (profile.activeLease.kind === 'reload' && incident) {
        await putRecord(INCIDENT_STORE, { ...incident, state: 'reconciling', nextEligibleAt: Date.now() + 1_000, updatedAt: Date.now() });
      } else {
        await openBreaker('action-interrupted-uncertain');
        if (incident) {
          const generation = await getRecord(GENERATION_STORE, incident.generationKey);
          await putRecord(INCIDENT_STORE, { ...incident, state: 'attention', budget: { ...incident.budget, uncertainAction: true }, inFlight: null, nextEligibleAt: 0, updatedAt: Date.now() });
          if (generation) await raiseAttention(generation, 'action-interrupted-uncertain');
        }
      }
    }
    await scheduleEarliestWake();
  }

  if (chrome.alarms?.onAlarm) {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm?.name !== ALARM_NAME) return;
      (async () => {
        const incidents = (await getAll(INCIDENT_STORE))
          .filter((item) => ['scheduled', 'reconciling'].includes(String(item.state || '')) && Number(item.nextEligibleAt || 0) <= Date.now())
          .sort((a, b) => Number(a.nextEligibleAt || 0) - Number(b.nextEligibleAt || 0));
        if (incidents[0]) await processIncident(incidents[0].incidentId);
        await scheduleEarliestWake();
      })().catch(() => {});
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'CHATGPT_MONITOR_STATE') {
      handleSnapshot(message.snapshot, sender).catch(() => {});
      return false;
    }
    return false;
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== 'complete') return;
    (async () => {
      const incidents = (await getAll(INCIDENT_STORE)).filter((item) => item.state === 'reconciling' && item.inFlight?.kind === 'reload');
      const generations = new Map((await getAll(GENERATION_STORE)).map((item) => [item.generationKey, item]));
      const match = incidents.find((item) => generations.get(item.generationKey)?.ownerTabId === tabId);
      if (match) await processIncident(match.incidentId);
    })().catch(() => {});
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    const watcher = requestWatchers.get(tabId);
    if (watcher) watcher.finish({ accepted: false, reason: 'owner-tab-closed' });
  });

  globalThis.__chatgptNotifierBoundedRecovery = Object.freeze({
    version: 1,
    openBreaker,
    registerAutomaticPrompt,
    admitNormalContinuation,
    finishNormalContinuation,
    resumeConversation,
    overview,
    processIncident,
    reconstructAfterRestart
  });

  reconstructAfterRestart().catch(() => {});
})();
