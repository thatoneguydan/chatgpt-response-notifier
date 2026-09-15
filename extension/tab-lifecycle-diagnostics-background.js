'use strict';

(() => {
  if (globalThis.__chatgptNotifierTabLifecycleDiagnostics) return;

  const REQUEST_FILTER = {
    urls: [
      'https://chatgpt.com/backend-api/f/conversation*',
      'https://chatgpt.com/backend-api/conversation*'
    ]
  };

  function conversationRequest(details) {
    if (!Number.isInteger(details?.tabId) || details.tabId < 0 || details.method !== 'POST') return false;
    try {
      const path = new URL(details.url).pathname.replace(/\/+$/, '');
      return path === '/backend-api/f/conversation' || path === '/backend-api/conversation';
    } catch {
      return false;
    }
  }

  function chatgptConversationUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''));
      return ['chatgpt.com', 'www.chatgpt.com'].includes(url.hostname) && /\/c\/[^/]+/.test(url.pathname);
    } catch {
      return false;
    }
  }

  function record(status, tabId, tab = null, reason = '') {
    try {
      globalThis.__chatgptNotifierDeliveryDiagnostics?.record?.(status, {
        tabId,
        reason: reason || `frozen=${tab?.frozen === true};discarded=${tab?.discarded === true};active=${tab?.active === true}`
      });
    } catch {}
  }

  async function recordCurrent(status, tabId) {
    if (!Number.isInteger(tabId) || tabId < 0) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!chatgptConversationUrl(tab?.url)) return;
      record(status, tabId, tab);
    } catch {
      record(`${status}-unavailable`, tabId, null, 'tab-state-unavailable');
    }
  }

  chrome.webRequest.onCompleted.addListener((details) => {
    if (!conversationRequest(details)) return;
    recordCurrent('request-completed-tab-lifecycle', details.tabId).catch(() => {});
  }, REQUEST_FILTER);

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!Object.prototype.hasOwnProperty.call(changeInfo || {}, 'frozen') &&
        !Object.prototype.hasOwnProperty.call(changeInfo || {}, 'discarded')) return;
    if (!chatgptConversationUrl(tab?.url)) return;
    record('tab-lifecycle-change', tabId, tab);
  });

  globalThis.__chatgptNotifierTabLifecycleDiagnostics = Object.freeze({ version: 1 });
})();
