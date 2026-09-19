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
    if (!isEnabled) await clearCodeWatchdog(identity.id);
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
      promptRevision: String(snapshot.promptRevision || ''),
      assistantKey: String(snapshot.assistantKey || ''),
      assistantRevision: String(snapshot.assistantRevision || ''),
      statusCode: String(snapshot.statusCode || ''),
      workStartSignal: snapshot.workStartSignal === true,
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
      updatedAt: Date.now()
    };
    await putRecord(PROFILE_STORE, record);
    return record;
  }

  async function scheduleCodeWatchdog(recordValue, when) {
    const record = recordValue || null;
    if (!record?.conversationId || record.stopped === true) return record;
    const deadlineAt = Math.max(Date.now() + 1000, Number(when || 0));
    const updated = await putCodeWatchdog(record.conversationId, { ...record, deadlineAt });
    try { chrome.alarms.create(codeWatchdogAlarmName(record.conversationId), { when: deadlineAt }); } catch {}
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
      deadlineAt: 0
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
      deadlineAt: 0
    });
  }

  async function reconcileCodeWatchdog(clean, sender) {
    const conversationId = String(clean?.conversationId || '');
    if (!conversationId) return null;

    const statusCode = String(clean?.statusCode || '');
    if (globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(statusCode)) {
      if (globalThis.ChatGPTNotifierContinuationPolicy?.isAutoContinueStatusCode?.(statusCode) === true) {
        return await resetCodeWatchdogForIncomplete(clean, sender, await readCodeWatchdog(conversationId));
      }
      await clearCodeWatchdog(conversationId);
      return null;
    }

    const requestStartedAt = Math.max(0, Number(clean?.requestStartedAt || 0));
    if (!requestStartedAt) return await readCodeWatchdog(conversationId);

    let current = await readCodeWatchdog(conversationId);
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
      const sameRequest = requestStartedAt === Number(current.lastRequestStartedAt || 0);
      const followsAutomaticSend = (current.lastAutomaticPromptKey && String(clean.promptKey || '') === String(current.lastAutomaticPromptKey))
        || (Number(current.lastAutomaticSentAt || 0) > 0
          && Math.abs(requestStartedAt - Number(current.lastAutomaticSentAt || 0)) <= CODE_WATCHDOG_AUTOMATIC_REQUEST_WINDOW_MS);
      if (sameRequest || followsAutomaticSend) {
        if (!sameRequest) {
          current = await putCodeWatchdog(conversationId, {
            ...current,
            lastRequestStartedAt: requestStartedAt,
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
      lastStatusCode: '',
      deadlineAt: requestStartedAt + CODE_WATCHDOG_DELAY_MS
    });
    return await scheduleCodeWatchdog(record, requestStartedAt + CODE_WATCHDOG_DELAY_MS);
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
    if (snapshot.manualStopped === true) return { eligible: false, reason: 'manual-stop' };
    if (snapshot.authRequired === true) return { eligible: false, reason: 'auth-required' };
    if (snapshot.approvalRequired === true) return { eligible: false, reason: 'approval-required' };
    if (snapshot.rateLimited === true) return { eligible: false, reason: 'rate-limited' };
    if (snapshot.hasDraft === true) return { eligible: false, reason: 'draft-present' };
    if (snapshot.hasUpload === true) return { eligible: false, reason: 'upload-present' };
    if (snapshot.stopGenerating === true) return { eligible: false, reason: 'generation-active' };
    if (snapshot.toolActivity === true) return { eligible: false, reason: 'tool-activity' };
    if (snapshot.applicationStateIdentityMatched === false) return { eligible: false, reason: 'application-state-identity-mismatch' };

    const requestPhase = String(snapshot.requestPhase || '');
    if (!['completed', 'error'].includes(requestPhase)) {
      return { eligible: false, reason: 'request-not-settled' };
    }

    if (String(snapshot.assistantKey || '')) {
      return snapshot.stableTerminal === true
        ? { eligible: true, reason: 'stable-terminal-no-code' }
        : { eligible: false, reason: 'assistant-not-stable' };
    }

    return Number(snapshot.silentIdleConfirmations || 0) >= 2
      ? { eligible: true, reason: 'silent-stop-confirmed' }
      : { eligible: false, reason: 'silent-stop-unconfirmed' };
  }

  async function handleCodeWatchdogAlarm(conversationId) {
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
      await scheduleCodeWatchdog(record, Date.now() + CODE_WATCHDOG_RETRY_MS);
      return;
    }

    const live = await ensureCodeWatchdogPageRuntime(tab.id);
    if (!live || String(live.conversationId || '') !== conversationId) {
      await scheduleCodeWatchdog(record, Date.now() + CODE_WATCHDOG_RETRY_MS);
      return;
    }

    const statusCode = String(live.statusCode || '');
    if (globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(statusCode)) {
      if (globalThis.ChatGPTNotifierContinuationPolicy?.isAutoContinueStatusCode?.(statusCode) !== true) {
        await clearCodeWatchdog(conversationId);
        return;
      }
      const result = await sendCodeWatchdogContinuation(tab.id, conversationId, String(live.promptKey || ''));
      record = await resetCodeWatchdogForIncomplete(live, { tab }, record, result?.ok === true ? Date.now() : 0, result?.continuationUserKey || '');
      if (result?.ok !== true) await scheduleCodeWatchdog(record, Date.now() + CODE_WATCHDOG_RETRY_MS);
      return;
    }

    const liveRequestStartedAt = Math.max(0, Number(live.requestStartedAt || 0));
    if (liveRequestStartedAt && liveRequestStartedAt !== Number(record.lastRequestStartedAt || 0)) {
      await reconcileCodeWatchdog(live, { tab });
      const refreshed = await readCodeWatchdog(conversationId);
      if (!refreshed || refreshed.stopped === true || Number(refreshed.deadlineAt || 0) > Date.now() + 1000) return;
      record = refreshed;
    }

    const noCodeEligibility = codeWatchdogNoCodeEligibility(live);
    if (noCodeEligibility.eligible !== true) {
      await scheduleCodeWatchdog(record, Date.now() + CODE_WATCHDOG_RETRY_MS);
      return;
    }

    const result = await sendCodeWatchdogContinuation(tab.id, conversationId, String(live.promptKey || ''));
    const racedStatusCode = String(result?.statusCode || '');
    if (globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(racedStatusCode)) {
      if (globalThis.ChatGPTNotifierContinuationPolicy?.isAutoContinueStatusCode?.(racedStatusCode) === true) {
        record = await resetCodeWatchdogForIncomplete(
          { ...live, statusCode: racedStatusCode },
          { tab },
          record,
          result?.ok === true ? Date.now() : 0,
          result?.continuationUserKey || ''
        );
        if (result?.ok !== true) await scheduleCodeWatchdog(record, Date.now() + CODE_WATCHDOG_RETRY_MS);
      } else {
        await clearCodeWatchdog(conversationId);
      }
      return;
    }

    if (result?.ok !== true) {
      await scheduleCodeWatchdog(record, Date.now() + CODE_WATCHDOG_RETRY_MS);
      return;
    }

    const sentAt = Date.now();
    const nextCount = Math.max(0, Number(record.sendCount || 0)) + 1;
    record = await putCodeWatchdog(conversationId, {
      ...record,
      ownerTabId: tab.id,
      sendCount: nextCount,
      lastAutomaticSentAt: sentAt,
      lastAutomaticPromptKey: String(result?.continuationUserKey || ''),
      waitingForRequestStart: false,
      deadlineAt: 0
    });
    if (nextCount >= CODE_WATCHDOG_MAX_SENDS) {
      await parkCodeWatchdog(record, 'retry-cap-reached');
      return;
    }
    await scheduleCodeWatchdog(record, sentAt + CODE_WATCHDOG_DELAY_MS);
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
      await deleteRecord(PROFILE_STORE, provisionalKey(tabId));
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
    const recognizedScope = freshRequestEvidence && (clean.workStartSignal === true || statusIsValid);
    if (recognizedScope && enrollment?.enabled !== true && enrollment?.userPaused !== true) {
      enrollment = await setEnrollment(
        { id: clean.conversationId, url: clean.conversationUrl },
        true,
        clean.workStartSignal === true ? 'work-start-signal' : 'coded-turn'
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
    await reconcileCodeWatchdog(clean, sender);
    if (enrollmentChanged && senderTarget) publishAutomationOverview(senderTarget).catch(() => {});
    return run;
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
      helperConnected
    };
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
    requestTabs.set(String(details.requestId || ''), details.tabId);
    armProvisionalForRequest(details.tabId, details.requestId).catch(() => {});
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
          await deleteRecord(PROFILE_STORE, provisionalKey(tabId));
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

  async function pruneOldRuns(now = Date.now()) {
    const records = await getAll(RUN_STORE);
    for (const record of records) {
      if (Number(record.createdAt || 0) <= 0 || now - Number(record.createdAt || 0) <= MAX_RUN_AGE_MS) continue;
      await deleteRecord(RUN_STORE, record.runKey);
    }
  }

  globalThis.__chatgptNotifierMonitorBackground = Object.freeze({
    version: 4,
    automationSchemaVersion: AUTOMATION_SCHEMA_VERSION,
    getEnrollment,
    setEnrollment,
    latestRunForConversation,
    monitorOverview,
    setActiveAutomation,
    setSenderAutomation,
    chatTargetFromTab,
    publishAutomationOverview,
    ensureAttention,
    raiseAttention: ensureAttention,
    resolveAttentionForRun,
    acknowledgeAttention,
    readProfileState,
    readCodeWatchdog,
    reconcileCodeWatchdog,
    handleCodeWatchdogAlarm,
    updateRun,
    flushAttention
  });

  injectMonitorIntoExistingTabs().catch(() => {});
  pruneOldRuns().catch(() => {});
  flushAttention().catch(() => {});
})();