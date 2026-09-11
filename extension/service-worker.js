'use strict';

const BRIDGE_URL = 'ws://127.0.0.1:38473/bridge';
const RESPONSE_PREVIEW_MAX_CHARS = 300;
const STATUS_QUERY_TIMEOUT_MS = 30000;
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
const lastNotificationFingerprintByTab = new Map();

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
  } catch {
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
      return {
        id,
        url: `https://chatgpt.com${url.pathname.replace(/\/+$/, '')}`
      };
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

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
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

function finiteWindowCoordinate(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
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

async function injectScriptsIntoExistingChatgptTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); } catch { return; }
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content-script.js', 'persistence-script.js', 'status-code.js', 'status-script.js']
      });
    } catch {}
  }
}

// Monitoring core below intentionally preserves Ram Haidar's request-completion
// trigger: observe the ChatGPT conversation POST the page already makes, then
// signal the unchanged upstream content script to inspect the rendered answer.
// No ChatGPT API polling or additional HTTP request is created here.
function normalizePathname(url) {
  try {
    return new URL(url).pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
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
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js']
    });
    await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    console.warn('Prompt-Bound Alert: could not arm tab completion watcher', error);
  }
}

chrome.webRequest.onCompleted.addListener((details) => {
  if (!isAnswerStreamRequest(details)) return;
  if (details.statusCode < 200 || details.statusCode >= 300) return;
  signalConversationRequestCompleted(details.tabId).catch(() => {});
}, CHATGPT_REQUEST_FILTER);

async function queryTerminalStatus(tabId, timeoutMs = STATUS_QUERY_TIMEOUT_MS) {
  const message = { type: 'CHATGPT_STATUS_CODE_QUERY', timeoutMs };
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['status-code.js', 'status-script.js']
    });
    return await chrome.tabs.sendMessage(tabId, message);
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

async function showCompletionFromUpstream(message, sender) {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') return null;

  const fingerprint = String(message?.fingerprint || '');
  if (fingerprint && lastNotificationFingerprintByTab.get(tabId) === fingerprint) return null;

  // Ram's unchanged content script intentionally normalizes response whitespace,
  // so the terminal-line eligibility check lives in a separate DOM layer that
  // preserves line boundaries. This adds no ChatGPT network traffic.
  const status = await queryTerminalStatus(tabId);
  const statusCode = String(status?.statusCode || '');
  if (!globalThis.ChatGPTNotifierStatusCode?.isStatusCode(statusCode)) return null;

  // Two duplicate completion messages may wait on the same DOM query at once.
  // Re-check immediately before claiming the notification so only one wins.
  if (fingerprint && lastNotificationFingerprintByTab.get(tabId) === fingerprint) return null;
  if (fingerprint) lastNotificationFingerprintByTab.set(tabId, fingerprint);

  const identity = await resolveConversationIdentity(sender.tab?.url || '', tabId);
  if (!identity) return null;

  const notificationId = crypto.randomUUID();
  const completedAt = new Date().toISOString();
  const notification = {
    id: notificationId,
    conversationId: identity.id,
    conversationUrl: identity.url,
    title: fullTabTitle(sender, message),
    preview: truncateResponse(status?.responseBody || message?.response),
    statusCode,
    completedAt
  };

  sendNative({ type: 'toast.show', notification });

  try {
    globalThis.__chatgptNotifierHistory?.rememberEligibleCompletion?.({
      historyId: notificationId,
      fingerprint,
      ...notification
    }).catch?.((error) => console.warn('Could not save eligible completion history', error));
  } catch (error) {
    console.warn('Could not save eligible completion history', error);
  }

  return notificationId;
}

async function handleNativeMessage(message) {
  if (!message || typeof message !== 'object') return;
  settleNativeRequest(message);

  if (message.installedExtensionVersion) {
    if (maybeReloadForInstalledVersion(String(message.installedExtensionVersion))) return;
  }

  if (message.type === 'host.ready') {
    await injectScriptsIntoExistingChatgptTabs();
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
      sendResponse?.({
        ok: true,
        notified: Boolean(notificationId),
        notificationId: notificationId || null
      });
    }).catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === 'CHATGPT_CONVERSATION_USER_INTERACTED') {
    dismissConversationForSender(message, sender).then((dismissed) => {
      sendResponse?.({ ok: dismissed });
    }).catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  // CHATGPT_PAGE_RETURNED belongs to the upstream extension's transient Chrome
  // notification lifecycle. Persistent helper notifications intentionally ignore it;
  // they dismiss only on deliberate interaction, clicking the toast, or its X button.
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

chrome.tabs.onRemoved.addListener((tabId) => {
  lastNotificationFingerprintByTab.delete(tabId);
});

connectNativeHost();
injectScriptsIntoExistingChatgptTabs().catch(() => {});
