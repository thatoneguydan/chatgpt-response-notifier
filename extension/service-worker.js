'use strict';

import {
  conversationFromUrl,
  formatNotificationTitle,
  truncatePreview
} from './lib/conversation.js';
import {
  captureIsFreshForRequest,
  currentConversationReadUrl,
  latestCompletedAssistant,
  legacyConversationReadUrl
} from './lib/server-capture.js';

const BRIDGE_URL = 'ws://127.0.0.1:38473/bridge';
const CHATGPT_REQUEST_FILTER = {
  urls: [
    'https://chatgpt.com/backend-api/f/conversation*',
    'https://chatgpt.com/backend-api/conversation*'
  ]
};
const SERVER_CAPTURE_RETRY_DELAYS_MS = [100, 350, 900, 1800, 3000];
const SERVER_CAPTURE_START_WATCH_DELAYS_MS = [1000, 1500, 2500, 4000, 6000, 8000, 10000, 12000, 15000];
const SERVER_CAPTURE_START_WATCH_TIMEOUT_MS = 30 * 60 * 1000;
const SERVER_CAPTURE_DIAGNOSTIC_HISTORY_LIMIT = 12;
const SERVER_CAPTURE_FETCH_TIMEOUT_MS = 5000;
const SERVER_CAPTURE_FRESHNESS_TOLERANCE_MS = 5000;
const SERVER_CAPTURE_HEADER_NAMES = new Set([
  'authorization',
  'chatgpt-account-id',
  'oai-client-version',
  'oai-device-id',
  'x-conduit-token',
  'x-openai-assistant-app-id'
]);

let bridgeSocket = null;
let reconnectTimer = null;
let reconnectDelayMs = 750;
let keepAliveTimer = null;
const outboundQueue = [];
const nativeRequestWaiters = new Map();
const answerRequestContexts = new Map();
const answerRequestWatches = new Map();
const answerRequestWatchIdsByTab = new Map();
const completedAnswerRequestIds = new Set();
let backgroundCaptureHistory = [];

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
  } catch (error) {
    console.debug('ChatGPT notifier localhost bridge unavailable', error);
    bridgeSocket = null;
    scheduleReconnect();
    return null;
  }
}

function sendNative(message) {
  const socket = connectNativeHost();
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    queueNativeMessage(message);
    return false;
  }
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    queueNativeMessage(message);
    try { socket.close(); } catch {}
    return false;
  }
}

function sendNativeRequest(message, expectedTypes, timeoutMs) {
  const requestId = crypto.randomUUID();
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
    sendNative({ ...message, requestId });
  });
}

async function pingNativeHost(timeoutMs = 3000) {
  const response = await sendNativeRequest({ type: 'ping' }, ['pong'], timeoutMs);
  return response || null;
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

function answerRequestPath(details) {
  try {
    return new URL(details?.url || '').pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function isAnswerStartRequest(details) {
  if (details.tabId < 0 || details.method !== 'POST') return false;
  const path = answerRequestPath(details);
  return path === '/backend-api/f/conversation' ||
    path === '/backend-api/conversation' ||
    path === '/backend-api/f/conversation/prepare';
}

function isAnswerStreamRequest(details) {
  if (details.tabId < 0 || details.method !== 'POST') return false;
  const path = answerRequestPath(details);
  return path === '/backend-api/f/conversation' || path === '/backend-api/conversation';
}

function boundedRequestContextCache() {
  while (answerRequestContexts.size > 100) {
    const oldest = answerRequestContexts.keys().next().value;
    if (!oldest) break;
    answerRequestContexts.delete(oldest);
  }
}

function recordBackgroundCapture(status, details = {}) {
  const diagnostic = {
    status: String(status || 'unknown'),
    observedAt: new Date().toISOString(),
    ...details
  };
  backgroundCaptureHistory = [diagnostic, ...backgroundCaptureHistory]
    .slice(0, SERVER_CAPTURE_DIAGNOSTIC_HISTORY_LIMIT);
}

function rememberCompletedAnswerRequest(requestId) {
  const value = String(requestId || '');
  if (!value) return;
  completedAnswerRequestIds.add(value);
  while (completedAnswerRequestIds.size > 100) {
    const oldest = completedAnswerRequestIds.values().next().value;
    if (!oldest) break;
    completedAnswerRequestIds.delete(oldest);
  }
}

function captureRequestHeaders(requestHeaders) {
  const headers = {};
  for (const header of requestHeaders || []) {
    const lowerName = String(header?.name || '').trim().toLowerCase();
    if (!SERVER_CAPTURE_HEADER_NAMES.has(lowerName)) continue;
    if (typeof header?.value !== 'string' || !header.value) continue;
    headers[header.name] = header.value;
  }
  return headers;
}

function captureAnswerRequestContext(details) {
  if (!isAnswerStartRequest(details)) return;
  const requestId = String(details.requestId || '');
  const context = {
    tabId: details.tabId,
    startedAt: Number(details.timeStamp) || Date.now(),
    headers: captureRequestHeaders(details.requestHeaders),
    triggerPath: answerRequestPath(details)
  };
  answerRequestContexts.set(requestId, context);
  boundedRequestContextCache();
  recordBackgroundCapture('request-start-observed', {
    tabId: details.tabId,
    triggerPath: context.triggerPath
  });
  watchAnswerRequestFromStart(details, context).catch((error) => {
    recordBackgroundCapture('request-start-watch-error', {
      tabId: details.tabId,
      triggerPath: context.triggerPath,
      error: String(error?.message || error)
    });
    console.warn('Request-start ChatGPT completion watch failed', error);
  });
}

function takeAnswerRequestContext(details) {
  const key = String(details?.requestId || '');
  const context = answerRequestContexts.get(key) || null;
  if (key) answerRequestContexts.delete(key);
  return context;
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
}

async function accessTokenFromSession() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SERVER_CAPTURE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch('https://chatgpt.com/api/auth/session', {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) return '';
    const payload = await response.json();
    const token = String(payload?.accessToken || payload?.access_token || '');
    return token.length >= 20 ? token : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timeoutId);
  }
}

async function serverReadHeaders(context) {
  const headers = { Accept: 'application/json' };
  for (const [name, value] of Object.entries(context?.headers || {})) {
    headers[name] = value;
  }
  const hasAuthorization = Object.keys(headers).some((name) => name.toLowerCase() === 'authorization');
  if (!hasAuthorization) {
    const token = await accessTokenFromSession();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchConversationJson(url, headers) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SERVER_CAPTURE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers,
      signal: controller.signal
    });
    if (!response.ok) return { ok: false, status: response.status, payload: null };
    return { ok: true, status: response.status, payload: await response.json() };
  } catch (error) {
    return { ok: false, status: 0, payload: null, error: String(error?.message || error) };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readCompletedConversation(identity, context, retryDelays = SERVER_CAPTURE_RETRY_DELAYS_MS) {
  const headers = await serverReadHeaders(context);
  const currentUrl = currentConversationReadUrl(identity.id);
  const legacyUrl = legacyConversationReadUrl(identity.id);
  const requestStartedAt = Number(context?.startedAt) || Date.now();
  let lastStatus = 0;
  let lastReason = 'no-completed-assistant';

  for (const delayMs of retryDelays) {
    await sleep(delayMs);
    let result = await fetchConversationJson(currentUrl, headers);
    let source = 'current-conversations-api';

    if (!result.ok && result.status === 404) {
      result = await fetchConversationJson(legacyUrl, headers);
      source = 'legacy-conversation-api';
    }

    lastStatus = result.status;
    if (!result.ok) {
      lastReason = result.status ? `http-${result.status}` : 'network-or-timeout';
      if (result.status === 401 || result.status === 403 || result.status === 429) break;
      continue;
    }

    const capture = latestCompletedAssistant(result.payload);
    if (!capture?.response) {
      lastReason = 'no-completed-assistant';
      continue;
    }
    if (!captureIsFreshForRequest(capture, requestStartedAt, SERVER_CAPTURE_FRESHNESS_TOLERANCE_MS)) {
      lastReason = 'stale-completed-assistant';
      continue;
    }

    return { ok: true, capture, source, status: result.status };
  }

  return { ok: false, capture: null, source: 'none', status: lastStatus, reason: lastReason };
}

function showCompletionToast(identity, response, sessionTitle, projectTitle = '') {
  const preview = truncatePreview(response);
  if (!identity || !preview) return null;
  const notificationId = crypto.randomUUID();
  sendNative({
    type: 'toast.show',
    notification: {
      id: notificationId,
      conversationId: identity.id,
      conversationUrl: identity.url,
      title: formatNotificationTitle(projectTitle, sessionTitle),
      preview,
      completedAt: new Date().toISOString()
    }
  });
  return notificationId;
}

async function contentScriptIsLive(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_CHATGPT_CAPTURE_DIAGNOSTIC' });
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function injectCurrentContentScripts(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      globalThis.__chatgptNativeNotifierGeneration =
        (Number(globalThis.__chatgptNativeNotifierGeneration) || 0) + 1;
      globalThis.__chatgptNativeNotifierVersion = '';
      globalThis.__chatgptNativeNotifierInstalled = false;
      globalThis.__chatgptNotifierRecoveryVersion = '';
    }
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content-script.js', 'recovery-watchdog.js']
  });
}

async function ensureContentScriptsInChatgptTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
  } catch {
    return;
  }

  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    try {
      if (await contentScriptIsLive(tab.id)) continue;
      await injectCurrentContentScripts(tab.id);
    } catch {}
  }
}

async function signalConversationRequestCompleted(tabId) {
  const message = { type: 'CHATGPT_CONVERSATION_REQUEST_COMPLETED' };
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {}

  try {
    await injectCurrentContentScripts(tabId);
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch (error) {
    console.warn('Could not arm completion watcher', error);
    return false;
  }
}

async function resolveConversationIdentity(initialUrl, tabId) {
  let identity = conversationFromUrl(initialUrl);
  if (identity) return identity;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(250);
    try {
      const tab = await chrome.tabs.get(tabId);
      identity = conversationFromUrl(tab.url);
      if (identity) return identity;
    } catch {
      return null;
    }
  }
  return null;
}

function cancelAnswerRequestWatch(requestId) {
  const key = String(requestId || '');
  const watch = answerRequestWatches.get(key);
  if (!watch) return;
  watch.cancelled = true;
  answerRequestWatches.delete(key);
  if (answerRequestWatchIdsByTab.get(watch.tabId) === key) {
    answerRequestWatchIdsByTab.delete(watch.tabId);
  }
}

function startWatchDelay(attempt) {
  const index = Math.min(
    Math.max(0, Number(attempt) || 0),
    SERVER_CAPTURE_START_WATCH_DELAYS_MS.length - 1
  );
  return SERVER_CAPTURE_START_WATCH_DELAYS_MS[index];
}

async function watchAnswerRequestFromStart(details, context) {
  const requestId = String(details?.requestId || '');
  if (!requestId || typeof details?.tabId !== 'number') return;

  const priorRequestId = answerRequestWatchIdsByTab.get(details.tabId);
  if (priorRequestId && priorRequestId !== requestId) {
    cancelAnswerRequestWatch(priorRequestId);
    answerRequestContexts.delete(priorRequestId);
  }

  const watch = {
    requestId,
    tabId: details.tabId,
    startedAt: Number(context?.startedAt) || Date.now(),
    triggerPath: String(context?.triggerPath || answerRequestPath(details)),
    cancelled: false
  };
  answerRequestWatches.set(requestId, watch);
  answerRequestWatchIdsByTab.set(details.tabId, requestId);

  let tab = null;
  try { tab = await chrome.tabs.get(details.tabId); } catch {}
  let identity = await resolveConversationIdentity(tab?.url || '', details.tabId);
  for (let attempt = 0; !identity && attempt < 20 && !watch.cancelled; attempt += 1) {
    await sleep(500);
    try {
      tab = await chrome.tabs.get(details.tabId);
      identity = conversationFromUrl(tab?.url || '');
    } catch {
      break;
    }
  }

  if (watch.cancelled) return;
  if (!identity) {
    recordBackgroundCapture('request-start-no-identity', {
      tabId: details.tabId,
      triggerPath: watch.triggerPath
    });
    cancelAnswerRequestWatch(requestId);
    return;
  }

  recordBackgroundCapture('request-start-watch-armed', {
    tabId: details.tabId,
    conversationId: identity.id,
    triggerPath: watch.triggerPath,
    frozen: Boolean(tab?.frozen),
    discarded: Boolean(tab?.discarded)
  });

  const watchStartedAt = Date.now();
  let attempt = 0;
  let lastReason = '';
  while (!watch.cancelled && Date.now() - watchStartedAt < SERVER_CAPTURE_START_WATCH_TIMEOUT_MS) {
    await sleep(startWatchDelay(attempt));
    if (watch.cancelled) return;

    const activeContext = answerRequestContexts.get(requestId) || context;
    const result = await readCompletedConversation(identity, activeContext, [0]);
    if (watch.cancelled) return;
    if (result.ok && result.capture?.response) {
      try { tab = await chrome.tabs.get(details.tabId); } catch {}
      showCompletionToast(
        identity,
        result.capture.response,
        result.capture.title || tab?.title || 'ChatGPT',
        ''
      );
      rememberCompletedAnswerRequest(requestId);
      answerRequestContexts.delete(requestId);
      recordBackgroundCapture('request-start-toast', {
        tabId: details.tabId,
        conversationId: identity.id,
        triggerPath: watch.triggerPath,
        source: result.source,
        statusCode: result.status || 0,
        elapsedMs: Date.now() - watch.startedAt,
        frozen: Boolean(tab?.frozen),
        discarded: Boolean(tab?.discarded)
      });
      cancelAnswerRequestWatch(requestId);
      return;
    }

    const reason = String(result.reason || `http-${result.status || 0}`);
    if (reason !== lastReason) {
      lastReason = reason;
      recordBackgroundCapture('request-start-polling', {
        tabId: details.tabId,
        conversationId: identity.id,
        triggerPath: watch.triggerPath,
        reason,
        statusCode: result.status || 0
      });
    }
    attempt += 1;
  }

  if (!watch.cancelled) {
    recordBackgroundCapture('request-start-watch-timeout', {
      tabId: details.tabId,
      conversationId: identity.id,
      triggerPath: watch.triggerPath,
      elapsedMs: Date.now() - watch.startedAt
    });
    cancelAnswerRequestWatch(requestId);
  }
}

async function handleCompletedAnswerRequest(details) {
  const requestId = String(details?.requestId || '');
  if (completedAnswerRequestIds.has(requestId)) {
    completedAnswerRequestIds.delete(requestId);
    takeAnswerRequestContext(details);
    cancelAnswerRequestWatch(requestId);
    recordBackgroundCapture('network-completed-after-request-start-toast', {
      tabId: details.tabId,
      triggerPath: answerRequestPath(details)
    });
    return;
  }

  const existingWatch = answerRequestWatches.get(requestId) || null;
  recordBackgroundCapture('network-completed-observed', {
    tabId: details.tabId,
    triggerPath: answerRequestPath(details),
    statusCode: details.statusCode || 0
  });
  const context = answerRequestContexts.get(requestId) || {
    tabId: details.tabId,
    startedAt: Number(details.timeStamp) || Date.now(),
    headers: {},
    triggerPath: answerRequestPath(details)
  };

  let tab = null;
  try { tab = await chrome.tabs.get(details.tabId); } catch {}
  const identity = await resolveConversationIdentity(tab?.url || '', details.tabId);
  if (!identity) {
    if (!existingWatch) {
      // New conversations can briefly lack a stable /c/<id> URL. The DOM path
      // remains a compatibility fallback only when no service-worker watch survived.
      await signalConversationRequestCompleted(details.tabId);
    }
    return;
  }

  const result = await readCompletedConversation(identity, context);

  // The request-start watch may have found and notified the terminal answer while
  // this acceleration read was in flight. Never emit a second toast in that race.
  if (completedAnswerRequestIds.has(requestId)) {
    completedAnswerRequestIds.delete(requestId);
    takeAnswerRequestContext(details);
    cancelAnswerRequestWatch(requestId);
    recordBackgroundCapture('network-completed-after-request-start-toast', {
      tabId: details.tabId,
      triggerPath: answerRequestPath(details)
    });
    return;
  }

  if (result.ok && result.capture?.response) {
    showCompletionToast(
      identity,
      result.capture.response,
      result.capture.title || tab?.title || 'ChatGPT',
      ''
    );
    takeAnswerRequestContext(details);
    cancelAnswerRequestWatch(requestId);
    recordBackgroundCapture('network-completed-terminal-toast', {
      tabId: details.tabId,
      conversationId: identity.id,
      triggerPath: answerRequestPath(details),
      source: result.source,
      statusCode: result.status || 0
    });
    return;
  }

  // A transport request can finish between tool calls while the ChatGPT turn is
  // still running. Network completion is therefore only an acceleration signal,
  // never sufficient evidence by itself that the user-facing answer is ready.
  if (existingWatch && !existingWatch.cancelled) {
    recordBackgroundCapture('network-completed-waiting-for-terminal', {
      tabId: details.tabId,
      conversationId: identity.id,
      triggerPath: answerRequestPath(details),
      reason: result.reason || 'no-terminal-assistant',
      statusCode: result.status || 0
    });
    return;
  }

  // If the service worker restarted and lost its in-memory request-start watch,
  // re-arm a bounded server-side watch instead of producing a premature generic
  // notification. This remains independent of hidden-tab DOM execution.
  answerRequestContexts.set(requestId, context);
  boundedRequestContextCache();
  recordBackgroundCapture('network-completed-rearming-terminal-watch', {
    tabId: details.tabId,
    conversationId: identity.id,
    triggerPath: answerRequestPath(details),
    reason: result.reason || 'no-terminal-assistant',
    statusCode: result.status || 0
  });
  watchAnswerRequestFromStart(details, context).catch((error) => {
    recordBackgroundCapture('network-completed-rearm-error', {
      tabId: details.tabId,
      conversationId: identity.id,
      triggerPath: answerRequestPath(details),
      error: String(error?.message || error)
    });
    console.warn('Could not re-arm terminal ChatGPT completion watch', error);
  });
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  captureAnswerRequestContext,
  CHATGPT_REQUEST_FILTER,
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onErrorOccurred.addListener((details) => {
  if (!isAnswerStartRequest(details)) return;
  cancelAnswerRequestWatch(details.requestId);
  takeAnswerRequestContext(details);
  recordBackgroundCapture('answer-request-error', {
    tabId: details.tabId,
    triggerPath: answerRequestPath(details),
    error: String(details.error || '')
  });
}, CHATGPT_REQUEST_FILTER);

chrome.webRequest.onCompleted.addListener((details) => {
  if (!isAnswerStreamRequest(details)) return;
  if (details.statusCode < 200 || details.statusCode >= 300) {
    cancelAnswerRequestWatch(details.requestId);
    takeAnswerRequestContext(details);
    recordBackgroundCapture('network-completed-non-success', {
      tabId: details.tabId,
      triggerPath: answerRequestPath(details),
      statusCode: details.statusCode || 0
    });
    return;
  }
  handleCompletedAnswerRequest(details).catch((error) => {
    console.warn('Background-safe ChatGPT completion handling failed', error);
  });
}, CHATGPT_REQUEST_FILTER);

async function dismissReportedUserInteraction(message, sender) {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') return false;

  try {
    const tab = await chrome.tabs.get(tabId);
    const identity = conversationFromUrl(message.conversationUrl || tab.url);
    if (!identity) return false;
    sendNative({ type: 'toast.dismissConversation', conversationId: identity.id });
    return true;
  } catch {
    return false;
  }
}

async function foregroundChromeWindow(windowId) {
  if (typeof windowId !== 'number') return false;
  try {
    const windowInfo = await chrome.windows.get(windowId);
    if (windowInfo.state === 'minimized') {
      await chrome.windows.update(windowId, { state: 'normal' });
    }
    await chrome.windows.update(windowId, { focused: true });
    return true;
  } catch {
    return false;
  }
}

function finiteWindowCoordinate(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

async function requestNativeChromeForeground(tabId, windowId) {
  if (typeof tabId !== 'number' || typeof windowId !== 'number') return false;
  try {
    await sleep(50);
    const [tabInfo, windowInfo] = await Promise.all([
      chrome.tabs.get(tabId),
      chrome.windows.get(windowId)
    ]);
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

async function showRecoveryAttention(message, sender) {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') return null;
  const identity = await resolveConversationIdentity(message.conversationUrl || sender.tab?.url, tabId);
  if (!identity) return null;

  const preview = truncatePreview(message.preview || 'This ChatGPT conversation needs attention after automatic recovery attempts.');
  if (!preview) return null;

  const contextTitle = formatNotificationTitle('', message.sessionTitle || sender.tab?.title || 'ChatGPT');
  const notificationId = crypto.randomUUID();
  sendNative({
    type: 'toast.show',
    notification: {
      id: notificationId,
      conversationId: identity.id,
      conversationUrl: identity.url,
      title: `ChatGPT needs attention — ${contextTitle}`,
      preview,
      completedAt: new Date().toISOString()
    }
  });
  return notificationId;
}

async function handleNativeMessage(message) {
  if (!message || typeof message !== 'object') return;
  settleNativeRequest(message);

  if (message.installedExtensionVersion) {
    if (maybeReloadForInstalledVersion(String(message.installedExtensionVersion))) return;
  }

  if (message.type === 'host.ready') {
    await ensureContentScriptsInChatgptTabs();
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
  if (message?.type === 'CHATGPT_CONVERSATION_USER_INTERACTED') {
    dismissReportedUserInteraction(message, sender).then((dismissed) => {
      sendResponse?.({ ok: dismissed });
    }).catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === 'CHATGPT_RECOVERY_ATTENTION') {
    showRecoveryAttention(message, sender).then((notificationId) => {
      sendResponse?.(notificationId
        ? { ok: true, notificationId }
        : { ok: false, error: 'Could not resolve this conversation for a recovery alert.' });
    }).catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === 'CHATGPT_RESPONSE_COMPLETE') {
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse?.({ ok: false, error: 'Completion sender tab is unavailable.' });
      return false;
    }

    resolveConversationIdentity(message.conversationUrl || sender.tab?.url, tabId).then((identity) => {
      if (!identity) {
        sendResponse?.({ ok: false, error: 'No stable conversation identity became available.' });
        return;
      }

      const notificationId = showCompletionToast(
        identity,
        message.response,
        message.sessionTitle,
        message.projectTitle
      );
      sendResponse?.(notificationId
        ? { ok: true, notificationId }
        : { ok: false, error: 'No readable assistant response was captured.' });
    }).catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === 'GET_BACKGROUND_CAPTURE_DIAGNOSTIC') {
    sendResponse?.({
      ok: true,
      capture: backgroundCaptureHistory[0] || null,
      history: backgroundCaptureHistory.slice(0, SERVER_CAPTURE_DIAGNOSTIC_HISTORY_LIMIT)
    });
    return false;
  }

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
          preview: 'Local Windows helper connection works. This is an independent persistent toast window.',
          completedAt: new Date().toISOString()
        }
      });
      sendResponse?.(sent
        ? { ok: true, notificationId }
        : { ok: false, error: 'Windows helper disconnected before the test toast was sent.' });
    })().catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === 'PING_NATIVE_HOST') {
    pingNativeHost().then((response) => {
      sendResponse?.(response
        ? {
            ok: true,
            installedExtensionVersion: response.installedExtensionVersion || null,
            transport: response.transport || null,
            updateStatus: response.updateStatus || null
          }
        : { ok: false, error: 'Windows helper is not running or is not responding.' });
    }).catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === 'CHECK_MANAGED_UPDATE') {
    sendNativeRequest({ type: 'update.check' }, ['update.result'], 120000).then((response) => {
      sendResponse?.(response
        ? { ok: true, updateStatus: response.updateStatus || null }
        : { ok: false, error: 'Windows helper did not return an update result.' });
    }).catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  return false;
});

connectNativeHost();
ensureContentScriptsInChatgptTabs().catch(() => {});