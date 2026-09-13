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

function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) return;
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
  if (comparison !== null && comparison > 0) {
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

function finiteWindowCoordinate(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
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

async function requestNativeChromeForeground(tabId, windowId) {
  if (typeof tabId !== 'number' || typeof windowId !== 'number') return false;
  try {
    await sleep(50);
    const [tabInfo, windowInfo] = await Promise.all([chrome.tabs.get(tabId), chrome.windows.get(windowId)]);
    const response = await sendNativeRequest({
      type: 'window.foreground',
      windowTitle: String(tabInfo?.title || ''),
      windowLeft: finiteWindowCoordinate(windowInfo?.left),
      windowTop: finiteWindowCoordinate(windowInfo?.top),
      windowWidth: finiteWindowCoordinate(windowInfo?.width),
      windowHeight: finiteWindowCoordinate(windowInfo?.height)
    }, ['window.foregroundResult'], 1500);
    return response?.success === true;
  } catch {
    return false;
  }
}

async function focusOrOpenConversation(conversationId, conversationUrl) {
  const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
  const existing = tabs.find((tab) => conversationFromUrl(tab.url)?.id === conversationId);
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (typeof existing.windowId === 'number') {
      const nativeFocused = await requestNativeChromeForeground(existing.id, existing.windowId);
      if (!nativeFocused) await foregroundChromeWindow(existing.windowId);
    }
  } else {
    const created = await chrome.tabs.create({ url: conversationUrl, active: true });
    if (typeof created?.id === 'number' && typeof created?.windowId === 'number') {
      const nativeFocused = await requestNativeChromeForeground(created.id, created.windowId);
      if (!nativeFocused) await foregroundChromeWindow(created.windowId);
    } else if (typeof created?.windowId === 'number') {
      await foregroundChromeWindow(created.windowId);
    }
  }
  sendNative({ type: 'toast.dismissConversation', conversationId });
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
        files: ['attachment-script.js', 'content-script.js', 'persistence-script.js', 'status-code.js', 'status-policy.js', 'status-script.js']
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

  const currentIdentity = await currentConversationForTab(tabId);
  if (!currentIdentity || currentIdentity.id !== originIdentity.id) return null;

  const state = coordinator();
  if (!state) return null;
  const notificationId = crypto.randomUUID();
  const owner = {
    tabId,
    documentId: senderDocumentId,
    fingerprint: String(message?.fingerprint || ''),
    notificationId,
    notificationTitle: fullTabTitle(sender, message),
    notificationPreview: truncateResponse(status?.responseBody || message?.response)
  };
  const claim = await state.claimTurn(status, owner);
  if (!claim?.claimed) {
    flushNotificationOutbox().catch(() => {});
    return null;
  }

  const record = claim.record;
  activeTurnKeys.add(record.turnKey);
  try {
    if (statusCode !== 'INCOMPLETE_LIMIT') {
      return await queueDurableNotification(record, 'coded-completion');
    }

    return await handleContinuationClaim(record, status, tabId, senderDocumentId);
  } finally {
    activeTurnKeys.delete(record.turnKey);
  }
}

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
    if (!conversationId || !conversationUrl) return;
    await focusOrOpenConversation(conversationId, conversationUrl);
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
