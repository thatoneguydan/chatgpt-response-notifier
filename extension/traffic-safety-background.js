'use strict';

(() => {
  if (globalThis.__chatgptNotifierTrafficSafety) return;

  const VERSION = 1;
  const PROFILE_MIN_ACTION_SPACING_MS = 5 * 60_000;
  const REQUEST_MATCH_WINDOW_MS = 30_000;
  const MAX_LEDGER_RECORDS = 80;
  const DB_NAME = 'chatgpt-response-notifier-traffic-safety';
  const DB_VERSION = 1;
  const META_STORE = 'meta';
  const ACTION_STORE = 'actions';
  const META_KEY = 'profile';
  const REQUEST_FILTER = {
    urls: [
      'https://chatgpt.com/backend-api/f/conversation*',
      'https://chatgpt.com/backend-api/conversation*'
    ]
  };

  const runtimeStartedAt = Date.now();
  const runtimeId = (() => { try { return crypto.randomUUID(); } catch { return `${runtimeStartedAt}-${Math.random()}`; } })();
  const authorizedOrigins = new Set();
  const authorizedHumanRuns = new Set();
  const pendingClaims = new Map();
  const requestToAction = new Map();
  let databasePromise = null;
  let stateReady = false;
  let hardBreakerOpen = false;
  let hardBreakerReason = '';
  let hardBreakerOpenedAt = 0;
  let lastAutomaticActionAt = 0;
  let resumeRequestedAt = 0;

  const suffix = (value) => {
    const text = String(value || '');
    return text ? text.slice(-12) : '';
  };

  function normalizePathname(url) {
    try { return new URL(url).pathname.replace(/\/+$/, ''); } catch { return ''; }
  }

  function isAnswerStreamRequest(details) {
    if (details.tabId < 0 || details.method !== 'POST') return false;
    const path = normalizePathname(details.url);
    return path === '/backend-api/f/conversation' || path === '/backend-api/conversation';
  }

  function conversationIdFromUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''));
      if (!['chatgpt.com', 'www.chatgpt.com'].includes(url.hostname)) return '';
      const parts = url.pathname.split('/').filter(Boolean);
      for (let index = parts.length - 2; index >= 0; index -= 1) {
        if (parts[index] !== 'c') continue;
        return decodeURIComponent(parts[index + 1] || '').trim();
      }
    } catch {}
    return '';
  }

  function freshTrustedSnapshot(snapshot = {}, startedAt = runtimeStartedAt) {
    const requestStartedAt = Number(snapshot.requestStartedAt || 0);
    return snapshot.workStartSignal === true &&
      Boolean(snapshot.promptKey) &&
      requestStartedAt >= Number(startedAt || 0) &&
      ['started', 'completed', 'error'].includes(String(snapshot.requestPhase || ''));
  }

  function profileFloor(now = Date.now()) {
    return Number(now) + PROFILE_MIN_ACTION_SPACING_MS;
  }

  function trafficDecision(state = {}, observation = {}, now = Date.now()) {
    if (state.stateReady !== true) return 'traffic-safety-state-loading';
    if (state.hardBreakerOpen === true) return 'traffic-breaker-open';
    if (observation.rateLimited === true) return 'rate-limited';
    if (state.humanRunAuthorized !== true && state.originAuthorized !== true) return 'runtime-safety-hold';
    const lastActionAt = Number(state.lastAutomaticActionAt || 0);
    if (lastActionAt > 0 && Number(now) < lastActionAt + PROFILE_MIN_ACTION_SPACING_MS) return 'traffic-profile-spacing';
    return '';
  }

  function trafficVeto(humanRun = {}, _profile = {}, observation = {}, options = {}) {
    const humanRunId = String(humanRun.humanRunId || '');
    const originPromptKey = String(humanRun.originPromptKey || '');
    return trafficDecision({
      stateReady,
      hardBreakerOpen,
      humanRunAuthorized: authorizedHumanRuns.has(humanRunId),
      originAuthorized: authorizedOrigins.has(originPromptKey),
      lastAutomaticActionAt
    }, observation, Number(options.now ?? Date.now()));
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: 'key' });
        if (!database.objectStoreNames.contains(ACTION_STORE)) database.createObjectStore(ACTION_STORE, { keyPath: 'actionId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open traffic-safety database.'));
      request.onblocked = () => reject(new Error('Traffic-safety database was blocked.'));
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

  async function readMeta() {
    const database = await openDatabase();
    const transaction = database.transaction(META_STORE, 'readonly');
    return await requestResult(transaction.objectStore(META_STORE).get(META_KEY), 'Could not read traffic-safety state.') || null;
  }

  async function writeMeta() {
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(META_STORE, 'readwrite');
      transaction.objectStore(META_STORE).put({
        key: META_KEY,
        hardBreakerOpen,
        hardBreakerReason,
        hardBreakerOpenedAt,
        lastAutomaticActionAt,
        updatedAt: Date.now()
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not persist traffic-safety state.'));
      transaction.onabort = () => reject(transaction.error || new Error('Traffic-safety state write was aborted.'));
    });
  }

  async function putAction(record) {
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(ACTION_STORE, 'readwrite');
      transaction.objectStore(ACTION_STORE).put(record);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not persist traffic action.'));
      transaction.onabort = () => reject(transaction.error || new Error('Traffic action write was aborted.'));
    });
    pruneLedger().catch(() => {});
  }

  async function patchAction(actionId, patch = {}) {
    if (!actionId) return;
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(ACTION_STORE, 'readwrite');
      const store = transaction.objectStore(ACTION_STORE);
      const request = store.get(String(actionId));
      request.onsuccess = () => {
        const current = request.result;
        if (current) store.put({ ...current, ...patch, updatedAt: Date.now() });
      };
      request.onerror = () => reject(request.error || new Error('Could not read traffic action.'));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not update traffic action.'));
      transaction.onabort = () => reject(transaction.error || new Error('Traffic action update was aborted.'));
    });
  }

  async function pruneLedger() {
    const database = await openDatabase();
    const transaction = database.transaction(ACTION_STORE, 'readwrite');
    const store = transaction.objectStore(ACTION_STORE);
    const records = await requestResult(store.getAll(), 'Could not list traffic actions.');
    const sorted = (Array.isArray(records) ? records : []).sort((left, right) => Number(right.claimedAt || 0) - Number(left.claimedAt || 0));
    for (const record of sorted.slice(MAX_LEDGER_RECORDS)) store.delete(record.actionId);
  }

  function setHardBreaker(reason) {
    hardBreakerOpen = true;
    hardBreakerReason = String(reason || 'rate-limited');
    hardBreakerOpenedAt = hardBreakerOpenedAt || Date.now();
    resumeRequestedAt = 0;
    writeMeta().catch(() => {});
  }

  function maybeClearHardBreaker(snapshot) {
    if (!hardBreakerOpen || resumeRequestedAt <= 0) return false;
    if (!freshTrustedSnapshot(snapshot, resumeRequestedAt)) return false;
    if (snapshot.rateLimited === true || snapshot.authRequired === true || snapshot.approvalRequired === true || snapshot.hasDraft === true || snapshot.hasUpload === true || snapshot.online === false) return false;
    hardBreakerOpen = false;
    hardBreakerReason = '';
    hardBreakerOpenedAt = 0;
    resumeRequestedAt = 0;
    writeMeta().catch(() => {});
    return true;
  }

  function noteSnapshot(snapshot = {}) {
    if (snapshot.rateLimited === true) setHardBreaker('rate-limited');
    if (freshTrustedSnapshot(snapshot)) authorizedOrigins.add(String(snapshot.promptKey));
    maybeClearHardBreaker(snapshot);
  }

  function findPendingAction(details) {
    const conversationId = conversationIdFromUrl(details.documentUrl || '');
    const conversationSuffix = suffix(conversationId);
    if (!conversationSuffix) return null;
    const now = Date.now();
    return Array.from(pendingClaims.values())
      .filter((entry) => now - Number(entry.claimedAt || 0) <= REQUEST_MATCH_WINDOW_MS)
      .filter((entry) => !conversationSuffix || entry.conversationSuffix === conversationSuffix)
      .sort((left, right) => Number(right.claimedAt || 0) - Number(left.claimedAt || 0))[0] || null;
  }

  const originalModel = globalThis.ChatGPTNotifierRecoveryModel;
  if (originalModel && typeof originalModel === 'object') {
    globalThis.ChatGPTNotifierRecoveryModel = Object.freeze({
      ...originalModel,
      admissionDecision(kind, humanRun, incident, profile, observation = {}, options = {}) {
        const veto = trafficVeto(humanRun, profile, observation, options);
        if (veto) return { allowed: false, reason: veto };
        return originalModel.admissionDecision(kind, humanRun, incident, profile, observation, options);
      },
      claimAction(kind, humanRun, incident, profile, observation = {}, options = {}) {
        const veto = trafficVeto(humanRun, profile, observation, options);
        if (veto) return { allowed: false, reason: veto };
        const claimed = originalModel.claimAction(kind, humanRun, incident, profile, observation, options);
        if (!claimed?.allowed) return claimed;
        const now = Number(options.now ?? Date.now());
        authorizedHumanRuns.add(String(claimed.humanRun?.humanRunId || humanRun?.humanRunId || ''));
        claimed.profile = {
          ...claimed.profile,
          nextProfileActionAt: Math.max(Number(claimed.profile?.nextProfileActionAt || 0), profileFloor(now))
        };
        lastAutomaticActionAt = now;
        const actionId = String(claimed.leaseId || '');
        const record = {
          actionId,
          runtimeId,
          kind: String(kind || ''),
          claimedAt: now,
          updatedAt: now,
          conversationSuffix: suffix(claimed.humanRun?.conversationId || humanRun?.conversationId),
          humanRunSuffix: suffix(claimed.humanRun?.humanRunId || humanRun?.humanRunId),
          incidentSuffix: suffix(claimed.incident?.incidentId || incident?.incidentId),
          breakerOpenBefore: profile?.breakerOpen === true || hardBreakerOpen,
          nextProfileActionAt: claimed.profile.nextProfileActionAt,
          requestObservedAt: 0,
          requestId: '',
          requestStatus: 0,
          requestResult: '',
          finishedAt: 0,
          outcomeState: '',
          uncertain: false
        };
        pendingClaims.set(actionId, record);
        putAction(record).catch(() => {});
        writeMeta().catch(() => {});
        return claimed;
      },
      finishAction(humanRun, incident, profile, result = {}, options = {}) {
        const finished = originalModel.finishAction(humanRun, incident, profile, result, options);
        const actionId = String(result.leaseId || '');
        if (actionId) {
          pendingClaims.delete(actionId);
          patchAction(actionId, {
            finishedAt: Number(options.now ?? Date.now()),
            outcomeState: String(result.state || ''),
            uncertain: result.uncertain === true,
            breakerOpenAfter: finished?.profile?.breakerOpen === true || hardBreakerOpen
          }).catch(() => {});
        }
        return finished;
      }
    });
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'CHATGPT_MONITOR_STATE') noteSnapshot(message.snapshot || {});
      if (message?.type === 'RESUME_ACTIVE_CHAT_RECOVERY') resumeRequestedAt = Date.now();
      return false;
    });
  }

  if (typeof chrome !== 'undefined' && chrome.webRequest) {
    chrome.webRequest.onBeforeRequest.addListener((details) => {
      if (!isAnswerStreamRequest(details)) return;
      const action = findPendingAction(details);
      if (!action) return;
      requestToAction.set(String(details.requestId || ''), action.actionId);
      patchAction(action.actionId, {
        requestObservedAt: Date.now(),
        requestId: String(details.requestId || ''),
        requestResult: 'request-observed'
      }).catch(() => {});
    }, REQUEST_FILTER);

    chrome.webRequest.onHeadersReceived.addListener((details) => {
      if (!isAnswerStreamRequest(details)) return;
      const actionId = requestToAction.get(String(details.requestId || ''));
      if (!actionId) return;
      const accepted = Number(details.statusCode || 0) >= 200 && Number(details.statusCode || 0) < 300;
      patchAction(actionId, {
        requestStatus: Number(details.statusCode || 0),
        requestResult: accepted ? 'request-accepted' : 'request-rejected'
      }).catch(() => {});
    }, REQUEST_FILTER);

    chrome.webRequest.onErrorOccurred.addListener((details) => {
      if (!isAnswerStreamRequest(details)) return;
      const requestId = String(details.requestId || '');
      const actionId = requestToAction.get(requestId);
      if (!actionId) return;
      requestToAction.delete(requestId);
      patchAction(actionId, {
        requestResult: 'request-error',
        requestError: String(details.error || '').slice(0, 96)
      }).catch(() => {});
    }, REQUEST_FILTER);

    chrome.webRequest.onCompleted.addListener((details) => {
      if (!isAnswerStreamRequest(details)) return;
      const requestId = String(details.requestId || '');
      const actionId = requestToAction.get(requestId);
      if (!actionId) return;
      requestToAction.delete(requestId);
      const accepted = Number(details.statusCode || 0) >= 200 && Number(details.statusCode || 0) < 300;
      patchAction(actionId, {
        requestStatus: Number(details.statusCode || 0),
        requestResult: accepted ? 'request-completed' : 'request-rejected'
      }).catch(() => {});
    }, REQUEST_FILTER);
  }

  globalThis.ChatGPTNotifierTrafficSafetyPolicy = Object.freeze({
    version: VERSION,
    minProfileActionSpacingMs: PROFILE_MIN_ACTION_SPACING_MS,
    freshTrustedSnapshot,
    profileFloor,
    trafficDecision
  });

  globalThis.__chatgptNotifierTrafficSafety = Object.freeze({
    version: VERSION,
    runtimeId,
    runtimeStartedAt,
    noteSnapshot,
    setHardBreaker,
    overview() {
      return {
        stateReady,
        hardBreakerOpen,
        hardBreakerReason,
        hardBreakerOpenedAt,
        lastAutomaticActionAt,
        nextAutomaticActionAt: lastAutomaticActionAt ? lastAutomaticActionAt + PROFILE_MIN_ACTION_SPACING_MS : 0,
        runtimeAuthorizedOrigins: authorizedOrigins.size,
        runtimeAuthorizedHumanRuns: authorizedHumanRuns.size,
        resumeRequested: resumeRequestedAt > 0
      };
    }
  });

  if (typeof indexedDB !== 'undefined') {
    readMeta().then((stored) => {
      hardBreakerOpen = stored?.hardBreakerOpen === true;
      hardBreakerReason = String(stored?.hardBreakerReason || '');
      hardBreakerOpenedAt = Number(stored?.hardBreakerOpenedAt || 0);
      lastAutomaticActionAt = Number(stored?.lastAutomaticActionAt || 0);
      stateReady = true;
    }).catch(() => {
      // Fail closed. A broken local safety store must never silently authorize automation.
      stateReady = false;
      hardBreakerOpen = true;
      hardBreakerReason = 'traffic-safety-state-unavailable';
    });
  }
})();
