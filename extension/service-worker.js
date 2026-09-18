'use strict';

const BRIDGE_URL = 'ws://127.0.0.1:38473/bridge';
const RESPONSE_PREVIEW_MAX_CHARS = 300;
const STATUS_QUERY_TIMEOUT_MS = 30000;
const CONTINUATION_REQUEST_TIMEOUT_MS = 12000;
const CHATGPT_REQUEST_FILTER = {
  urls: [
    'https://chatgpt.com/backend-api/f/conversation*',
    'https://chatgpt.com/backend-api/conversation*'
  ]
};

let bridgeSocket = null;
let reconnectTimer = null;
let reconnectDelayMs = 750;
let keepAliveTimer = null;
const outboundQueue = [];
const nativeRequestWaiters = new Map();
const continuationRequestWatchers = new Map();
const activeTurnKeys = new Set();
const activeToastClicks = new Set();
let outboxFlushPromise = null;
let reconcilePromise = null;

function coordinator() {
  return globalThis.__chatgptNotifierCoordinator || null;
}

function queueNativeMessage(message) {
  outboundQueue.push(message);
  while (outboundQueue.length > 100) outboundQueue.shift();
}

function flushNativeQueue() {
  if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) return;
  while (outboundQueue.length > 0) {
    const message = outboundQueue.shift();
    try {
      bridgeSocket.send(JSON.stringify(message));
    } catch {
      outboundQueue.unshift(message);
      try { bridgeSocket.close(); } catch {}
      return;
    }
  }
}

function settleNativeRequest(message) {
  const requestId = String(message?.requestId || '');
  if (!requestId) return false;
  const waiter = nativeRequestWaiters.get(requestId);
  if (!waiter || !waiter.expectedTypes.has(String(message.type || ''))) return false;
  nativeRequestWaiters.delete(requestId);
  clearTimeout(waiter.timeoutId);
  waiter.resolve(message);
  return true;
}

function failPendingNativeRequests() {
  for (const [requestId, waiter] of nativeRequestWaiters) {
    nativeRequestWaiters.delete(requestId);
    clearTimeout(waiter.timeoutId);
    waiter.resolve(null);
  }
}

function stopKeepAlive() {
  if (keepAliveTimer !== null) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function publishRuntimeIdentity(status) {
  try { globalThis.__chatgptNotifierRuntimeIdentity?.publish?.(status); } catch {}
}

function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) return;
    publishRuntimeIdentity('worker-alive');
    try { bridgeSocket.send(JSON.stringify({ type: 'ping' })); } catch {}
  }, 20000);
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(30000, reconnectDelayMs * 2);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNativeHost();
  }, delay);
}

function connectNativeHost() {
  if (bridgeSocket && (bridgeSocket.readyState === WebSocket.OPEN || bridgeSocket.readyState === WebSocket.CONNECTING)) {
    return bridgeSocket;
  }

  try {
    const socket = new WebSocket(BRIDGE_URL);
    bridgeSocket = socket;

    socket.onopen = () => {
      if (bridgeSocket !== socket) return;
      reconnectDelayMs = 750;
      startKeepAlive();
      flushNativeQueue();
      publishRuntimeIdentity('worker-connected');
      flushNotificationOutbox().catch((error) => console.warn('Durable notification replay failed', error));
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data || ''));
        handleNativeMessage(message).catch((error) => console.error('Local bridge message failed', error));
      } catch (error) {
        console.warn('Ignored malformed localhost bridge message', error);
      }
    };

    socket.onerror = () => {};
    socket.onclose = () => {
      if (bridgeSocket === socket) bridgeSocket = null;
      stopKeepAlive();
      failPendingNativeRequests();
      scheduleReconnect();
    };
    return socket;
  } catch {
    bridgeSocket = null;
    scheduleReconnect();
    return null;
  }
}

function sendNative(message, queueIfDisconnected = true) {
  const socket = connectNativeHost();
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if (queueIfDisconnected) queueNativeMessage(message);
    return false;
  }
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    if (queueIfDisconnected) queueNativeMessage(message);
    try { socket.close(); } catch {}
    return false;
  }
}

function sendNativeRequest(message, expectedTypes, timeoutMs, options = {}) {
  const requestId = crypto.randomUUID();
  const queueIfDisconnected = options.queueIfDisconnected !== false;
  if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) connectNativeHost();
  if ((!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) && !queueIfDisconnected) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      nativeRequestWaiters.delete(requestId);
      resolve(null);
    }, timeoutMs);
    nativeRequestWaiters.set(requestId, {
      resolve,
      timeoutId,
      expectedTypes: new Set(expectedTypes)
    });
    const sent = sendNative({ ...message, requestId }, queueIfDisconnected);
    if (!sent && !queueIfDisconnected) {
      nativeRequestWaiters.delete(requestId);
      clearTimeout(timeoutId);
      resolve(null);
    }
  });
}

async function pingNativeHost(timeoutMs = 3000) {
  return await sendNativeRequest({ type: 'ping' }, ['pong'], timeoutMs);
}

function parseVersion(value) {
  const parts = String(value || '').split('.');
  if (parts.length < 2 || parts.length > 4) return null;
  const numbers = parts.map((part) => Number.parseInt(part, 10));
  if (numbers.some((part) => !Number.isInteger(part) || part < 0)) return null;
  return numbers;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const av = a[index] || 0;
    const bv = b[index] || 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

function maybeReloadForInstalledVersion(installedVersion) {
  const currentVersion = chrome.runtime.getManifest().version;
  const comparison = compareVersions(installedVersion, currentVersion);
  if (comparison !== null && comparison !== 0) {
    setTimeout(() => chrome.runtime.reload(), 250);
    return true;
  }
  return false;
}

function conversationFromUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    if (url.hostname !== 'chatgpt.com' && url.hostname !== 'www.chatgpt.com') return null;
    const segments = url.pathname.split('/').filter(Boolean);
    for (let index = segments.length - 2; index >= 0; index -= 1) {
      if (segments[index] !== 'c') continue;
      const id = decodeURIComponent(segments[index + 1] || '').trim();
      if (!id) continue;
      return { id, url: `https://chatgpt.com${url.pathname.replace(/\/+$/, '')}` };
    }
  } catch {}
  return null;
}

function fullTabTitle(sender, message) {
  const title = String(sender?.tab?.title || message?.sessionTitle || 'ChatGPT').trim();
  return title || 'ChatGPT';
}

function truncateResponse(text, maxChars = RESPONSE_PREVIEW_MAX_CHARS) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Response finished.';
  if (normalized.length <= maxChars) return normalized;
  const slice = normalized.slice(0, Math.max(1, maxChars - 3));
  const lastSpace = slice.lastIndexOf(' ');
  const safeCut = lastSpace >= Math.floor(maxChars * 0.7) ? slice.slice(0, lastSpace) : slice;
  return `${safeCut.trimEnd()}...`;
}

function normalizeResponseText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
}

function suffix(value) {
  const text = String(value || '');
  return text ? text.slice(-8) : '';
}

function emitClickDiagnostic(status, context = {}) {
  const diagnostic = {
    source: 'toast-click',
    status: String(status || ''),
    observedAt: new Date().toISOString(),
    extensionVersion: String(chrome.runtime.getManifest().version || ''),
    correlationId: String(context.correlationId || ''),
    conversationSuffix: suffix(context.conversationId),
    notificationSuffix: suffix(context.notificationId),
    reason: String(context.reason || '')
  };
  if (Number.isInteger(context.tabId)) diagnostic.tabId = context.tabId;
  sendNative({ type: 'diagnostics.event', diagnostic });
}

async function currentConversationForTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return conversationFromUrl(tab?.url || '');
  } catch {
    return null;
  }
}

async function resolveConversationIdentity(initialUrl, tabId) {
  let identity = conversationFromUrl(initialUrl);
  if (identity) return identity;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(250);
    identity = await currentConversationForTab(tabId);
    if (identity) return identity;
  }
  return null;
}

async function foregroundChromeWindow(windowId) {
  if (typeof windowId !== 'number') return false;
  try {
    const windowInfo = await chrome.windows.get(windowId);
    if (windowInfo.state === 'minimized') await chrome.windows.update(windowId, { state: 'normal' });
    await chrome.windows.update(windowId, { focused: true });
    return true;
  } catch {
    return false;
  }
}

async function resolveClickTarget(conversationId, preferredTabId = null) {
  if (Number.isInteger(preferredTabId)) {
    try {
      const exact = await chrome.tabs.get(preferredTabId);
      if (conversationFromUrl(exact?.url || '')?.id === conversationId) {
        return { tab: exact, reason: 'exact-target' };
      }
    } catch {}
  }

  try {
    const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    const matches = tabs.filter((tab) => Number.isInteger(tab?.id) && conversationFromUrl(tab?.url || '')?.id === conversationId);
    if (matches.length === 1) return { tab: matches[0], reason: 'unique-conversation-target' };
    if (matches.length > 1) return { tab: null, reason: 'ambiguous-conversation-target' };
  } catch {
    return { tab: null, reason: 'tab-query-failed' };
  }
  return { tab: null, reason: 'conversation-target-missing' };
}

async function foregroundChromeWindow(windowId) {
  if (typeof windowId !== 'number') return false;
  try {
    const windowInfo = await chrome.windows.get(windowId);
    if (windowInfo.state === 'minimized') await chrome.windows.update(windowId, { state: 'normal' });
    await chrome.windows.update(windowId, { focused: true });
    return true;
  } catch {
    return false;
  }
}

async function focusOrOpenConversation(conversationId, conversationUrl, clickContext = {}) {
  try {
    const preferredTabId = Number.isInteger(clickContext?.targetTabId) ? clickContext.targetTabId : null;
    const resolved = await resolveClickTarget(conversationId, preferredTabId);
    if (resolved.reason === 'ambiguous-conversation-target') {
      emitClickDiagnostic('click-target-ambiguous', { ...clickContext, conversationId, reason: resolved.reason });
      return { requested: false, presented: false, presentationState: 'ambiguous', reason: resolved.reason, targetTabId: null };
    }

    let target = resolved.tab;
    let created = false;
    if (!target) {
      const safeIdentity = conversationFromUrl(conversationUrl);
      if (!safeIdentity || safeIdentity.id !== conversationId) {
        emitClickDiagnostic('click-target-invalid', { ...clickContext, conversationId, reason: 'conversation-url-invalid' });
        return { requested: false, presented: false, presentationState: 'invalid', reason: 'conversation-url-invalid', targetTabId: null };
      }
      emitClickDiagnostic('selected-new-tab', { ...clickContext, conversationId });
      target = await chrome.tabs.create({ url: safeIdentity.url, active: true });
      created = true;
      emitClickDiagnostic('chrome-tab-created', { ...clickContext, conversationId, tabId: target?.id });
    } else {
      emitClickDiagnostic('selected-existing-tab', { ...clickContext, conversationId, tabId: target.id, reason: resolved.reason });
      await chrome.tabs.update(target.id, { active: true });
      emitClickDiagnostic('chrome-tab-activated', { ...clickContext, conversationId, tabId: target.id });
    }

    const targetTabId = Number.isInteger(target?.id) ? target.id : null;
    const targetWindowId = Number.isInteger(target?.windowId) ? target.windowId : null;
    const focusRequested = targetWindowId !== null ? await foregroundChromeWindow(targetWindowId) : false;
    emitClickDiagnostic(focusRequested ? 'chrome-window-focus-requested' : 'chrome-window-focus-failed', {
      ...clickContext,
      conversationId,
      tabId: targetTabId,
      reason: focusRequested ? '' : 'chrome-api-focus-failed'
    });
    return {
      requested: true,
      presented: false,
      presentationState: 'requested',
      reason: focusRequested ? 'focus-requested' : 'focus-request-failed',
      targetTabId,
      targetWindowId,
      created
    };
  } catch {
    emitClickDiagnostic('click-navigation-error', { ...clickContext, conversationId, reason: 'chrome-api-navigation-failed' });
    return { requested: false, presented: false, presentationState: 'error', reason: 'chrome-api-navigation-failed', targetTabId: null };
  }
}

async function injectScriptsIntoExistingChatgptTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); } catch { return; }
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    if (tab.discarded === true || tab.frozen === true) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['attachment-script.js', 'content-script.js', 'persistence-script.js', 'status-code.js', 'status-policy.js', 'monitor-script.js', 'status-script.js']
      });
    } catch {}
  }
}

function normalizePathname(url) {
  try { return new URL(url).pathname.replace(/\/+$/, ''); } catch { return ''; }
}

function isAnswerStreamRequest(details) {
  if (details.tabId < 0 || details.method !== 'POST') return false;
  const path = normalizePathname(details.url);
  return path === '/backend-api/f/conversation' || path === '/backend-api/conversation';
}

async function signalConversationRequestCompleted(tabId) {
  const message = { type: 'CHATGPT_CONVERSATION_REQUEST_COMPLETED' };
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return;
  } catch {}
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['attachment-script.js', 'content-script.js'] });
    await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    console.warn('Prompt-Bound Alert: could not arm tab completion watcher', error);
  }
}

function startContinuationRequestWatch(tabId, conversationId, timeoutMs = CONTINUATION_REQUEST_TIMEOUT_MS) {
  const existing = continuationRequestWatchers.get(tabId);
  if (existing) existing.finish({ accepted: false, reason: 'superseded-request-watch' });

  let settled = false;
  let requestId = '';
  let timeoutId = null;
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  const watcher = {
    tabId,
    conversationId,
    get requestId() { return requestId; },
    setRequestId(value) { if (!requestId) requestId = String(value || ''); },
    finish(result) {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
      if (continuationRequestWatchers.get(tabId) === watcher) continuationRequestWatchers.delete(tabId);
      resolvePromise({ requestId, ...(result || {}) });
    },
    promise
  };
  timeoutId = setTimeout(() => watcher.finish({ accepted: false, reason: 'request-evidence-timeout' }), timeoutMs);
  continuationRequestWatchers.set(tabId, watcher);
  return watcher;
}

function cancelContinuationRequestWatch(watcher, reason) {
  if (!watcher) return;
  watcher.finish({ accepted: false, reason: reason || 'request-watch-cancelled' });
}

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (!isAnswerStreamRequest(details)) return;
  const watcher = continuationRequestWatchers.get(details.tabId);
  if (!watcher || watcher.requestId) return;
  watcher.setRequestId(details.requestId);
}, CHATGPT_REQUEST_FILTER);

chrome.webRequest.onHeadersReceived.addListener((details) => {
  if (!isAnswerStreamRequest(details)) return;
  const watcher = continuationRequestWatchers.get(details.tabId);
  if (!watcher || !watcher.requestId || watcher.requestId !== String(details.requestId || '')) return;
  const accepted = details.statusCode >= 200 && details.statusCode < 300;
  watcher.finish({ accepted, statusCode: details.statusCode, reason: accepted ? 'request-accepted' : 'request-rejected' });
}, CHATGPT_REQUEST_FILTER);

chrome.webRequest.onErrorOccurred.addListener((details) => {
  if (!isAnswerStreamRequest(details)) return;
  const watcher = continuationRequestWatchers.get(details.tabId);
  if (!watcher || !watcher.requestId || watcher.requestId !== String(details.requestId || '')) return;
  watcher.finish({ accepted: false, reason: 'request-error', error: String(details.error || '') });
}, CHATGPT_REQUEST_FILTER);

chrome.webRequest.onCompleted.addListener((details) => {
  if (!isAnswerStreamRequest(details)) return;
  const watcher = continuationRequestWatchers.get(details.tabId);
  if (watcher && watcher.requestId === String(details.requestId || '')) {
    const accepted = details.statusCode >= 200 && details.statusCode < 300;
    watcher.finish({ accepted, statusCode: details.statusCode, reason: accepted ? 'request-completed' : 'request-rejected' });
  }
  if (details.statusCode < 200 || details.statusCode >= 300) return;
  signalConversationRequestCompleted(details.tabId).catch(() => {});
}, CHATGPT_REQUEST_FILTER);

function messageTargetOptions(documentId) {
  return documentId ? { documentId: String(documentId) } : undefined;
}

async function sendTabMessage(tabId, message, documentId = '') {
  const options = messageTargetOptions(documentId);
  return options ? await chrome.tabs.sendMessage(tabId, message, options) : await chrome.tabs.sendMessage(tabId, message);
}

async function queryTerminalStatus(tabId, senderDocumentId = '', timeoutMs = STATUS_QUERY_TIMEOUT_MS) {
  const message = { type: 'CHATGPT_STATUS_CODE_QUERY', timeoutMs };
  try { return await sendTabMessage(tabId, message, senderDocumentId); } catch {}

  try {
    const target = senderDocumentId ? { tabId, documentIds: [senderDocumentId] } : { tabId };
    await chrome.scripting.executeScript({ target, files: ['status-code.js', 'status-policy.js', 'status-script.js'] });
    return await sendTabMessage(tabId, message, senderDocumentId);
  } catch {
    return null;
  }
}

function boundedLocalObservation(promise, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, Math.max(1, Number(timeoutMs || 1500)));
    Promise.resolve(promise).then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value || null);
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function queryImmediateTerminalStatus(tabId, senderDocumentId = '') {
  const message = { type: 'CHATGPT_STATUS_CODE_QUERY', timeoutMs: 1 };
  const ask = () => boundedLocalObservation(sendTabMessage(tabId, message, senderDocumentId), 1500);
  let status = await ask();
  if (status?.statusCode) return status;
  try {
    const target = senderDocumentId ? { tabId, documentIds: [senderDocumentId] } : { tabId };
    await boundedLocalObservation(
      chrome.scripting.executeScript({ target, files: ['status-code.js', 'status-policy.js', 'status-script.js'] }),
      1500
    );
  } catch {}
  status = await ask();
  return status?.statusCode ? status : null;
}

async function requestContinuation(tabId, senderDocumentId, expected) {
  try {
    return await sendTabMessage(tabId, { type: 'CHATGPT_CONTINUE_COMMAND', expected }, senderDocumentId);
  } catch {
    return null;
  }
}

async function dismissConversationForSender(message, sender) {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') return false;
  const identity = await resolveConversationIdentity(message?.conversationUrl || sender.tab?.url || '', tabId);
  if (!identity) return false;
  sendNative({ type: 'toast.dismissConversation', conversationId: identity.id });
  return true;
}

function notificationFromTurnRecord(record) {
  if (!record?.notificationId || !record?.conversationId || !record?.conversationUrl) return null;
  return {
    id: record.notificationId,
    conversationId: record.conversationId,
    conversationUrl: record.conversationUrl,
    title: record.notificationTitle || 'ChatGPT',
    preview: record.notificationPreview || truncateResponse(record.responseBody || record.responseText),
    statusCode: record.statusCode || '',
    targetTabId: Number.isInteger(record.ownerTabId) ? record.ownerTabId : null,
    completedAt: new Date(Number(record.createdAt || Date.now())).toISOString()
  };
}

async function rememberNotificationHistory(notification, fingerprint) {
  try {
    await globalThis.__chatgptNotifierHistory?.rememberEligibleCompletion?.({
      historyId: notification.id,
      fingerprint: String(fingerprint || ''),
      ...notification
    });
  } catch (error) {
    console.warn('Could not save eligible completion history', error);
  }
}

async function finalizeRecovery(conversationId) {
  try {
    await globalThis.__chatgptNotifierRecovery?.finalizeConversation?.(conversationId);
  } catch (error) {
    console.warn('Could not finalize recovery state', error);
  }
}

async function queueDurableNotification(turnRecord, reason = '') {
  const state = coordinator();
  if (!state) throw new Error('Notifier coordinator is unavailable.');
  const notification = notificationFromTurnRecord(turnRecord);
  if (!notification) throw new Error('Turn record cannot be converted to a notification.');
  if (reason) await state.updateTurn(turnRecord.turnKey, { actionReason: reason });
  await state.queueNotification(turnRecord.turnKey, notification, turnRecord.fingerprint || '');
  await rememberNotificationHistory(notification, turnRecord.fingerprint || '');
  await finalizeRecovery(turnRecord.conversationId);
  flushNotificationOutbox().catch((error) => console.warn('Notification delivery failed', error));
  return notification.id;
}

async function flushNotificationOutbox() {
  if (outboxFlushPromise) return await outboxFlushPromise;
  outboxFlushPromise = (async () => {
    const state = coordinator();
    if (!state) return;
    const records = await state.listOutbox();
    for (const record of records) {
      if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) return;
      const notification = record?.notification;
      if (!notification?.id) continue;
      await state.noteOutboxAttempt(notification.id);
      const response = await sendNativeRequest(
        { type: 'toast.show', notification },
        ['toast.accepted'],
        5000,
        { queueIfDisconnected: false }
      );
      if (!response || response.accepted !== true || String(response.notificationId || '') !== String(notification.id)) return;
      await state.acknowledgeNotification(notification.id);
    }
  })().finally(() => { outboxFlushPromise = null; });
  return await outboxFlushPromise;
}

async function reconcileUnresolvedTurns() {
  if (reconcilePromise) return await reconcilePromise;
  reconcilePromise = (async () => {
    const state = coordinator();
    if (!state) return;
    const unresolved = await state.listUnresolvedTurns();
    for (const record of unresolved) {
      if (activeTurnKeys.has(String(record?.turnKey || ''))) continue;
      await queueDurableNotification(record, `reconciled-${record.state || 'unknown'}-without-replay`);
    }
  })().finally(() => { reconcilePromise = null; });
  return await reconcilePromise;
}

function statusBoundToCompletion(status, originIdentity, upstreamResponse) {
  if (!status || status.ok !== true || !originIdentity) return false;
  if (String(status.conversationId || '') !== originIdentity.id) return false;
  if (!status.documentId || !status.promptKey || !status.assistantKey || !status.revision) return false;
  const upstream = normalizeResponseText(upstreamResponse);
  const observed = normalizeResponseText(status.responseText);
  return Boolean(upstream && observed && upstream === observed);
}

async function handleContinuationClaim(record, status, tabId, senderDocumentId) {
  const state = coordinator();
  if (!state) return await queueDurableNotification(record, 'coordinator-unavailable');

  const currentIdentity = await currentConversationForTab(tabId);
  if (!currentIdentity || currentIdentity.id !== record.conversationId) {
    return await queueDurableNotification(record, 'conversation-changed-before-action');
  }

  await state.updateTurn(record.turnKey, { state: 'continuation-authorized' });
  const requestWatch = startContinuationRequestWatch(tabId, record.conversationId);
  const expected = {
    conversationId: status.conversationId,
    conversationUrl: status.conversationUrl,
    documentId: status.documentId,
    promptKey: status.promptKey,
    promptRevision: status.promptRevision,
    assistantKey: status.assistantKey,
    revision: status.revision,
    statusCode: status.statusCode
  };

  const action = await requestContinuation(tabId, senderDocumentId, expected);
  if (!action) {
    cancelContinuationRequestWatch(requestWatch, 'continuation-command-unreachable');
    return await queueDurableNotification(record, 'continuation-command-unreachable');
  }

  await state.updateTurn(record.turnKey, {
    state: action.clicked ? 'continuation-clicked' : 'continuation-refused',
    actionReason: String(action.reason || ''),
    continuationUserKey: String(action.continuationUserKey || '')
  });

  if (!action.clicked) {
    cancelContinuationRequestWatch(requestWatch, action.reason || 'continuation-not-clicked');
    return await queueDurableNotification(record, action.reason || 'continuation-not-clicked');
  }

  const requestEvidence = await requestWatch.promise;
  await state.updateTurn(record.turnKey, {
    requestEvidence: String(requestEvidence?.reason || ''),
    actionReason: String(action.reason || '')
  });

  const currentAfterAction = await currentConversationForTab(tabId);
  const outcome = globalThis.ChatGPTNotifierContinuationPolicy?.continuationOutcome?.({
    pageTurnConfirmed: action.ok === true,
    requestAccepted: requestEvidence?.accepted === true,
    sameConversation: currentAfterAction?.id === record.conversationId
  }) || { accepted: false, reason: 'continuation-policy-unavailable' };
  if (outcome.accepted !== true) {
    const reason = [
      action.ok === true ? '' : (action.reason || 'page-action-unconfirmed'),
      requestEvidence?.accepted === true ? '' : (requestEvidence?.reason || 'request-unconfirmed'),
      currentAfterAction?.id === record.conversationId ? '' : 'conversation-changed-after-action',
      outcome.reason === 'continuation-confirmed' ? '' : outcome.reason
    ].filter(Boolean).join('+');
    return await queueDurableNotification(record, reason || 'continuation-uncertain');
  }

  await state.updateTurn(record.turnKey, {
    state: 'continued',
    actionReason: action.reason || 'continuation-user-turn-confirmed',
    requestEvidence: requestEvidence.reason || 'request-accepted'
  });
  await finalizeRecovery(record.conversationId);
  return null;
}

async function processCodedCompletion(status, owner = {}) {
  const tabId = owner.tabId;
  const senderDocumentId = String(owner.chromeDocumentId || '');
  if (!Number.isInteger(tabId)) return null;
  const statusCode = String(status?.statusCode || '');
  if (!globalThis.ChatGPTNotifierStatusCode?.isStatusCode(statusCode)) return null;

  const currentIdentity = await currentConversationForTab(tabId);
  if (!currentIdentity || currentIdentity.id !== String(status?.conversationId || '')) return null;

  const state = coordinator();
  if (!state) return null;
  const notificationId = String(owner.notificationId || crypto.randomUUID());
  const claimOwner = {
    tabId,
    documentId: senderDocumentId,
    fingerprint: String(owner.fingerprint || ''),
    notificationId,
    notificationTitle: String(owner.notificationTitle || 'ChatGPT'),
    notificationPreview: String(owner.notificationPreview || truncateResponse(status?.responseBody || status?.responseText || 'Response finished.'))
  };
  const claim = await state.claimTurn(status, claimOwner);
  if (!claim?.claimed) {
    flushNotificationOutbox().catch(() => {});
    return null;
  }

  const record = claim.record;
  activeTurnKeys.add(record.turnKey);
  try {
    const shouldContinue = globalThis.ChatGPTNotifierContinuationPolicy?.isAutoContinueStatusCode?.(statusCode) === true;
    if (!shouldContinue) return await queueDurableNotification(record, String(owner.reason || 'coded-completion'));
    return await handleContinuationClaim(record, status, tabId, senderDocumentId);
  } finally {
    activeTurnKeys.delete(record.turnKey);
  }
}

async function showCompletionFromUpstream(message, sender) {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') return null;
  const senderDocumentId = String(sender.documentId || '');
  const originIdentity = conversationFromUrl(sender.tab?.url || message?.conversationUrl || '');
  if (!originIdentity) return null;

  const status = await queryTerminalStatus(tabId, senderDocumentId);
  const statusCode = String(status?.statusCode || '');
  if (!globalThis.ChatGPTNotifierStatusCode?.isStatusCode(statusCode)) return null;
  if (!statusBoundToCompletion(status, originIdentity, message?.response)) return null;

  return await processCodedCompletion(status, {
    tabId,
    chromeDocumentId: senderDocumentId,
    fingerprint: String(message?.fingerprint || ''),
    notificationTitle: fullTabTitle(sender, message),
    notificationPreview: truncateResponse(status?.responseBody || message?.response),
    reason: 'coded-completion'
  });
}

async function handleWorkerObservedTerminalStatus(payload = {}) {
  const monitorSnapshot = payload?.monitorSnapshot || {};
  const owner = payload?.owner || {};
  const tabId = Number(owner.tabId);
  const chromeDocumentId = String(owner.chromeDocumentId || '');
  const requestId = String(owner.requestId || '');
  if (!Number.isInteger(tabId) || !requestId || !chromeDocumentId) return { handled: false, reason: 'missing-request-owner' };
  if (String(monitorSnapshot.requestId || '') !== requestId) return { handled: false, reason: 'request-identity-mismatch' };
  if (!globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(String(monitorSnapshot.statusCode || ''))) {
    return { handled: false, reason: 'status-not-ready' };
  }
  if (!monitorSnapshot.conversationId || !monitorSnapshot.promptKey || !monitorSnapshot.assistantKey) {
    return { handled: false, reason: 'turn-identity-not-ready' };
  }

  const status = await queryImmediateTerminalStatus(tabId, chromeDocumentId);
  if (!status?.statusCode) return { handled: false, reason: 'status-dom-not-ready' };
  if (String(status.statusCode) !== String(monitorSnapshot.statusCode || '')) return { handled: false, reason: 'status-code-mismatch' };
  if (String(status.conversationId || '') !== String(monitorSnapshot.conversationId || '')) return { handled: false, reason: 'conversation-identity-mismatch' };
  if (String(status.promptKey || '') !== String(monitorSnapshot.promptKey || '')) return { handled: false, reason: 'prompt-identity-mismatch' };
  if (String(status.assistantKey || '') !== String(monitorSnapshot.assistantKey || '')) return { handled: false, reason: 'assistant-identity-mismatch' };

  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch {}
  const notificationId = await processCodedCompletion(status, {
    tabId,
    chromeDocumentId,
    fingerprint: `worker|${status.conversationId}|${requestId}|${status.statusCode}`,
    notificationTitle: String(tab?.title || 'ChatGPT').trim() || 'ChatGPT',
    notificationPreview: truncateResponse(status?.responseBody || status?.responseText || 'Response finished.'),
    reason: 'worker-observed-coded-completion'
  });
  return { handled: true, notificationId: notificationId || null, reason: notificationId ? 'notification-queued' : 'coded-completion-processed' };
}

globalThis.__chatgptNotifierWorkerTerminalFallback = Object.freeze({
  version: 1,
  handle: handleWorkerObservedTerminalStatus
});

async function handleNativeMessage(message) {
  if (!message || typeof message !== 'object') return;
  settleNativeRequest(message);

  if (message.installedExtensionVersion) {
    if (maybeReloadForInstalledVersion(String(message.installedExtensionVersion))) return;
  }

  if (message.type === 'host.ready') {
    await injectScriptsIntoExistingChatgptTabs();
    await reconcileUnresolvedTurns();
    await flushNotificationOutbox();
    return;
  }

  if (message.type === 'toast.clicked') {
    const conversationId = String(message.conversationId || '');
    const conversationUrl = String(message.conversationUrl || '');
    const notificationId = String(message.notificationId || '');
    const correlationId = String(message.correlationId || crypto.randomUUID());
    const targetTabId = Number.isInteger(message.targetTabId) ? message.targetTabId : null;
    if (!conversationId || !conversationUrl || !notificationId) return;
    if (activeToastClicks.has(notificationId)) {
      emitClickDiagnostic('click-duplicate-suppressed', { conversationId, notificationId, correlationId, tabId: targetTabId, reason: 'click-already-in-flight' });
      return;
    }
    activeToastClicks.add(notificationId);
    try {
      emitClickDiagnostic('worker-click-received', { conversationId, notificationId, correlationId, tabId: targetTabId });
      const result = await focusOrOpenConversation(conversationId, conversationUrl, { notificationId, correlationId, targetTabId });
      if (result?.presented === true) {
        sendNative({ type: 'toast.dismissConversation', conversationId });
        emitClickDiagnostic('click-presentation-complete', { conversationId, notificationId, correlationId, tabId: result.targetTabId, reason: result.presentationState || 'focused' });
      } else {
        sendNative({
          type: 'toast.clickResult',
          notificationId,
          clickState: String(result?.presentationState || 'unverified'),
          targetTabId: Number.isInteger(result?.targetTabId) ? result.targetTabId : targetTabId
        });
        emitClickDiagnostic('click-presentation-incomplete', {
          conversationId,
          notificationId,
          correlationId,
          tabId: result?.targetTabId,
          reason: String(result?.reason || result?.presentationState || 'unverified')
        });
      }
    } finally {
      activeToastClicks.delete(notificationId);
    }
    return;
  }

  if (message.type === 'toast.moveHere') {
    const conversationId = String(message.conversationId || '');
    const notificationId = String(message.notificationId || '');
    const correlationId = String(message.correlationId || crypto.randomUUID());
    const targetTabId = Number.isInteger(message.targetTabId) ? message.targetTabId : null;
    if (!conversationId || !notificationId || !Number.isInteger(targetTabId)) return;
    if (activeToastClicks.has(notificationId)) return;
    activeToastClicks.add(notificationId);
    try {
      const result = await globalThis.__chatgptNotifierCrossDesktopClickFallback?.moveTabHere?.(
        conversationId,
        targetTabId,
        { notificationId, correlationId, targetTabId }
      );
      if (result?.presented === true) {
        sendNative({ type: 'toast.dismissConversation', conversationId });
        emitClickDiagnostic('click-move-here-complete', { conversationId, notificationId, correlationId, tabId: targetTabId });
      } else {
        sendNative({ type: 'toast.clickResult', notificationId, clickState: String(result?.presentationState || 'unverified'), targetTabId });
        emitClickDiagnostic('click-move-here-incomplete', {
          conversationId,
          notificationId,
          correlationId,
          tabId: targetTabId,
          reason: String(result?.reason || 'move-here-unverified')
        });
      }
    } finally {
      activeToastClicks.delete(notificationId);
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'CHATGPT_RESPONSE_COMPLETE') {
    showCompletionFromUpstream(message, sender).then((notificationId) => {
      sendResponse?.({ ok: true, notified: Boolean(notificationId), notificationId: notificationId || null });
    }).catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === 'CHATGPT_CONVERSATION_USER_INTERACTED') {
    dismissConversationForSender(message, sender).then((dismissed) => sendResponse?.({ ok: dismissed }))
      .catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === 'CHATGPT_PAGE_RETURNED') return false;

  if (message?.type === 'TEST_NATIVE_TOAST') {
    (async () => {
      const response = await pingNativeHost();
      if (!response) {
        sendResponse?.({ ok: false, error: 'Windows helper is not running or is not responding.' });
        return;
      }
      const notificationId = crypto.randomUUID();
      const sent = sendNative({
        type: 'toast.show',
        notification: {
          id: notificationId,
          conversationId: `test-${notificationId}`,
          conversationUrl: 'https://chatgpt.com/',
          title: 'Notifier test',
          preview: 'Persistent stacked notification test.',
          statusCode: 'TEST',
          completedAt: new Date().toISOString()
        }
      });
      sendResponse?.(sent ? { ok: true, notificationId } : { ok: false, error: 'Windows helper disconnected before the test toast was sent.' });
    })().catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === 'PING_NATIVE_HOST') {
    pingNativeHost().then((response) => {
      sendResponse?.(response ? {
        ok: true,
        installedExtensionVersion: response.installedExtensionVersion || null,
        transport: response.transport || null,
        updateStatus: response.updateStatus || null
      } : { ok: false, error: 'Windows helper is not running or is not responding.' });
    }).catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === 'CHECK_MANAGED_UPDATE') {
    sendNativeRequest({ type: 'update.check' }, ['update.result'], 120000).then((response) => {
      sendResponse?.(response ? { ok: true, updateStatus: response.updateStatus || null } : { ok: false, error: 'Windows helper did not return an update result.' });
    }).catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelContinuationRequestWatch(continuationRequestWatchers.get(tabId), 'owner-tab-closed');
});

connectNativeHost();
injectScriptsIntoExistingChatgptTabs().catch(() => {});
coordinator()?.pruneOldRecords?.().catch(() => {});
reconcileUnresolvedTurns().then(() => flushNotificationOutbox()).catch(() => {});