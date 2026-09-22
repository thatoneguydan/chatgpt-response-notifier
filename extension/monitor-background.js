'use strict';

(() => {
  if (globalThis.__chatgptNotifierMonitorBackground) return;

  const DB_NAME = 'chatgpt-response-notifier-monitor';
  const DB_VERSION = 1;
  const ENROLLMENT_STORE = 'enrollments';
  const RUN_STORE = 'runs';
  const ATTENTION_STORE = 'attention';
  const PROFILE_STORE = 'profile';
  const AUTOMATION_SCHEMA_VERSION = 2;
  const MAX_RUN_AGE_MS = 14 * 24 * 60 * 60 * 1000;
  const MAX_ATTENTION = 20;
  const CODE_WATCHDOG_RECORD_PREFIX = 'code-watchdog:';
  const CODE_WATCHDOG_ALARM_PREFIX = 'chatgpt-notifier-code-watchdog:';
  const CODE_WATCHDOG_DELAY_MS = 30 * 60_000;
  const CODE_WATCHDOG_RETRY_MS = 60_000;
  const CODE_WATCHDOG_MAX_SENDS = 3;
  const CODE_WATCHDOG_AUTOMATIC_REQUEST_WINDOW_MS = 15_000;
  const HOT_PAGE_ATTACHMENT_RUNTIME_VERSION = 13;
  const HOT_PAGE_MONITOR_RUNTIME_VERSION = 12;
  const HOT_PAGE_STATUS_RUNTIME_VERSION = 15;
  const HOT_PAGE_BOUNDED_RECOVERY_RUNTIME_VERSION = 3;
  const HOT_PAGE_RUNTIME_FILES = Object.freeze([
    'status-code.js',
    'status-policy.js',
    'attachment-script.js',
    'monitor-script.js',
    'bounded-recovery-script.js',
    'status-script.js'
  ]);
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
  const codeWatchdogOverviewSignatures = new Map();
  const codeWatchdogMutationQueues = new Map();

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

  const clone = (value) => value ? structuredClone(value) : value;

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

  async function deleteRecord(storeName, key) {
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).delete(key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error(`Could not delete ${storeName}.`));
      transaction.onabort = () => reject(transaction.error || new Error(`${storeName} delete was aborted.`));
    });
  }

  async function getAll(storeName) {
    const database = await openDatabase();
    const transaction = database.transaction(storeName, 'readonly');
    const records = await requestResult(transaction.objectStore(storeName).getAll(), `Could not list ${storeName}.`);
    return (Array.isArray(records) ? records : []).map(clone);
  }

  function operatorPauseSource(source) {
    return String(source || '') === 'operator-pause';
  }

  function operatorEnableSource(source) {
    return ['operator', 'operator-resume', 'operator-recovery', 'operator-provisional'].includes(String(source || ''));
  }

  async function migrateEnrollmentRecord(record) {
    if (!record || Number(record.schemaVersion || 0) >= AUTOMATION_SCHEMA_VERSION) return record;
    const explicitLegacyPause = record.enabled === false && String(record.source || '') === 'operator';
    const migrated = {
      ...record,
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      revision: Math.max(1, Number(record.revision || 0) + 1),
      enabled: explicitLegacyPause ? false : record.enabled === true,
      recoveryEnabled: explicitLegacyPause ? false : record.enabled === true,
      userPaused: explicitLegacyPause,
      source: explicitLegacyPause ? 'operator-pause' : String(record.source || 'migration'),
      updatedAt: Date.now()
    };
    await putRecord(ENROLLMENT_STORE, migrated);
    return migrated;
  }

  async function getEnrollment(conversationId) {
    const record = await getRecord(ENROLLMENT_STORE, String(conversationId || ''));
    return await migrateEnrollmentRecord(record);
  }

  async function setEnrollment(identity, enabled, source = 'operator', options = {}) {
    if (!identity?.id) return null;
    const existing = await getEnrollment(identity.id);
    const expectedRevision = options.expectedRevision;
    if (expectedRevision !== undefined && expectedRevision !== null && Number(expectedRevision) !== Number(existing?.revision || 0)) {
      const error = new Error('Automation state changed before this command was applied.');
      error.code = 'state-revision-mismatch';
      error.current = existing;
      throw error;
    }
    const now = Date.now();
    const sourceName = String(source || 'operator');
    const paused = operatorPauseSource(sourceName)
      ? true
      : operatorEnableSource(sourceName)
        ? false
        : existing?.userPaused === true;
    const isEnabled = enabled === true && !paused;
    const record = {
      ...(existing || {}),
      conversationId: identity.id,
      conversationUrl: identity.url || existing?.conversationUrl || '',
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      revision: Number(existing?.revision || 0) + 1,
      enabled: isEnabled,
      recoveryEnabled: isEnabled,
      userPaused: paused,
      source: sourceName,
      enrolledAt: existing?.enrolledAt || now,
      updatedAt: now
    };
    await putRecord(ENROLLMENT_STORE, record);
    if (!isEnabled) {
      await queueCodeWatchdogMutation(identity.id, () => clearCodeWatchdog(identity.id));
    }
    return record;
  }

  const provisionalKey = (tabId) => `automation-provisional:${Number(tabId)}`;

  async function getProvisional(tabId) {
    if (!Number.isInteger(tabId)) return null;
    return await getRecord(PROFILE_STORE, provisionalKey(tabId));
  }

  async function setProvisional(tabId, enabled, source, expectedRevision = null) {
    const key = provisionalKey(tabId);
    const existing = await getRecord(PROFILE_STORE, key);
    if (expectedRevision !== null && expectedRevision !== undefined && Number(expectedRevision) !== Number(existing?.revision || 0)) {
      const error = new Error('Automation state changed before this command was applied.');
      error.code = 'state-revision-mismatch';
      error.current = existing;
      throw error;
    }
    const now = Date.now();
    const paused = operatorPauseSource(source);
    const record = {
      key,
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      revision: Number(existing?.revision || 0) + 1,
      tabId,
      enabled: enabled === true && !paused,
      recoveryEnabled: enabled === true && !paused,
      userPaused: paused,
      source: String(source || 'operator'),
      armedRequestId: String(existing?.armedRequestId || ''),
      armedAt: Number(existing?.armedAt || 0),
      updatedAt: now
    };
    return await putRecord(PROFILE_STORE, record);
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
      previousPromptKey: String(snapshot.previousPromptKey || ''),
      previousStatusCode: String(snapshot.previousStatusCode || ''),
      promptRevision: String(snapshot.promptRevision || ''),
      assistantKey: String(snapshot.assistantKey || ''),
      assistantRevision: String(snapshot.assistantRevision || ''),
      statusCode: String(snapshot.statusCode || ''),
      workStartSignal: snapshot.workStartSignal === true,
      projectStartSignal: snapshot.projectStartSignal === true,
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
      interruptionKind: String(snapshot.interruptionKind || ''),
      interruptionAttribution: String(snapshot.interruptionAttribution || ''),
      applicationStateIdentityMatched: snapshot.applicationStateIdentityMatched !== false,
      applicationStateReason: String(snapshot.applicationStateReason || '')
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


  const codeWatchdogKey = (conversationId) => `${CODE_WATCHDOG_RECORD_PREFIX}${String(conversationId || '')}`;
  const codeWatchdogAlarmName = (conversationId) => `${CODE_WATCHDOG_ALARM_PREFIX}${encodeURIComponent(String(conversationId || ''))}`;

  function conversationIdFromCodeWatchdogAlarm(name) {
    const value = String(name || '');
    if (!value.startsWith(CODE_WATCHDOG_ALARM_PREFIX)) return '';
    try { return decodeURIComponent(value.slice(CODE_WATCHDOG_ALARM_PREFIX.length)); } catch { return ''; }
  }

  function codeWatchdogOverviewSignature(record) {
    if (!record) return '';
    return [
      Math.max(0, Number(record.sendCount || 0)),
      Math.max(0, Number(record.deadlineAt || 0)),
      Math.max(0, Number(record.retryAt || 0)),
      String(record.retryReason || ''),
      record.stopped === true ? 1 : 0,
      String(record.stopReason || ''),
      record.waitingForRequestStart === true ? 1 : 0,
      Math.max(0, Number(record.lastRequestStartedAt || 0))
    ].join('|');
  }

  async function readCodeWatchdog(conversationId) {
    if (!conversationId) return null;
    return await getRecord(PROFILE_STORE, codeWatchdogKey(conversationId));
  }

  async function cancelCodeWatchdogAlarm(conversationId) {
    if (!conversationId) return false;
    try { return await chrome.alarms.clear(codeWatchdogAlarmName(conversationId)); } catch { return false; }
  }

  async function clearCodeWatchdog(conversationId) {
    if (!conversationId) return;
    await cancelCodeWatchdogAlarm(conversationId);
    await deleteRecord(PROFILE_STORE, codeWatchdogKey(conversationId));
  }

  async function putCodeWatchdog(conversationId, patch = {}) {
    const existing = await readCodeWatchdog(conversationId);
    const record = {
      ...(existing || {}),
      ...patch,
      key: codeWatchdogKey(conversationId),
      conversationId: String(conversationId || ''),
      watchdogRevision: Math.max(0, Number(existing?.watchdogRevision || 0)) + 1,
      updatedAt: Date.now()
    };
    await putRecord(PROFILE_STORE, record);
    return record;
  }

  async function scheduleCodeWatchdog(recordValue, when) {
    const record = recordValue || null;
    if (!record?.conversationId || record.stopped === true) return record;
    const deadlineAt = Math.max(Date.now() + 1000, Number(when || 0));
    const updated = await putCodeWatchdog(record.conversationId, {
      ...record,
      deadlineAt,
      retryAt: 0,
      retryReason: ''
    });
    try { chrome.alarms.create(codeWatchdogAlarmName(record.conversationId), { when: deadlineAt }); } catch {}
    return updated;
  }

  async function scheduleCodeWatchdogRetry(recordValue, reason = 'retry') {
    const record = recordValue || null;
    if (!record?.conversationId || record.stopped === true) return record;
    const retryAt = Date.now() + CODE_WATCHDOG_RETRY_MS;
    const updated = await putCodeWatchdog(record.conversationId, {
      ...record,
      retryAt,
      retryReason: String(reason || 'retry')
    });
    try { chrome.alarms.create(codeWatchdogAlarmName(record.conversationId), { when: retryAt }); } catch {}
    return updated;
  }

  async function parkCodeWatchdog(recordValue, reason) {
    const record = recordValue || null;
    if (!record?.conversationId) return null;
    await cancelCodeWatchdogAlarm(record.conversationId);
    return await putCodeWatchdog(record.conversationId, {
      ...record,
      stopped: true,
      stopReason: String(reason || 'stopped'),
      deadlineAt: 0,
      retryAt: 0,
      retryReason: ''
    });
  }

  async function parkCodeWatchdogForTerminalStatus(clean, sender, existingValue = null, automaticSentAt = 0, automaticPromptKey = '', automaticParentPromptKey = '') {
    const conversationId = String(clean?.conversationId || existingValue?.conversationId || '');
    if (!conversationId) return null;
    const requestStartedAt = Math.max(
      0,
      Number(clean?.requestStartedAt || 0),
      Number(existingValue?.lastRequestStartedAt || 0)
    );
    await cancelCodeWatchdogAlarm(conversationId);
    return await putCodeWatchdog(conversationId, {
      ...(existingValue || {}),
      conversationUrl: String(clean?.conversationUrl || existingValue?.conversationUrl || ''),
      ownerTabId: Number.isInteger(sender?.tab?.id) ? sender.tab.id : (existingValue?.ownerTabId ?? null),
      stopped: true,
      stopReason: `status:${String(clean?.statusCode || "terminal")}`,
      waitingForRequestStart: false,
      lastRequestStartedAt: requestStartedAt,
      lastPromptKey: String(clean?.promptKey || existingValue?.lastPromptKey || ''),
      lastStatusCode: String(clean?.statusCode || existingValue?.lastStatusCode || ''),
      lastAutomaticSentAt: Math.max(
        Math.max(0, Number(existingValue?.lastAutomaticSentAt || 0)),
        Math.max(0, Number(automaticSentAt || 0))
      ),
      lastAutomaticPromptKey: String(automaticPromptKey || existingValue?.lastAutomaticPromptKey || ''),
      lastAutomaticParentPromptKey: String(automaticParentPromptKey || existingValue?.lastAutomaticParentPromptKey || ''),
      deadlineAt: 0,
      retryAt: 0,
      retryReason: ''
    });
  }

  async function resetCodeWatchdogForIncomplete(clean, sender, existingValue = null, automaticSentAt = 0, automaticPromptKey = '') {
    const conversationId = String(clean?.conversationId || existingValue?.conversationId || '');
    if (!conversationId) return null;
    await cancelCodeWatchdogAlarm(conversationId);
    return await putCodeWatchdog(conversationId, {
      ...(existingValue || {}),
      conversationUrl: String(clean?.conversationUrl || existingValue?.conversationUrl || ''),
      ownerTabId: Number.isInteger(sender?.tab?.id) ? sender.tab.id : (existingValue?.ownerTabId ?? null),
      sendCount: 0,
      stopped: false,
      stopReason: '',
      waitingForRequestStart: true,
      resetAt: Date.now(),
      lastStatusCode: String(clean?.statusCode || ''),
      lastAutomaticSentAt: Math.max(0, Number(automaticSentAt || 0)),
      lastAutomaticPromptKey: String(automaticPromptKey || ''),
      lastAutomaticParentPromptKey: String(automaticPromptKey ? (clean?.promptKey || '') : ''),
      deadlineAt: Math.max(0, Number(automaticSentAt || 0)) > 0
        ? Math.max(0, Number(automaticSentAt || 0)) + CODE_WATCHDOG_DELAY_MS
        : 0,
      retryAt: 0,
      retryReason: ''
    });
  }

  function statusSnapshotBelongsToCurrentWatchdog(clean = {}, current = null) {
    if (!current) return true;
    const snapshotPromptKey = String(clean?.promptKey || '');
    const currentPromptKey = String(current?.lastPromptKey || '');
    if (!snapshotPromptKey || !currentPromptKey || snapshotPromptKey === currentPromptKey) return true;

    const snapshotRequestStartedAt = Math.max(0, Number(clean?.requestStartedAt || 0));
    const currentRequestStartedAt = Math.max(0, Number(current?.lastRequestStartedAt || 0));
    const targetsAutomaticParent = Boolean(
      current?.lastAutomaticPromptKey
      && current?.lastAutomaticParentPromptKey
      && currentPromptKey === String(current.lastAutomaticPromptKey)
      && snapshotPromptKey === String(current.lastAutomaticParentPromptKey)
    );
    if (targetsAutomaticParent) return true;

    // Request phase is page-global and can advance before ChatGPT's DOM exposes
    // the new user turn. A stale snapshot of the prior prompt can therefore carry
    // the new request timestamp. Once a watchdog already tracks another prompt at
    // the same/newer request time, that old prompt must not overwrite it.
    return snapshotRequestStartedAt > currentRequestStartedAt;
  }

  function stoppedWatchdogStillOwnsSnapshot(clean = {}, current = null) {
    if (!current?.stopped) return false;
    const snapshotPromptKey = String(clean?.promptKey || '');
    const currentPromptKey = String(current?.lastPromptKey || '');
    const samePrompt = Boolean(currentPromptKey) && snapshotPromptKey === currentPromptKey;
    const followsAutomaticSend = Boolean(
      (current?.lastAutomaticPromptKey && snapshotPromptKey === String(current.lastAutomaticPromptKey))
      || (Number(current?.lastAutomaticSentAt || 0) > 0
        && Math.abs(Math.max(0, Number(clean?.requestStartedAt || 0)) - Number(current.lastAutomaticSentAt || 0)) <= CODE_WATCHDOG_AUTOMATIC_REQUEST_WINDOW_MS)
    );
    return samePrompt || followsAutomaticSend;
  }

  async function reconcileCodeWatchdogState(clean, sender) {
    const conversationId = String(clean?.conversationId || '');
    if (!conversationId) return null;

    let current = await readCodeWatchdog(conversationId);
    const requestStartedAt = Math.max(0, Number(clean?.requestStartedAt || 0));
    const persistedRequestStartedAt = Math.max(0, Number(current?.lastRequestStartedAt || 0));
    if (requestStartedAt > 0 && persistedRequestStartedAt > 0 && requestStartedAt < persistedRequestStartedAt) {
      return current;
    }

    const previousStatusCode = String(clean?.previousStatusCode || '');
    const previousPromptKey = String(clean?.previousPromptKey || '');
    const currentPromptKey = String(clean?.promptKey || '');
    const isAutomaticFollowup = Boolean(
      current?.lastAutomaticPromptKey
      && currentPromptKey === String(current.lastAutomaticPromptKey)
      && current?.lastAutomaticParentPromptKey
      && previousPromptKey === String(current.lastAutomaticParentPromptKey)
    );
    if (
      isAutomaticFollowup
      && globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(previousStatusCode)
      && globalThis.ChatGPTNotifierContinuationPolicy?.isAutoContinueStatusCode?.(previousStatusCode) !== true
    ) {
      return await parkCodeWatchdogForTerminalStatus(
        { ...clean, promptKey: previousPromptKey, statusCode: previousStatusCode },
        sender,
        current,
        Number(current.lastAutomaticSentAt || 0),
        String(current.lastAutomaticPromptKey || ''),
        previousPromptKey
      );
    }

    const statusCode = String(clean?.statusCode || '');
    if (
      globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(statusCode)
      && !statusSnapshotBelongsToCurrentWatchdog(clean, current)
    ) {
      return current;
    }
    if (globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(statusCode)) {
      if (globalThis.ChatGPTNotifierContinuationPolicy?.isAutoContinueStatusCode?.(statusCode) === true) {
        if (
          current?.waitingForRequestStart === true
          && Number(current.lastAutomaticSentAt || 0) > 0
          && String(current.lastStatusCode || '') === statusCode
          && requestStartedAt > 0
          && requestStartedAt === persistedRequestStartedAt
        ) {
          return current;
        }
        return await resetCodeWatchdogForIncomplete(clean, sender, current);
      }
      return await parkCodeWatchdogForTerminalStatus(clean, sender, current);
    }

    if (!requestStartedAt) return current;
    if (current?.waitingForRequestStart === true) {
      const resetAt = Math.max(0, Number(current.resetAt || 0));
      if (requestStartedAt < resetAt - CODE_WATCHDOG_AUTOMATIC_REQUEST_WINDOW_MS) return current;
      current = {
        ...current,
        sendCount: 0,
        stopped: false,
        stopReason: '',
        waitingForRequestStart: false
      };
    }

    if (current?.stopped === true) {
      if (stoppedWatchdogStillOwnsSnapshot(clean, current)) {
        if (
          requestStartedAt > Number(current.lastRequestStartedAt || 0)
          || String(clean.promptKey || '') !== String(current.lastPromptKey || '')
        ) {
          current = await putCodeWatchdog(conversationId, {
            ...current,
            lastRequestStartedAt: Math.max(requestStartedAt, Number(current.lastRequestStartedAt || 0)),
            lastPromptKey: String(clean.promptKey || current.lastPromptKey || ''),
            conversationUrl: clean.conversationUrl || current.conversationUrl || '',
            ownerTabId: Number.isInteger(sender?.tab?.id) ? sender.tab.id : (current.ownerTabId ?? null)
          });
        }
        return current;
      }
      current = null;
    }

    let sendCount = Math.max(0, Number(current?.sendCount || 0));
    const requestChanged = requestStartedAt !== Number(current?.lastRequestStartedAt || 0);
    if (requestChanged && current) {
      const followsAutomaticSend = (current.lastAutomaticPromptKey && String(clean.promptKey || '') === String(current.lastAutomaticPromptKey))
        || (Number(current.lastAutomaticSentAt || 0) > 0
          && Math.abs(requestStartedAt - Number(current.lastAutomaticSentAt || 0)) <= CODE_WATCHDOG_AUTOMATIC_REQUEST_WINDOW_MS);
      if (!followsAutomaticSend) sendCount = 0;
    }

    const ownerTabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : (current?.ownerTabId ?? null);
    const conversationUrl = String(clean.conversationUrl || current?.conversationUrl || '');
    if (
      current &&
      !requestChanged &&
      current.waitingForRequestStart !== true &&
      current.stopped !== true &&
      Number(current.deadlineAt || 0) > 0 &&
      current.ownerTabId === ownerTabId &&
      String(current.conversationUrl || '') === conversationUrl
    ) {
      return current;
    }

    const record = await putCodeWatchdog(conversationId, {
      ...(current || {}),
      conversationUrl,
      ownerTabId,
      sendCount,
      stopped: false,
      stopReason: '',
      waitingForRequestStart: false,
      lastRequestStartedAt: requestStartedAt,
      lastPromptKey: String(clean.promptKey || ''),
      lastStatusCode: '',
      deadlineAt: requestStartedAt + CODE_WATCHDOG_DELAY_MS
    });
    return await scheduleCodeWatchdog(record, requestStartedAt + CODE_WATCHDOG_DELAY_MS);
  }

  function queueCodeWatchdogMutation(conversationIdValue, operation) {
    const conversationId = String(conversationIdValue || '');
    if (!conversationId) return Promise.resolve(null);
    const previous = codeWatchdogMutationQueues.get(conversationId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => operation());
    codeWatchdogMutationQueues.set(conversationId, next);
    next.finally(() => {
      if (codeWatchdogMutationQueues.get(conversationId) === next) {
        codeWatchdogMutationQueues.delete(conversationId);
      }
    }).catch(() => {});
    return next;
  }

  function reconcileCodeWatchdog(clean, sender) {
    const conversationId = String(clean?.conversationId || '');
    return queueCodeWatchdogMutation(
      conversationId,
      () => reconcileCodeWatchdogState(clean, sender)
    );
  }

  async function tabForCodeWatchdog(record) {
    if (Number.isInteger(record?.ownerTabId)) {
      try {
        const tab = await chrome.tabs.get(record.ownerTabId);
        if (tab?.discarded !== true && tab?.frozen !== true && conversationFromUrl(tab?.url || '')?.id === record.conversationId) return tab;
      } catch {}
    }
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); } catch { return null; }
    return tabs.find((tab) => Number.isInteger(tab.id)
      && tab.discarded !== true
      && tab.frozen !== true
      && conversationFromUrl(tab.url || '')?.id === record.conversationId) || null;
  }

  async function ensureCodeWatchdogPageRuntime(tabId) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_MONITOR_QUERY' });
      if (result?.snapshot || result?.conversationId) return result?.snapshot || result;
    } catch {}
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['status-code.js', 'status-policy.js', 'monitor-script.js', 'status-script.js']
      });
      const result = await chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_MONITOR_QUERY' });
      return result?.snapshot || result || null;
    } catch {
      return null;
    }
  }

  async function queryTerminalStatusForPrompt(tabId, conversationId, promptKey = '') {
    const expectedConversationId = String(conversationId || '');
    const expectedPromptKey = String(promptKey || '');
    if (!Number.isInteger(tabId) || !expectedConversationId || !expectedPromptKey) return null;

    const query = async () => {
      try {
        return await chrome.tabs.sendMessage(tabId, {
          type: 'CHATGPT_STATUS_FOR_PROMPT_QUERY',
          conversationId: expectedConversationId,
          promptKey: expectedPromptKey
        });
      } catch {
        return null;
      }
    };

    let result = await query();
    if (!result?.ok) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['status-code.js', 'status-policy.js', 'status-script.js']
        });
      } catch {
        return null;
      }
      result = await query();
    }

    if (
      result?.ok !== true
      || String(result.conversationId || '') !== expectedConversationId
      || String(result.promptKey || '') !== expectedPromptKey
    ) return null;
    return result;
  }

  async function sendCodeWatchdogContinuation(tabId, conversationId, promptKey = '') {
    try {
      return await chrome.tabs.sendMessage(tabId, {
        type: 'CHATGPT_WATCHDOG_CONTINUE_COMMAND',
        conversationId,
        promptKey: String(promptKey || '')
      });
    } catch {}
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['status-code.js', 'status-policy.js', 'status-script.js']
      });
      return await chrome.tabs.sendMessage(tabId, {
        type: 'CHATGPT_WATCHDOG_CONTINUE_COMMAND',
        conversationId,
        promptKey: String(promptKey || '')
      });
    } catch (error) {
      return { ok: false, clicked: false, reason: 'watchdog-runtime-unavailable', error: String(error?.message || error) };
    }
  }

  function codeWatchdogNoCodeEligibility(snapshot = {}) {
    if (snapshot.observable === false) return { eligible: false, reason: 'page-unobservable' };
    if (snapshot.online === false) return { eligible: false, reason: 'offline' };
    if (snapshot.authRequired === true) return { eligible: false, reason: 'auth-required' };
    if (snapshot.approvalRequired === true) return { eligible: false, reason: 'approval-required' };
    if (snapshot.rateLimited === true) return { eligible: false, reason: 'rate-limited' };
    if (snapshot.hasDraft === true) return { eligible: false, reason: 'draft-present' };
    if (snapshot.hasUpload === true) return { eligible: false, reason: 'upload-present' };
    if (snapshot.applicationStateIdentityMatched === false) return { eligible: false, reason: 'application-state-identity-mismatch' };
    return { eligible: true, reason: 'deadline-no-code' };
  }

  async function handleCodeWatchdogAlarmState(conversationId) {
    let record = await readCodeWatchdog(conversationId);
    if (!record || record.stopped === true) return;
    const enrollment = await getEnrollment(conversationId);
    if (enrollment?.enabled !== true || enrollment?.userPaused === true) {
      await clearCodeWatchdog(conversationId);
      return;
    }
    if (Number(record.sendCount || 0) >= CODE_WATCHDOG_MAX_SENDS) {
      await parkCodeWatchdog(record, 'retry-cap-reached');
      return;
    }

    const tab = await tabForCodeWatchdog(record);
    if (!tab) {
      await scheduleCodeWatchdogRetry(record, 'page-unavailable');
      return;
    }

    const live = await ensureCodeWatchdogPageRuntime(tab.id);
    if (!live || String(live.conversationId || '') !== conversationId) {
      await scheduleCodeWatchdogRetry(record, 'runtime-unavailable');
      return;
    }

    const exactPromptStatus = await queryTerminalStatusForPrompt(
      tab.id,
      conversationId,
      String(live.promptKey || '')
    );
    const exactStatusCode = String(exactPromptStatus?.statusCode || '');
    const liveStatusCode = String(live.statusCode || '');
    const statusCode = globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(exactStatusCode)
      ? exactStatusCode
      : liveStatusCode;
    const statusSnapshot = statusCode === liveStatusCode
      ? live
      : { ...live, statusCode };
    if (globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(statusCode)) {
      if (globalThis.ChatGPTNotifierContinuationPolicy?.isAutoContinueStatusCode?.(statusCode) !== true) {
        await parkCodeWatchdogForTerminalStatus(statusSnapshot, { tab }, record);
        return;
      }
      const result = await sendCodeWatchdogContinuation(tab.id, conversationId, String(statusSnapshot.promptKey || ''));
      const automaticSentAt = result?.ok === true ? Date.now() : 0;
      record = await resetCodeWatchdogForIncomplete(statusSnapshot, { tab }, record, automaticSentAt, result?.continuationUserKey || '');
      if (result?.ok === true) {
        await scheduleCodeWatchdog(record, automaticSentAt + CODE_WATCHDOG_DELAY_MS);
      } else {
        await scheduleCodeWatchdogRetry(record, result?.reason || 'continue-send-failed');
      }
      return;
    }

    const liveRequestStartedAt = Math.max(0, Number(live.requestStartedAt || 0));
    if (liveRequestStartedAt && liveRequestStartedAt !== Number(record.lastRequestStartedAt || 0)) {
      await reconcileCodeWatchdogState(live, { tab });
      const refreshed = await readCodeWatchdog(conversationId);
      if (!refreshed || refreshed.stopped === true || Number(refreshed.deadlineAt || 0) > Date.now() + 1000) return;
      record = refreshed;
    }

    const noCodeEligibility = codeWatchdogNoCodeEligibility(live);
    if (noCodeEligibility.eligible !== true) {
      await scheduleCodeWatchdogRetry(record, noCodeEligibility.reason);
      return;
    }

    const result = await sendCodeWatchdogContinuation(tab.id, conversationId, String(live.promptKey || ''));
    const racedStatusCode = String(result?.statusCode || '');
    if (globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(racedStatusCode)) {
      if (globalThis.ChatGPTNotifierContinuationPolicy?.isAutoContinueStatusCode?.(racedStatusCode) === true) {
        const automaticSentAt = result?.ok === true ? Date.now() : 0;
        record = await resetCodeWatchdogForIncomplete(
          { ...live, statusCode: racedStatusCode },
          { tab },
          record,
          automaticSentAt,
          result?.continuationUserKey || ''
        );
        if (result?.ok === true) {
          await scheduleCodeWatchdog(record, automaticSentAt + CODE_WATCHDOG_DELAY_MS);
        } else {
          await scheduleCodeWatchdogRetry(record, result?.reason || 'continue-send-failed');
        }
      } else {
        const automaticSentAt = result?.ok === true ? Date.now() : 0;
        await parkCodeWatchdogForTerminalStatus(
          { ...live, statusCode: racedStatusCode },
          { tab },
          record,
          automaticSentAt,
          result?.continuationUserKey || '',
          String(live.promptKey || '')
        );
      }
      return;
    }

    if (result?.ok !== true) {
      await scheduleCodeWatchdogRetry(record, result?.reason || 'continue-send-failed');
      return;
    }

    const sentAt = Date.now();
    const nextCount = Math.max(0, Number(record.sendCount || 0)) + 1;
    const nextDeadlineAt = sentAt + CODE_WATCHDOG_DELAY_MS;
    record = {
      ...record,
      ownerTabId: tab.id,
      sendCount: nextCount,
      lastAutomaticSentAt: sentAt,
      lastAutomaticPromptKey: String(result?.continuationUserKey || ''),
      lastAutomaticParentPromptKey: String(live.promptKey || record.lastPromptKey || ''),
      waitingForRequestStart: false,
      deadlineAt: nextDeadlineAt,
      retryAt: 0,
      retryReason: ''
    };
    if (nextCount >= CODE_WATCHDOG_MAX_SENDS) {
      await parkCodeWatchdog(record, 'retry-cap-reached');
      return;
    }
    await scheduleCodeWatchdog(record, nextDeadlineAt);
  }

  function handleCodeWatchdogAlarm(conversationId) {
    return queueCodeWatchdogMutation(
      conversationId,
      () => handleCodeWatchdogAlarmState(conversationId)
    );
  }

  function closeDerivedReason(reason) {
    return String(reason || '').includes('owner-tab-closed');
  }

  async function updateRun(snapshotValue, sender = {}) {
    const snapshot = sanitizedSnapshot(snapshotValue);
    const key = runKey(snapshot);
    if (!key) return null;
    const current = await getRecord(RUN_STORE, key);
    if (current?.state === 'detached' && current?.reason === 'owner-tab-closed-quiet') {
      let liveOwner = false;
      const senderTabId = sender?.tab?.id;
      if (Number.isInteger(senderTabId)) {
        try {
          const tab = await chrome.tabs.get(senderTabId);
          liveOwner = conversationFromUrl(tab?.url || '')?.id === snapshot.conversationId;
        } catch {}
      }
      if (!liveOwner) return current;
    }
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
      'page-unobservable': 'The monitored ChatGPT page cannot currently be observed. No reload or Send action was attempted.'
    };
    return labels[reason] || `The monitored build needs attention: ${reason}.`;
  }

  async function ensureAttention(run, reason) {
    const reasonText = String(reason || '');
    if (!run?.runKey || !reasonText || closeDerivedReason(reasonText)) return null;
    const currentRun = await getRecord(RUN_STORE, run.runKey);
    if (currentRun?.state === 'detached' && currentRun?.reason === 'owner-tab-closed-quiet') return null;
    const enrollment = await getEnrollment(run.conversationId);
    if (enrollment?.enabled !== true || enrollment?.userPaused === true) return null;
    const attentionId = `attention:${run.runId}:${reasonText}`;
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
      reason: reasonText,
      preview: attentionPreview(reasonText),
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

  async function acknowledgeAttention(attentionId) {
    const record = await getRecord(ATTENTION_STORE, String(attentionId || ''));
    if (!record) return false;
    await putRecord(ATTENTION_STORE, { ...record, acknowledged: true, updatedAt: Date.now() });
    try { if (typeof sendNative === 'function') sendNative({ type: 'toast.dismissEvent', notificationId: record.attentionId }); } catch {}
    return true;
  }

  async function pruneAttention() {
    const records = await getAll(ATTENTION_STORE);
    records.sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
    for (const stale of records.slice(MAX_ATTENTION)) await deleteRecord(ATTENTION_STORE, stale.attentionId);
  }

  async function flushAttention() {
    if (attentionFlushPromise) return await attentionFlushPromise;
    attentionFlushPromise = (async () => {
      if (typeof sendNativeRequest !== 'function') return;
      const records = (await getAll(ATTENTION_STORE))
        .filter((item) => !item.delivered && !item.acknowledged && !closeDerivedReason(item.reason))
        .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
      for (const record of records) {
        const currentRun = await getRecord(RUN_STORE, record.runKey);
        if (currentRun?.state === 'detached' && currentRun?.reason === 'owner-tab-closed-quiet') {
          await acknowledgeAttention(record.attentionId);
          continue;
        }
        const enrollment = await getEnrollment(record.conversationId);
        if (enrollment?.enabled !== true || enrollment?.userPaused === true) continue;
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

  async function migrateProvisionalIfReady(clean, sender) {
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId) || !clean.conversationId) return null;
    const provisional = await getProvisional(tabId);
    if (!provisional) return null;
    if (Number(provisional.armedAt || 0) <= 0) {
      return null;
    }
    const identity = { id: clean.conversationId, url: clean.conversationUrl };
    const record = await setEnrollment(identity, provisional.enabled === true, provisional.userPaused ? 'operator-pause' : 'operator-provisional');
    await deleteRecord(PROFILE_STORE, provisionalKey(tabId));
    return record;
  }

  async function handleSnapshot(snapshot, sender) {
    const clean = sanitizedSnapshot(snapshot);
    if (!clean.conversationId || !clean.promptKey) return null;
    if (Number.isInteger(sender?.tab?.id)) tabConversations.set(sender.tab.id, clean.conversationId);

    const migratedEnrollment = await migrateProvisionalIfReady(clean, sender);
    let enrollmentChanged = Boolean(migratedEnrollment);
    let enrollment = migratedEnrollment || await getEnrollment(clean.conversationId);
    const statusIsValid = Boolean(globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(clean.statusCode));
    const freshRequestEvidence = clean.requestStartedAt > 0 && ['started', 'completed', 'error'].includes(clean.requestPhase);
    const recognizedScope = freshRequestEvidence && (clean.projectStartSignal === true || clean.workStartSignal === true || statusIsValid);
    if (recognizedScope && enrollment?.enabled !== true && enrollment?.userPaused !== true) {
      const source = clean.projectStartSignal === true
        ? 'project-start-signal'
        : clean.workStartSignal === true
          ? 'work-start-signal'
          : 'coded-turn';
      enrollment = await setEnrollment(
        { id: clean.conversationId, url: clean.conversationUrl },
        true,
        source
      );
      enrollmentChanged = true;
    }

    const senderTarget = Number.isInteger(sender?.tab?.id)
      ? { tab: sender.tab, id: clean.conversationId, url: clean.conversationUrl }
      : null;

    if (enrollment?.enabled !== true || enrollment?.userPaused === true) {
      if (enrollmentChanged && senderTarget) publishAutomationOverview(senderTarget).catch(() => {});
      return null;
    }

    const run = await updateRun(clean, sender);
    const codeWatchdog = await reconcileCodeWatchdog(clean, sender);
    const watchdogSignature = codeWatchdogOverviewSignature(codeWatchdog);
    const previousWatchdogSignature = codeWatchdogOverviewSignatures.get(clean.conversationId);
    const watchdogChanged = watchdogSignature !== previousWatchdogSignature;
    if (watchdogChanged) codeWatchdogOverviewSignatures.set(clean.conversationId, watchdogSignature);
    if ((enrollmentChanged || watchdogChanged) && senderTarget) publishAutomationOverview(senderTarget).catch(() => {});
    return run;
  }

  async function sendRequestPhase(tabId, phase, details, requestStartedAt = 0) {
    if (!Number.isInteger(tabId) || tabId < 0) return;
    const message = {
      type: 'CHATGPT_MONITOR_REQUEST_PHASE',
      phase,
      requestId: String(details?.requestId || ''),
      requestStartedAt: Math.max(0, Number(requestStartedAt || 0)),
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

  async function armProvisionalForRequest(tabId, requestId) {
    const provisional = await getProvisional(tabId);
    if (!provisional || provisional.enabled !== true || provisional.userPaused === true) return;
    await putRecord(PROFILE_STORE, {
      ...provisional,
      armedRequestId: String(requestId || ''),
      armedAt: Date.now(),
      updatedAt: Date.now()
    });
  }

  async function queryHotPageRuntime(tabId) {
    const expectedExtensionVersion = (() => {
      try { return String(chrome.runtime.getManifest().version || ''); } catch { return ''; }
    })();
    let attachment = null;
    let monitor = null;
    let status = null;
    let bounded = null;
    try { attachment = await chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_NOTIFIER_ATTACHMENT_PING' }); } catch {}
    try { monitor = await chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_MONITOR_QUERY' }); } catch {}
    try { status = await chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_STATUS_RUNTIME_PING' }); } catch {}
    try { bounded = await chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_BOUNDED_RECOVERY_PING' }); } catch {}
    return {
      attachmentCurrent: attachment?.ok === true
        && Number(attachment.runtimeVersion || 0) >= HOT_PAGE_ATTACHMENT_RUNTIME_VERSION
        && String(attachment.extensionVersion || '') === expectedExtensionVersion,
      monitorCurrent: Number(monitor?.snapshot?.monitorRuntimeVersion || monitor?.monitorRuntimeVersion || 0) >= HOT_PAGE_MONITOR_RUNTIME_VERSION,
      statusCurrent: status?.ok === true && Number(status.runtimeVersion || 0) >= HOT_PAGE_STATUS_RUNTIME_VERSION,
      boundedCurrent: bounded?.ok === true && Number(bounded.runtimeVersion || 0) >= HOT_PAGE_BOUNDED_RECOVERY_RUNTIME_VERSION
    };
  }

  function hotPageRuntimeCurrent(state) {
    return state?.attachmentCurrent === true
      && state?.monitorCurrent === true
      && state?.statusCurrent === true
      && state?.boundedCurrent === true;
  }

  async function ensureHotPageRuntime(tabId) {
    if (!Number.isInteger(tabId)) return false;
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch { return false; }
    if (tab?.discarded === true || tab?.frozen === true) return false;
    const rawUrl = String(tab?.url || '');
    if (!/^https:\/\/chatgpt\.com\//i.test(rawUrl)) return false;

    const before = await queryHotPageRuntime(tabId);
    if (hotPageRuntimeCurrent(before)) return true;

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [...HOT_PAGE_RUNTIME_FILES]
      });
    } catch {
      return false;
    }

    return hotPageRuntimeCurrent(await queryHotPageRuntime(tabId));
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
      await ensureHotPageRuntime(tab.id);
    }
  }

  function chatTargetFromTab(tab) {
    if (!Number.isInteger(tab?.id)) return null;
    let parsed = null;
    try { parsed = new URL(String(tab.url || '')); } catch { return null; }
    if (!['chatgpt.com', 'www.chatgpt.com'].includes(parsed.hostname)) return null;
    const identity = conversationFromUrl(tab.url || '');
    return { tab, id: identity?.id || '', url: identity?.url || String(tab.url || '') };
  }

  function senderChatTarget(sender) {
    return chatTargetFromTab(sender?.tab);
  }

  async function activeChatTarget() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: ['https://chatgpt.com/*'] }); } catch { return null; }
    return chatTargetFromTab(tabs[0]);
  }

  async function activeChatIdentity() {
    const active = await activeChatTarget();
    return active?.id ? active : null;
  }

  async function monitorOverview(identity = null) {
    const active = identity || await activeChatTarget();
    const enrollment = active?.id ? await getEnrollment(active.id) : null;
    const provisional = !active?.id && Number.isInteger(active?.tab?.id) ? await getProvisional(active.tab.id) : null;
    const state = enrollment || provisional;
    const run = active?.id ? await latestRunForConversation(active.id) : null;
    const attention = (await getAll(ATTENTION_STORE))
      .filter((item) => !item.acknowledged)
      .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
      .slice(0, MAX_ATTENTION);
    const profile = await readProfileState();
    const codeWatchdog = active?.id ? await readCodeWatchdog(active.id) : null;
    let helperConnected = false;
    try { helperConnected = typeof bridgeSocket !== 'undefined' && bridgeSocket?.readyState === WebSocket.OPEN; } catch {}
    let recovery = null;
    try { if (active?.id) recovery = await globalThis.__chatgptNotifierBoundedRecovery?.overview?.(active.id) || null; } catch {}
    return {
      activeTabId: Number.isInteger(active?.tab?.id) ? active.tab.id : null,
      activeConversationId: active?.id || '',
      activeConversationUrl: active?.url || '',
      automationEnabled: state?.enabled === true && state?.userPaused !== true,
      monitoring: state?.enabled === true && state?.userPaused !== true,
      recoveryEnabled: state?.enabled === true && state?.userPaused !== true,
      pausedByUser: state?.userPaused === true,
      stateRevision: Number(state?.revision || 0),
      enrollmentSource: state?.source || '',
      provisional: !active?.id && Boolean(provisional),
      run,
      recovery,
      attention,
      profile,
      codeWatchdog,
      codeWatchdogMaxSends: CODE_WATCHDOG_MAX_SENDS,
      helperConnected
    };
  }

  function codeWatchdogBudgetReset(recordValue, now = Date.now()) {
    const record = recordValue || null;
    if (!record) return null;
    const resetAt = Math.max(0, Number(now || Date.now()));
    const capExhausted = record.stopped === true && String(record.stopReason || '') === 'retry-cap-reached';
    return {
      ...record,
      sendCount: 0,
      budgetResetAt: resetAt,
      ...(capExhausted ? {
        stopped: false,
        stopReason: '',
        waitingForRequestStart: false,
        deadlineAt: resetAt + CODE_WATCHDOG_DELAY_MS,
        retryAt: 0,
        retryReason: ''
      } : {})
    };
  }

  async function resetCodeWatchdogBudgetForTarget(message, target) {
    if (!target?.id || !Number.isInteger(target?.tab?.id)) {
      return { ok: false, error: 'Open a monitored ChatGPT conversation to reset auto-continues.', reason: 'watchdog-target-unavailable' };
    }
    if (message?.conversationId && String(message.conversationId) !== String(target.id)) {
      return { ok: false, error: 'The ChatGPT conversation changed before the reset was applied.', reason: 'target-conversation-changed' };
    }

    const enrollment = await getEnrollment(target.id);
    if (enrollment?.enabled !== true || enrollment?.userPaused === true) {
      const overview = await monitorOverview(target);
      return { ok: false, error: 'Build automation is not active for this conversation.', reason: 'automation-not-active', requestId: String(message?.requestId || ''), ...overview };
    }

    let record = await queueCodeWatchdogMutation(target.id, async () => {
      const current = await readCodeWatchdog(target.id);
      if (!current) return null;
      const capExhausted = current.stopped === true && String(current.stopReason || '') === 'retry-cap-reached';
      const updated = await putCodeWatchdog(target.id, codeWatchdogBudgetReset(current));
      if (capExhausted) {
        try { chrome.alarms.create(codeWatchdogAlarmName(target.id), { when: updated.deadlineAt }); } catch {}
      }
      return updated;
    });

    const overview = await monitorOverview(target);
    publishAutomationOverview(target, overview).catch(() => {});
    return {
      ok: true,
      requestId: String(message?.requestId || ''),
      reset: true,
      ...overview
    };
  }

  async function resetSenderCodeWatchdogBudget(message, sender) {
    return await resetCodeWatchdogBudgetForTarget(message, senderChatTarget(sender));
  }

  async function publishAutomationOverview(target, overview = null) {
    if (!target || !Number.isInteger(target?.tab?.id)) return false;
    const next = overview || await monitorOverview(target);
    try {
      await chrome.tabs.sendMessage(target.tab.id, {
        type: 'BUILD_AUTOMATION_STATE_CHANGED',
        overview: next
      });
      return true;
    } catch {
      return false;
    }
  }

  async function setAutomationForTarget(message, target) {
    if (!target) return { ok: false, error: 'Open ChatGPT to change build automation.' };
    if (Number.isInteger(message?.tabId) && message.tabId !== target.tab.id) return { ok: false, error: 'The ChatGPT tab changed before the command was applied.', reason: 'target-tab-changed' };
    if (message?.conversationId && String(message.conversationId) !== String(target.id || '')) return { ok: false, error: 'The ChatGPT conversation changed before the command was applied.', reason: 'target-conversation-changed' };

    const enabled = message?.enabled === true;
    const source = enabled ? (message?.resumeExistingRun === true ? 'operator-resume' : 'operator') : 'operator-pause';
    try {
      if (target.id) {
        await setEnrollment(target, enabled, source, { expectedRevision: message?.expectedRevision });
        if (enabled) {
          try {
            const result = await chrome.tabs.sendMessage(target.tab.id, { type: 'CHATGPT_MONITOR_QUERY' });
            const snapshot = result?.snapshot || result;
            if (snapshot?.conversationId) await handleSnapshot(snapshot, { tab: target.tab, documentId: snapshot.documentId || '' });
          } catch {}
          if (message?.resumeExistingRun === true) {
            try { await globalThis.__chatgptNotifierBoundedRecovery?.resumeConversation?.(target.id); } catch {}
          }
        }
      } else {
        await setProvisional(target.tab.id, enabled, source, message?.expectedRevision);
      }
      const overview = await monitorOverview(target);
      publishAutomationOverview(target, overview).catch(() => {});
      return { ok: true, requestId: String(message?.requestId || ''), ...overview };
    } catch (error) {
      const overview = await monitorOverview(target).catch(() => null);
      return {
        ok: false,
        error: String(error?.message || error),
        reason: String(error?.code || 'automation-state-write-failed'),
        requestId: String(message?.requestId || ''),
        ...(overview || {})
      };
    }
  }

  async function setActiveAutomation(message) {
    return await setAutomationForTarget(message, await activeChatTarget());
  }

  async function setSenderAutomation(message, sender) {
    return await setAutomationForTarget(message, senderChatTarget(sender));
  }

  async function noteTabClosedQuiet(tabId) {
    const conversationId = tabConversations.get(tabId) || '';
    const provisional = await getProvisional(tabId);
    if (provisional) await deleteRecord(PROFILE_STORE, provisionalKey(tabId));
    if (!conversationId) return;
    const enrollment = await getEnrollment(conversationId);
    if (enrollment?.enabled !== true) return;
    const run = await latestRunForConversation(conversationId);
    if (!run || run.state === 'coded-terminal') return;

    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); } catch {}
    const replacement = tabs.find((tab) => Number.isInteger(tab.id)
      && tab.id !== tabId
      && tab.discarded !== true
      && tab.frozen !== true
      && conversationFromUrl(tab.url || '')?.id === conversationId);
    if (replacement) {
      await putRecord(RUN_STORE, {
        ...run,
        ownerTabId: replacement.id,
        ownerDocumentId: '',
        state: 'observing',
        reason: 'owner-transferred-after-close',
        updatedAt: Date.now()
      });
      try { await chrome.scripting.executeScript({ target: { tabId: replacement.id }, files: ['status-code.js', 'status-policy.js', 'monitor-script.js'] }); } catch {}
      return;
    }

    await putRecord(RUN_STORE, {
      ...run,
      ownerTabId: null,
      ownerDocumentId: '',
      state: 'detached',
      reason: 'owner-tab-closed-quiet',
      updatedAt: Date.now()
    });
    const attentionRecords = await getAll(ATTENTION_STORE);
    for (const record of attentionRecords) {
      if (record.runKey === run.runKey && closeDerivedReason(record.reason) && !record.acknowledged) await acknowledgeAttention(record.attentionId);
    }
  }

  chrome.webRequest.onBeforeRequest.addListener((details) => {
    if (!isAnswerStreamRequest(details)) return;
    const requestKey = String(details.requestId || '');
    const requestStartedAt = Date.now();
    requestTabs.set(requestKey, { tabId: details.tabId, requestStartedAt });
    armProvisionalForRequest(details.tabId, details.requestId).catch(() => {});
    sendRequestPhase(details.tabId, 'started', details, requestStartedAt).catch(() => {});
  }, REQUEST_FILTER);

  chrome.webRequest.onCompleted.addListener((details) => {
    if (!isAnswerStreamRequest(details)) return;
    const requestKey = String(details.requestId || '');
    const tracked = requestTabs.get(requestKey) || null;
    requestTabs.delete(requestKey);
    const requestStartedAt = Math.max(0, Number(tracked?.requestStartedAt || 0))
      || Math.max(0, Number(details?.timeStamp || 0))
      || Date.now();
    sendRequestPhase(details.tabId, 'completed', details, requestStartedAt).catch(() => {});
  }, REQUEST_FILTER);

  chrome.webRequest.onErrorOccurred.addListener((details) => {
    if (!isAnswerStreamRequest(details)) return;
    const requestKey = String(details.requestId || '');
    const tracked = requestTabs.get(requestKey) || null;
    requestTabs.delete(requestKey);
    const requestStartedAt = Math.max(0, Number(tracked?.requestStartedAt || 0))
      || Math.max(0, Number(details?.timeStamp || 0))
      || Date.now();
    sendRequestPhase(details.tabId, 'error', details, requestStartedAt).catch(() => {});
  }, REQUEST_FILTER);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'CHATGPT_MONITOR_STATE') {
      handleSnapshot(message.snapshot, sender).then((run) => sendResponse?.({ ok: true, monitored: Boolean(run), runKey: run?.runKey || '' }))
        .catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'GET_BUILD_AUTOMATION_OVERVIEW' || message?.type === 'GET_MONITOR_OVERVIEW') {
      monitorOverview().then((overview) => sendResponse?.({ ok: true, ...overview }))
        .catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'GET_BUILD_AUTOMATION_OVERVIEW_FOR_SENDER') {
      const target = senderChatTarget(sender);
      if (!target) {
        sendResponse?.({ ok: false, error: 'This control is not attached to a ChatGPT tab.' });
        return false;
      }
      monitorOverview(target).then((overview) => sendResponse?.({ ok: true, ...overview }))
        .catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'SET_BUILD_AUTOMATION_STATE') {
      setActiveAutomation(message).then((result) => sendResponse?.(result))
        .catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'SET_BUILD_AUTOMATION_STATE_FOR_SENDER') {
      setSenderAutomation(message, sender).then((result) => sendResponse?.(result))
        .catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'RESET_CODE_WATCHDOG_BUDGET_FOR_SENDER') {
      resetSenderCodeWatchdogBudget(message, sender).then((result) => sendResponse?.(result))
        .catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error), requestId: String(message?.requestId || '') }));
      return true;
    }

    if (message?.type === 'SET_ACTIVE_CHAT_MONITORING') {
      setActiveAutomation({
        enabled: message.enabled === true,
        expectedRevision: message.expectedRevision,
        requestId: message.requestId,
        resumeExistingRun: false
      }).then((result) => sendResponse?.({ ...result, monitoring: result.monitoring === true }))
        .catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'ACK_RECOVERY_ATTENTION') {
      acknowledgeAttention(message.attentionId).then((acknowledged) => sendResponse?.({ ok: acknowledged }))
        .catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    return false;
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    const conversationId = conversationIdFromCodeWatchdogAlarm(alarm?.name);
    if (!conversationId) return;
    handleCodeWatchdogAlarm(conversationId).catch(() => {});
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const identity = conversationFromUrl(changeInfo.url || tab?.url || '');
    if (identity) tabConversations.set(tabId, identity.id);
    if (changeInfo.discarded === true || changeInfo.frozen === true) {
      const conversationId = identity?.id || tabConversations.get(tabId) || '';
      if (conversationId) {
        (async () => {
          if ((await getEnrollment(conversationId))?.enabled !== true) return;
          const run = await latestRunForConversation(conversationId);
          if (run && run.state !== 'coded-terminal') await ensureAttention(run, 'page-unobservable');
        })().catch(() => {});
      }
    }
    if (identity) {
      (async () => {
        const provisional = await getProvisional(tabId);
        if (!provisional) return;
        if (Number(provisional.armedAt || 0) <= 0) {
          return;
        }
        await setEnrollment(identity, provisional.enabled === true, provisional.userPaused ? 'operator-pause' : 'operator-provisional');
        await deleteRecord(PROFILE_STORE, provisionalKey(tabId));
        publishAutomationOverview({ tab, id: identity.id, url: identity.url }).catch(() => {});
      })().catch(() => {});
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    noteTabClosedQuiet(tabId).catch(() => {});
    tabConversations.delete(tabId);
  });

  async function restoreCodeWatchdogAlarms(now = Date.now()) {
    const records = (await getAll(PROFILE_STORE))
      .filter((record) => String(record?.key || '').startsWith(CODE_WATCHDOG_RECORD_PREFIX));
    for (const record of records) {
      const conversationId = String(record?.conversationId || '');
      if (!conversationId || record.stopped === true) continue;
      const enrollment = await getEnrollment(conversationId);
      if (enrollment?.enabled !== true || enrollment?.userPaused === true) continue;

      const deadlineAt = Math.max(0, Number(record.deadlineAt || 0));
      const retryAt = Math.max(0, Number(record.retryAt || 0));
      let when = 0;
      if (deadlineAt > 0) when = deadlineAt <= now ? now + 1000 : deadlineAt;
      else if (retryAt > 0) when = retryAt <= now ? now + 1000 : retryAt;
      if (when <= 0) continue;
      try { chrome.alarms.create(codeWatchdogAlarmName(conversationId), { when }); } catch {}
    }
  }

  async function pruneOldRuns(now = Date.now()) {
    const records = await getAll(RUN_STORE);
    for (const record of records) {
      if (Number(record.createdAt || 0) <= 0 || now - Number(record.createdAt || 0) <= MAX_RUN_AGE_MS) continue;
      await deleteRecord(RUN_STORE, record.runKey);
    }
  }

  globalThis.__chatgptNotifierMonitorBackground = Object.freeze({
    version: 5,
    automationSchemaVersion: AUTOMATION_SCHEMA_VERSION,
    getEnrollment,
    setEnrollment,
    latestRunForConversation,
    monitorOverview,
    setActiveAutomation,
    setSenderAutomation,
    codeWatchdogBudgetReset,
    resetCodeWatchdogBudgetForTarget,
    resetSenderCodeWatchdogBudget,
    chatTargetFromTab,
    publishAutomationOverview,
    ensureAttention,
    raiseAttention: ensureAttention,
    resolveAttentionForRun,
    acknowledgeAttention,
    readProfileState,
    readCodeWatchdog,
    reconcileCodeWatchdog,
    parkCodeWatchdogForTerminalStatus,
    handleCodeWatchdogAlarm,
    ensureHotPageRuntime,
    queryHotPageRuntime,
    updateRun,
    flushAttention
  });

  injectMonitorIntoExistingTabs().catch(() => {});
  restoreCodeWatchdogAlarms().catch(() => {});
  pruneOldRuns().catch(() => {});
  flushAttention().catch(() => {});
})();