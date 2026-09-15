'use strict';

(() => {
  if (globalThis.__chatgptNotifierHiddenWindowDiagnostics) return;

  const VERSION = 1;
  const DB_NAME = 'chatgpt-response-notifier-hidden-window-diagnostics';
  const DB_VERSION = 1;
  const STORE_NAME = 'incidents';
  const MAX_INCIDENTS = 20;
  const MAX_TRANSITIONS = 48;
  const MAX_METADATA_BYTES = 128 * 1024;
  const PAGE_QUERY_DEADLINE_MS = 2000;
  const STREAM_FINAL_DEADLINE_MS = 30_000;
  const SETTLED_MAPPING_GRACE_MS = 60_000;
  const TRACE_ALARM = 'chatgpt-notifier-hidden-window-diagnostics-sweep';
  const REQUEST_FILTER = {
    urls: [
      'https://chatgpt.com/backend-api/f/conversation*',
      'https://chatgpt.com/backend-api/conversation*'
    ]
  };

  const workerInstanceId = randomId();
  let workerSequence = 0;
  let databasePromise = null;
  let loadPromise = null;
  let extensionVersion = '';
  let evictedIncidents = 0;
  const incidents = new Map();
  const requestIndex = new Map();
  const streamIndex = new Map();
  const latestPageState = new Map();
  try { extensionVersion = String(chrome.runtime.getManifest().version || ''); } catch {}

  function randomId() {
    try { return crypto.randomUUID(); } catch {}
    return `diag-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function suffix(value) {
    const text = String(value || '').trim();
    return text.length <= 8 ? text : text.slice(-8);
  }

  function requestKey(tabId, requestId) {
    return `${Number(tabId)}|${String(requestId || '')}`;
  }

  function documentKey(tabId, documentId) {
    return `${Number(tabId)}|${String(documentId || '')}`;
  }

  function routeClass(url) {
    try {
      const path = new URL(String(url || '')).pathname.replace(/\/+$/, '');
      if (path === '/backend-api/f/conversation') return 'conversation-f';
      if (path === '/backend-api/conversation') return 'conversation';
    } catch {}
    return 'unknown';
  }

  function isConversationRequest(details) {
    return Number.isInteger(details?.tabId) && details.tabId >= 0 && details.method === 'POST' && routeClass(details.url) !== 'unknown';
  }

  function openDatabase() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'incidentId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('hidden-window diagnostics database unavailable'));
      request.onblocked = () => reject(new Error('hidden-window diagnostics database blocked'));
    });
    databasePromise.catch(() => { databasePromise = null; });
    return databasePromise;
  }

  async function listStoredIncidents() {
    const database = await openDatabase();
    if (!database) return [];
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => reject(request.error || new Error('hidden-window diagnostics read failed'));
    });
  }

  async function storeIncident(incident) {
    const database = await openDatabase();
    if (!database) return;
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(structuredClone(incident));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('hidden-window diagnostics write failed'));
      transaction.onabort = () => reject(transaction.error || new Error('hidden-window diagnostics write aborted'));
    });
  }

  async function deleteIncident(incidentId) {
    const database = await openDatabase();
    if (!database) return;
    await new Promise((resolve) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(String(incidentId || ''));
      transaction.oncomplete = resolve;
      transaction.onerror = resolve;
      transaction.onabort = resolve;
    });
  }

  function projectedIncident(incident) {
    return {
      schemaVersion: 1,
      incidentId: String(incident.incidentId || ''),
      kind: String(incident.kind || ''),
      workerInstanceSuffix: suffix(incident.workerInstanceId),
      tabId: incident.tabId,
      chromeDocumentSuffix: suffix(incident.chromeDocumentId),
      requestSuffix: suffix(incident.requestId),
      startedAt: incident.startedAt || 0,
      settledAt: incident.settledAt || 0,
      streamFinalAt: incident.streamFinalAt || 0,
      routeClass: String(incident.routeClass || 'unknown'),
      httpStatus: Number(incident.httpStatus || 0),
      requestOutcome: String(incident.requestOutcome || ''),
      captureResult: String(incident.captureResult || ''),
      mappingConfidence: String(incident.mappingConfidence || 'unmapped'),
      mappingCandidateCount: Number(incident.mappingCandidateCount || 0),
      traceState: String(incident.traceState || 'collecting'),
      firstUnresolvedBoundary: String(incident.firstUnresolvedBoundary || ''),
      droppedTransitions: Number(incident.droppedTransitions || 0),
      coalescedTransitions: Number(incident.coalescedTransitions || 0),
      retentionEvictedIncidents: evictedIncidents,
      transitions: (incident.transitions || []).map((transition) => ({ ...transition }))
    };
  }

  function emitIncident(incident) {
    const diagnostic = {
      source: 'hidden-window-diagnostics',
      status: 'incident-snapshot',
      observedAt: new Date().toISOString(),
      extensionVersion,
      correlationId: String(incident.incidentId || ''),
      tabId: Number.isInteger(incident.tabId) ? incident.tabId : undefined,
      chromeDocumentSuffix: suffix(incident.chromeDocumentId),
      requestSuffix: suffix(incident.requestId),
      workerInstanceSuffix: suffix(workerInstanceId),
      eventSequence: workerSequence,
      incident: projectedIncident(incident)
    };
    try { if (typeof sendNative === 'function') sendNative({ type: 'diagnostics.event', diagnostic }); } catch {}
  }

  function recordFlat(status, fields = {}) {
    const diagnostic = {
      source: 'hidden-window-diagnostics',
      status: String(status || 'diagnostic'),
      observedAt: new Date().toISOString(),
      extensionVersion,
      correlationId: fields.correlationId ? String(fields.correlationId).slice(0, 80) : undefined,
      tabId: Number.isInteger(fields.tabId) ? fields.tabId : undefined,
      reason: fields.reason ? String(fields.reason).slice(0, 96) : undefined,
      chromeDocumentSuffix: suffix(fields.chromeDocumentId),
      workerInstanceSuffix: suffix(workerInstanceId),
      eventSequence: ++workerSequence
    };
    try { if (typeof sendNative === 'function') sendNative({ type: 'diagnostics.event', diagnostic }); } catch {}
  }

  function transitionFingerprint(item) {
    return [item.stage, item.reason, item.transport, item.streamNonceSuffix, item.visibility, item.windowState, item.mappingConfidence].join('|');
  }

  function appendTransition(incident, stage, fields = {}) {
    const now = Date.now();
    const item = {
      sequence: ++workerSequence,
      stage: String(stage || '').slice(0, 64),
      observedAt: now,
      originObservedAt: Number(fields.originObservedAt || 0),
      workerReceivedAt: Number(fields.workerReceivedAt || now),
      elapsedMs: Number(fields.elapsedMs || 0),
      snapshotAgeMs: Number(fields.snapshotAgeMs || 0),
      contextAgeMs: Number(fields.contextAgeMs || 0),
      reason: String(fields.reason || '').slice(0, 64),
      transport: String(fields.transport || '').slice(0, 16),
      streamNonceSuffix: suffix(fields.streamNonce),
      mappingConfidence: String(fields.mappingConfidence || incident.mappingConfidence || '').slice(0, 48),
      httpStatus: Number(fields.httpStatus || 0),
      mediaTypeClass: String(fields.mediaTypeClass || '').slice(0, 24),
      protocolShape: String(fields.protocolShape || '').slice(0, 24),
      byteCount: Number(fields.byteCount || 0),
      chunkCount: Number(fields.chunkCount || 0),
      frameCount: Number(fields.frameCount || 0),
      dataFrameCount: Number(fields.dataFrameCount || 0),
      jsonFrameCount: Number(fields.jsonFrameCount || 0),
      doneFrameCount: Number(fields.doneFrameCount || 0),
      oversizedFrameCount: Number(fields.oversizedFrameCount || 0),
      rawTokenCount: Number(fields.rawTokenCount || 0),
      decodedCandidateCount: Number(fields.decodedCandidateCount || 0),
      responseStartMs: Number(fields.responseStartMs || 0),
      firstByteMs: Number(fields.firstByteMs || 0),
      eofMs: Number(fields.eofMs || 0),
      semanticFinalEligible: fields.semanticFinalEligible === true,
      semanticRejectionReason: String(fields.semanticRejectionReason || '').slice(0, 48),
      visibility: String(fields.visibility || '').slice(0, 16),
      pageHasFocus: typeof fields.pageHasFocus === 'boolean' ? fields.pageHasFocus : undefined,
      pageFrozen: typeof fields.pageFrozen === 'boolean' ? fields.pageFrozen : undefined,
      tabActive: typeof fields.tabActive === 'boolean' ? fields.tabActive : undefined,
      tabFrozen: typeof fields.tabFrozen === 'boolean' ? fields.tabFrozen : undefined,
      tabDiscarded: typeof fields.tabDiscarded === 'boolean' ? fields.tabDiscarded : undefined,
      windowFocused: typeof fields.windowFocused === 'boolean' ? fields.windowFocused : undefined,
      windowState: String(fields.windowState || '').slice(0, 16),
      count: 1
    };
    const previous = incident.transitions?.[incident.transitions.length - 1] || null;
    if (previous && transitionFingerprint(previous) === transitionFingerprint(item)) {
      previous.observedAt = now;
      previous.workerReceivedAt = item.workerReceivedAt;
      previous.count = Number(previous.count || 1) + 1;
      incident.coalescedTransitions = Number(incident.coalescedTransitions || 0) + 1;
    } else {
      incident.transitions = Array.isArray(incident.transitions) ? incident.transitions : [];
      incident.transitions.push(item);
      if (incident.transitions.length > MAX_TRANSITIONS) {
        incident.transitions.shift();
        incident.droppedTransitions = Number(incident.droppedTransitions || 0) + 1;
      }
    }
    incident.updatedAt = now;
    void persistAndEmit(incident);
  }

  async function persistAndEmit(incident) {
    incidents.set(incident.incidentId, incident);
    await enforceRetention().catch(() => {});
    await storeIncident(incident).catch(() => {});
    emitIncident(incident);
  }

  async function enforceRetention() {
    const ordered = [...incidents.values()].sort((a, b) => Number(a.updatedAt || a.startedAt || 0) - Number(b.updatedAt || b.startedAt || 0));
    const totalBytes = () => {
      try { return new TextEncoder().encode(JSON.stringify(ordered.filter((item) => incidents.has(item.incidentId)).map(projectedIncident))).byteLength; }
      catch { return MAX_METADATA_BYTES + 1; }
    };
    while (incidents.size > MAX_INCIDENTS || totalBytes() > MAX_METADATA_BYTES) {
      const oldest = ordered.find((item) => incidents.has(item.incidentId));
      if (!oldest) break;
      incidents.delete(oldest.incidentId);
      if (oldest.requestId) requestIndex.delete(requestKey(oldest.tabId, oldest.requestId));
      for (const [nonce, id] of streamIndex) if (id === oldest.incidentId) streamIndex.delete(nonce);
      evictedIncidents += 1;
      await deleteIncident(oldest.incidentId).catch(() => {});
    }
  }

  function createIncident(fields = {}) {
    const now = Date.now();
    const incident = {
      incidentId: randomId(),
      kind: String(fields.kind || 'request'),
      workerInstanceId,
      tabId: Number.isInteger(fields.tabId) ? fields.tabId : -1,
      chromeDocumentId: String(fields.chromeDocumentId || ''),
      requestId: String(fields.requestId || ''),
      routeClass: String(fields.routeClass || 'unknown'),
      startedAt: Number(fields.startedAt || now),
      settledAt: 0,
      streamFinalAt: 0,
      updatedAt: now,
      httpStatus: 0,
      requestOutcome: '',
      captureResult: fields.chromeDocumentId ? 'captured' : 'document-missing',
      mappingConfidence: String(fields.mappingConfidence || 'unmapped'),
      mappingCandidateCount: Number(fields.mappingCandidateCount || 0),
      traceState: 'collecting',
      firstUnresolvedBoundary: fields.chromeDocumentId ? '' : 'request-document-identity',
      droppedTransitions: 0,
      coalescedTransitions: 0,
      transitions: []
    };
    incidents.set(incident.incidentId, incident);
    if (incident.requestId) requestIndex.set(requestKey(incident.tabId, incident.requestId), incident.incidentId);
    return incident;
  }

  async function ensureLoaded() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const stored = await listStoredIncidents().catch(() => []);
      for (const item of stored.slice(-MAX_INCIDENTS)) {
        if (!item?.incidentId) continue;
        incidents.set(String(item.incidentId), item);
        if (item.requestId && (!item.settledAt || Date.now() - Number(item.settledAt) <= SETTLED_MAPPING_GRACE_MS)) {
          requestIndex.set(requestKey(item.tabId, item.requestId), String(item.incidentId));
        }
      }
      await enforceRetention().catch(() => {});
    })();
    return loadPromise;
  }

  function candidateIncidents(tabId, documentId, at = Date.now()) {
    return [...incidents.values()].filter((incident) => {
      if (incident.tabId !== tabId || String(incident.chromeDocumentId || '') !== String(documentId || '')) return false;
      if (at < Number(incident.startedAt || 0) - 5000) return false;
      if (!incident.settledAt) return true;
      return at <= Number(incident.settledAt) + SETTLED_MAPPING_GRACE_MS;
    });
  }

  async function queryPageState(incident, reason) {
    if (!incident || incident.tabId < 0 || !incident.chromeDocumentId) return;
    const queryId = randomId();
    const issuedAt = Date.now();
    appendTransition(incident, 'page-query-issued', { reason, originObservedAt: issuedAt, workerReceivedAt: issuedAt });
    let timer = null;
    let settled = false;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'deadline' }), PAGE_QUERY_DEADLINE_MS);
    });
    const request = Promise.resolve().then(() => chrome.tabs.sendMessage(
      incident.tabId,
      { type: 'CHATGPT_HIDDEN_WINDOW_DIAGNOSTICS_QUERY', queryId },
      { documentId: incident.chromeDocumentId }
    )).then((response) => ({ kind: 'reply', response }), () => ({ kind: 'error' }));
    const result = await Promise.race([request, timeout]);
    settled = true;
    if (timer !== null) clearTimeout(timer);
    const receivedAt = Date.now();
    if (result.kind === 'deadline') {
      if (!incident.firstUnresolvedBoundary) incident.firstUnresolvedBoundary = 'page-query-deadline';
      incident.traceState = 'failed-boundary';
      appendTransition(incident, 'page-query-deadline', { reason, elapsedMs: receivedAt - issuedAt });
      request.then(() => {}).catch(() => {});
      return;
    }
    if (result.kind !== 'reply' || result.response?.ok !== true) {
      if (!incident.firstUnresolvedBoundary) incident.firstUnresolvedBoundary = 'page-query-error';
      incident.traceState = 'failed-boundary';
      appendTransition(incident, 'page-query-error', { reason, elapsedMs: receivedAt - issuedAt });
      return;
    }
    const page = result.response;
    const state = {
      visibility: String(page.visibility || 'unknown'),
      pageHasFocus: page.hasFocus === true,
      pageFrozen: page.pageFrozen === true,
      pageObservedAt: Number(page.pageObservedAt || 0),
      pageObserverId: String(page.pageObserverId || '')
    };
    latestPageState.set(documentKey(incident.tabId, incident.chromeDocumentId), state);
    appendTransition(incident, 'page-query-replied', {
      reason,
      originObservedAt: state.pageObservedAt,
      workerReceivedAt: receivedAt,
      elapsedMs: receivedAt - issuedAt,
      snapshotAgeMs: state.pageObservedAt ? Math.max(0, receivedAt - state.pageObservedAt) : 0,
      visibility: state.visibility,
      pageHasFocus: state.pageHasFocus,
      pageFrozen: state.pageFrozen
    });
  }

  async function captureBrowserState(incident, reason) {
    if (!incident || incident.tabId < 0) return;
    try {
      const tab = await chrome.tabs.get(incident.tabId);
      let windowInfo = null;
      try { if (Number.isInteger(tab?.windowId)) windowInfo = await chrome.windows.get(tab.windowId); } catch {}
      const page = latestPageState.get(documentKey(incident.tabId, incident.chromeDocumentId)) || {};
      appendTransition(incident, 'browser-state', {
        reason,
        visibility: page.visibility,
        pageHasFocus: page.pageHasFocus,
        pageFrozen: page.pageFrozen,
        tabActive: tab?.active === true,
        tabFrozen: tab?.frozen === true,
        tabDiscarded: tab?.discarded === true,
        windowFocused: typeof windowInfo?.focused === 'boolean' ? windowInfo.focused : undefined,
        windowState: String(windowInfo?.state || 'unknown')
      });
    } catch {
      appendTransition(incident, 'browser-state-error', { reason: 'tab-state-unavailable' });
    }
  }

  async function startRequest(details) {
    if (!isConversationRequest(details)) return;
    await ensureLoaded();
    const incident = createIncident({
      tabId: details.tabId,
      requestId: details.requestId,
      chromeDocumentId: details.documentId,
      routeClass: routeClass(details.url),
      startedAt: Date.now()
    });
    appendTransition(incident, 'request-started', { reason: incident.captureResult, mappingConfidence: 'request-id-exact' });
    void captureBrowserState(incident, 'request-start');
    void queryPageState(incident, 'request-start');
  }

  async function settleRequest(details, failed) {
    if (!isConversationRequest(details)) return;
    await ensureLoaded();
    let incident = incidents.get(requestIndex.get(requestKey(details.tabId, details.requestId)) || '') || null;
    if (!incident) {
      incident = createIncident({
        kind: 'request-recovered',
        tabId: details.tabId,
        requestId: details.requestId,
        chromeDocumentId: details.documentId,
        routeClass: routeClass(details.url),
        startedAt: Date.now(),
        mappingConfidence: 'request-start-missing'
      });
      incident.traceState = 'failed-boundary';
      incident.firstUnresolvedBoundary = 'request-start-context';
    }
    incident.settledAt = Date.now();
    incident.httpStatus = Number(details.statusCode || 0);
    incident.requestOutcome = failed || incident.httpStatus < 200 || incident.httpStatus >= 300 ? 'error' : 'completed';
    appendTransition(incident, 'request-settled', {
      reason: incident.requestOutcome,
      httpStatus: incident.httpStatus,
      contextAgeMs: Math.max(0, incident.settledAt - incident.startedAt)
    });
    void captureBrowserState(incident, 'request-settled');
    void queryPageState(incident, 'request-settled');
    scheduleSweep().catch(() => {});
  }

  function streamFields(message, incident, receivedAt) {
    return {
      originObservedAt: Number(message.originObservedAt || 0),
      workerReceivedAt: receivedAt,
      elapsedMs: message.originObservedAt ? Math.max(0, receivedAt - Number(message.originObservedAt)) : 0,
      contextAgeMs: Math.max(0, receivedAt - Number(incident.startedAt || receivedAt)),
      transport: message.transport,
      streamNonce: message.streamNonce,
      httpStatus: message.httpStatus,
      mediaTypeClass: message.mediaTypeClass,
      protocolShape: message.protocolShape,
      byteCount: message.byteCount,
      chunkCount: message.chunkCount,
      frameCount: message.frameCount,
      dataFrameCount: message.dataFrameCount,
      jsonFrameCount: message.jsonFrameCount,
      doneFrameCount: message.doneFrameCount,
      oversizedFrameCount: message.oversizedFrameCount,
      rawTokenCount: message.rawTokenCount,
      decodedCandidateCount: message.decodedCandidateCount,
      responseStartMs: message.responseStartMs,
      firstByteMs: message.firstByteMs,
      eofMs: message.eofMs,
      semanticFinalEligible: message.semanticFinalEligible,
      semanticRejectionReason: message.semanticRejectionReason,
      mappingConfidence: incident.mappingConfidence
    };
  }

  async function handleStream(message, sender) {
    await ensureLoaded();
    const tabId = sender?.tab?.id;
    const documentId = String(sender?.documentId || '');
    if (!Number.isInteger(tabId) || !documentId) return;
    const receivedAt = Date.now();
    const nonce = String(message.streamNonce || '');
    let incident = nonce ? incidents.get(streamIndex.get(nonce) || '') || null : null;
    if (!incident) {
      const candidates = candidateIncidents(tabId, documentId, Number(message.originObservedAt || receivedAt));
      if (candidates.length === 1) {
        incident = candidates[0];
        incident.mappingConfidence = 'document-single-request';
        incident.mappingCandidateCount = 1;
      } else {
        incident = createIncident({
          kind: 'stream-orphan',
          tabId,
          chromeDocumentId: documentId,
          startedAt: Number(message.originObservedAt || receivedAt),
          mappingConfidence: candidates.length ? 'ambiguous-overlap' : 'unmapped'
        });
        incident.mappingCandidateCount = candidates.length;
        if (!incident.firstUnresolvedBoundary) incident.firstUnresolvedBoundary = candidates.length ? 'request-stream-mapping-ambiguous' : 'request-stream-mapping-missing';
        incident.traceState = 'failed-boundary';
      }
      if (nonce) streamIndex.set(nonce, incident.incidentId);
    }

    const kind = String(message.kind || 'diagnostic');
    appendTransition(incident, `stream-${kind}`, streamFields(message, incident, receivedAt));
    if (kind === 'stream-observed') {
      void captureBrowserState(incident, 'stream-observed');
      void queryPageState(incident, 'stream-observed');
    }
    if (['stream-ended', 'stream-read-error', 'stream-unreadable'].includes(kind)) {
      incident.streamFinalAt = receivedAt;
      if (kind === 'stream-read-error' || kind === 'stream-unreadable') {
        if (!incident.firstUnresolvedBoundary) incident.firstUnresolvedBoundary = kind;
        incident.traceState = 'failed-boundary';
      } else if (!incident.firstUnresolvedBoundary) {
        incident.traceState = incident.mappingConfidence === 'document-single-request' ? 'complete' : 'insufficient-evidence';
        if (incident.traceState !== 'complete') incident.firstUnresolvedBoundary = 'request-stream-mapping';
      }
      void persistAndEmit(incident);
    }
  }

  async function handlePage(message, sender) {
    await ensureLoaded();
    const tabId = sender?.tab?.id;
    const documentId = String(sender?.documentId || '');
    if (!Number.isInteger(tabId) || !documentId) return;
    const state = {
      visibility: String(message.visibility || 'unknown'),
      pageHasFocus: message.hasFocus === true,
      pageFrozen: message.pageFrozen === true,
      pageObservedAt: Number(message.pageObservedAt || Date.now()),
      pageObserverId: String(message.pageObserverId || '')
    };
    latestPageState.set(documentKey(tabId, documentId), state);
    const candidates = candidateIncidents(tabId, documentId, state.pageObservedAt);
    for (const incident of candidates) {
      appendTransition(incident, `page-${String(message.state || 'state')}`, {
        originObservedAt: state.pageObservedAt,
        workerReceivedAt: Date.now(),
        visibility: state.visibility,
        pageHasFocus: state.pageHasFocus,
        pageFrozen: state.pageFrozen,
        mappingConfidence: candidates.length === 1 ? 'document-single-request' : 'shared-document'
      });
    }
    if (message.state === 'bridge-installed') {
      recordFlat('page-bridge-installed', { tabId, chromeDocumentId: documentId, reason: `bridge-version=${Number(message.bridgeVersion || 0)}` });
    }
  }

  async function sweepDeadlines(now = Date.now()) {
    await ensureLoaded();
    let next = 0;
    for (const incident of incidents.values()) {
      if (!incident.settledAt || incident.streamFinalAt) continue;
      const deadline = Number(incident.settledAt) + STREAM_FINAL_DEADLINE_MS;
      if (deadline > now) {
        next = !next ? deadline : Math.min(next, deadline);
        continue;
      }
      if (!incident.firstUnresolvedBoundary) incident.firstUnresolvedBoundary = 'stream-final-not-observed';
      incident.traceState = 'insufficient-evidence';
      appendTransition(incident, 'trace-deadline', { reason: 'stream-final-not-observed', elapsedMs: now - Number(incident.settledAt) });
    }
    if (next) {
      try { chrome.alarms.create(TRACE_ALARM, { when: Math.max(Date.now() + 250, next) }); } catch {}
    } else {
      try { await chrome.alarms.clear(TRACE_ALARM); } catch {}
    }
  }

  async function scheduleSweep() {
    await sweepDeadlines();
  }

  async function attachExistingTabs() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); } catch { return; }
    for (const tab of tabs) {
      if (!Number.isInteger(tab?.id) || tab.discarded === true || tab.frozen === true) continue;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['hidden-window-diagnostics-main.js'], world: 'MAIN' });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['hidden-window-diagnostics-page.js'] });
        recordFlat('existing-tab-diagnostics-attached', { tabId: tab.id, reason: 'passive-observers-installed' });
      } catch {
        recordFlat('existing-tab-diagnostics-attach-error', { tabId: tab.id, reason: 'script-injection-failed' });
      }
    }
  }

  chrome.webRequest.onBeforeRequest.addListener((details) => { startRequest(details).catch(() => {}); }, REQUEST_FILTER);
  chrome.webRequest.onCompleted.addListener((details) => { settleRequest(details, false).catch(() => {}); }, REQUEST_FILTER);
  chrome.webRequest.onErrorOccurred.addListener((details) => { settleRequest(details, true).catch(() => {}); }, REQUEST_FILTER);
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === 'CHATGPT_HIDDEN_WINDOW_STREAM_DIAGNOSTIC') {
      handleStream(message, sender).catch(() => {});
      return false;
    }
    if (message?.type === 'CHATGPT_HIDDEN_WINDOW_PAGE_DIAGNOSTIC') {
      handlePage(message, sender).catch(() => {});
      return false;
    }
    return false;
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === TRACE_ALARM) sweepDeadlines().catch(() => {});
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    for (const [key, incidentId] of requestIndex) {
      const incident = incidents.get(incidentId);
      if (incident?.tabId === tabId) requestIndex.delete(key);
    }
  });

  globalThis.__chatgptNotifierHiddenWindowDiagnostics = Object.freeze({
    version: VERSION,
    workerInstanceId,
    limits: Object.freeze({ maxIncidents: MAX_INCIDENTS, maxTransitions: MAX_TRANSITIONS, maxMetadataBytes: MAX_METADATA_BYTES, pageQueryDeadlineMs: PAGE_QUERY_DEADLINE_MS }),
    sweepDeadlines,
    attachExistingTabs
  });

  ensureLoaded().then(() => scheduleSweep()).catch(() => {});
  attachExistingTabs().catch(() => {});
  recordFlat('worker-diagnostics-installed', { reason: `version=${VERSION}` });
})();
