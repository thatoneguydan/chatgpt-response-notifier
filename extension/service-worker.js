'use strict';

import {
  cleanSessionTitle,
  conversationFromUrl,
  truncatePreview
} from './lib/conversation.js';

const BRIDGE_URL = 'ws://127.0.0.1:38473/bridge';
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

function isAnswerStreamRequest(details) {
  if (details.tabId < 0 || details.method !== 'POST') return false;
  try {
    const path = new URL(details.url).pathname.replace(/\/+$/, '');
    return path === '/backend-api/f/conversation' || path === '/backend-api/conversation';
  } catch {
    return false;
  }
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
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-script.js'] });
    } catch {}
  }
}

async function signalConversationRequestCompleted(tabId) {
  const message = { type: 'CHATGPT_CONVERSATION_REQUEST_COMPLETED' };
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return;
  } catch {}

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] });
    await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    console.warn('Could not arm completion watcher', error);
  }
}

chrome.webRequest.onCompleted.addListener((details) => {
  if (!isAnswerStreamRequest(details)) return;
  if (details.statusCode < 200 || details.statusCode >= 300) return;
  signalConversationRequestCompleted(details.tabId).catch(() => {});
}, CHATGPT_REQUEST_FILTER);

async function isTabActuallyViewed(tab) {
  if (!tab?.active || typeof tab.windowId !== 'number') return false;
  try {
    const windowInfo = await chrome.windows.get(tab.windowId);
    return Boolean(windowInfo.focused);
  } catch {
    return false;
  }
}

async function dismissIfActuallyViewed(tab) {
  if (!(await isTabActuallyViewed(tab))) return false;
  const identity = conversationFromUrl(tab.url);
  if (!identity) return false;
  sendNative({ type: 'toast.dismissConversation', conversationId: identity.id });
  return true;
}

async function dismissReportedViewedConversation(message, sender) {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') return false;

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!(await isTabActuallyViewed(tab))) return false;
    const identity = conversationFromUrl(message.conversationUrl || tab.url);
    if (!identity) return false;
    sendNative({ type: 'toast.dismissConversation', conversationId: identity.id });
    return true;
  } catch {
    return false;
  }
}

async function dismissCurrentlyViewedConversations() {
  let activeTabs = [];
  try {
    activeTabs = await chrome.tabs.query({ active: true, url: ['https://chatgpt.com/*'] });
  } catch {
    return;
  }

  for (const tab of activeTabs) {
    try { await dismissIfActuallyViewed(tab); } catch {}
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url || !tab.active) return;
  dismissIfActuallyViewed(tab).catch(() => {});
});

async function resolveConversationIdentity(initialUrl, tabId) {
  let identity = conversationFromUrl(initialUrl);
  if (identity) return identity;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
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

async function focusOrOpenConversation(conversationId, conversationUrl) {
  const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
  const existing = tabs.find((tab) => conversationFromUrl(tab.url)?.id === conversationId);
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (typeof existing.windowId === 'number') {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url: conversationUrl, active: true });
  }
  sendNative({ type: 'toast.dismissConversation', conversationId });
}

async function handleNativeMessage(message) {
  if (!message || typeof message !== 'object') return;
  settleNativeRequest(message);

  if (message.installedExtensionVersion) {
    if (maybeReloadForInstalledVersion(String(message.installedExtensionVersion))) return;
  }

  if (message.type === 'host.ready') {
    await ensureContentScriptsInChatgptTabs();
    await dismissCurrentlyViewedConversations();
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
  if (message?.type === 'CHATGPT_CONVERSATION_VIEWED') {
    dismissReportedViewedConversation(message, sender).then((dismissed) => {
      sendResponse?.({ ok: dismissed });
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

      const notificationId = crypto.randomUUID();
      sendNative({
        type: 'toast.show',
        notification: {
          id: notificationId,
          conversationId: identity.id,
          conversationUrl: identity.url,
          title: cleanSessionTitle(message.sessionTitle),
          preview: truncatePreview(message.response),
          completedAt: new Date().toISOString()
        }
      });
      sendResponse?.({ ok: true, notificationId });
    }).catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
    return true;
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
          title: 'ChatGPT notifier test',
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
