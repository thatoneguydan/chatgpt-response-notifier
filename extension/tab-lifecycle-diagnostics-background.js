'use strict';

(() => {
  if (globalThis.__chatgptNotifierTabLifecycleDiagnostics) return;

  const REQUEST_FILTER = {
    urls: [
      'https://chatgpt.com/backend-api/f/conversation*',
      'https://chatgpt.com/backend-api/conversation*'
    ]
  };
  const activeCompletionProbes = new Set();

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

  async function probeTerminalStatusAtRequestSettlement(details, settlement = 'completion') {
    if (!conversationRequest(details)) return;
    const isErrorSettlement = settlement === 'error';
    if (!isErrorSettlement && (details.statusCode < 200 || details.statusCode >= 300)) return;
    const probePrefix = isErrorSettlement ? 'request-error-status-probe' : 'request-completion-status-probe';
    const chromeDocumentId = String(details.documentId || '');
    if (!chromeDocumentId) {
      record(`${probePrefix}-unroutable`, details.tabId, null, 'chrome-document-id-missing');
      return;
    }

    const probeKey = `${details.tabId}|${String(details.requestId || '')}|${chromeDocumentId}`;
    if (activeCompletionProbes.has(probeKey)) return;
    activeCompletionProbes.add(probeKey);
    try {
      let tab = null;
      try { tab = await chrome.tabs.get(details.tabId); } catch {}
      if (!tab || !chatgptConversationUrl(tab.url)) return;
      if (tab.frozen === true || tab.discarded === true) {
        record(`${probePrefix}-deferred`, details.tabId, tab, 'tab-temporarily-unavailable');
        return;
      }

      const deliveryHook = globalThis.__chatgptNotifierNormalContinuationBudgetHook;
      if (typeof deliveryHook?.scheduleObservedStatusDelivery !== 'function' || typeof queryTerminalStatus !== 'function') {
        record(`${probePrefix}-unavailable`, details.tabId, tab, 'status-probe-runtime-unavailable');
        return;
      }

      // A ChatGPT streaming request can terminate through webRequest.onErrorOccurred
      // even after the assistant response and terminal status footer have rendered.
      // Probe the rendered DOM for either settlement path so transport teardown or
      // an extension/runtime replacement cannot silently skip notification delivery.
      // queryTerminalStatus is local MutationObserver-driven observation only; this
      // does not poll ChatGPT or create another conversation request.
      const status = await queryTerminalStatus(details.tabId, chromeDocumentId, 30_000);
      const statusCode = String(status?.statusCode || '');
      if (!globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(statusCode)) {
        record(`${probePrefix}-no-terminal-code`, details.tabId, tab, 'terminal-code-not-observed');
        return;
      }

      try { tab = await chrome.tabs.get(details.tabId); } catch { return; }
      if (!tab || tab.frozen === true || tab.discarded === true || !chatgptConversationUrl(tab.url)) return;

      const snapshot = {
        conversationId: String(status.conversationId || ''),
        conversationUrl: String(status.conversationUrl || tab.url || ''),
        documentId: String(status.documentId || ''),
        promptKey: String(status.promptKey || ''),
        promptRevision: String(status.promptRevision || ''),
        assistantKey: String(status.assistantKey || ''),
        assistantRevision: String(status.revision || ''),
        statusCode
      };
      if (!snapshot.conversationId || !snapshot.promptKey || !snapshot.assistantKey || !snapshot.assistantRevision) {
        record(`${probePrefix}-unroutable`, details.tabId, tab, 'terminal-identity-incomplete');
        return;
      }

      record(`${probePrefix}-observed`, details.tabId, tab, `status=${statusCode}`);
      await deliveryHook.scheduleObservedStatusDelivery(
        { type: 'CHATGPT_MONITOR_STATE', snapshot },
        { tab, documentId: chromeDocumentId }
      );
    } catch {
      record(`${probePrefix}-error`, details.tabId, null, 'status-probe-failed');
    } finally {
      activeCompletionProbes.delete(probeKey);
    }
  }

  function probeTerminalStatusAtRequestCompletion(details) {
    return probeTerminalStatusAtRequestSettlement(details, 'completion');
  }

  chrome.webRequest.onCompleted.addListener((details) => {
    if (!conversationRequest(details)) return;
    recordCurrent('request-completed-tab-lifecycle', details.tabId).catch(() => {});
    probeTerminalStatusAtRequestSettlement(details, 'completion').catch(() => {});
  }, REQUEST_FILTER);

  chrome.webRequest.onErrorOccurred.addListener((details) => {
    if (!conversationRequest(details)) return;
    recordCurrent('request-error-tab-lifecycle', details.tabId).catch(() => {});
    probeTerminalStatusAtRequestSettlement(details, 'error').catch(() => {});
  }, REQUEST_FILTER);

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!Object.prototype.hasOwnProperty.call(changeInfo || {}, 'frozen') &&
        !Object.prototype.hasOwnProperty.call(changeInfo || {}, 'discarded')) return;
    if (!chatgptConversationUrl(tab?.url)) return;
    record('tab-lifecycle-change', tabId, tab);
  });

  globalThis.__chatgptNotifierTabLifecycleDiagnostics = Object.freeze({
    version: 3,
    probeTerminalStatusAtRequestCompletion,
    probeTerminalStatusAtRequestSettlement
  });
})();