'use strict';

(() => {
  if (globalThis.__chatgptNotifierRecoveryLiveFix) return;

  const RUNTIME_VERSION = 1;
  const CONTENT_SCRIPT = 'recovery-live-fix-content.js';
  const INITIAL_CODED_NOTIFICATION_REASONS = new Set(['coded-completion', 'coded-completion-status-observer']);
  const previousSendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
  let queueHookInstalled = false;

  async function ensureContentRuntime(tabId) {
    if (!Number.isInteger(tabId)) return false;
    try {
      const ping = await previousSendMessage(tabId, { type: 'CHATGPT_RECOVERY_LIVE_PING' });
      if (ping?.ok === true && Number(ping.runtimeVersion || 0) >= RUNTIME_VERSION) return true;
    } catch {}
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
    } catch { return false; }
    try {
      const ping = await previousSendMessage(tabId, { type: 'CHATGPT_RECOVERY_LIVE_PING' });
      return ping?.ok === true;
    } catch { return false; }
  }

  async function inspectExplicitInterruption(tabId) {
    if (!(await ensureContentRuntime(tabId))) return null;
    try {
      const result = await previousSendMessage(tabId, { type: 'CHATGPT_RECOVERY_LIVE_INSPECT' });
      return result?.ok === true ? result : null;
    } catch { return null; }
  }

  async function republishExplicitInterruption(tabId) {
    if (!(await ensureContentRuntime(tabId))) return false;
    try {
      const result = await previousSendMessage(tabId, { type: 'CHATGPT_RECOVERY_LIVE_REPUBLISH' });
      return result?.published === true;
    } catch { return false; }
  }

  chrome.tabs.sendMessage = async function recoveryAwareSendMessage(tabId, message, ...rest) {
    const result = await previousSendMessage(tabId, message, ...rest);
    if (message?.type !== 'CHATGPT_MONITOR_QUERY') return result;
    const interruption = await inspectExplicitInterruption(tabId);
    if (interruption?.explicitInterruption !== true) return result;
    const patch = {
      explicitInterruption: true,
      interruptionKind: String(interruption.interruptionKind || 'explicit-interruption')
    };
    if (result?.snapshot && typeof result.snapshot === 'object') {
      const snapshot = { ...result.snapshot, ...patch };
      return { ...result, ...patch, snapshot };
    }
    return result && typeof result === 'object' ? { ...result, ...patch } : result;
  };

  async function activeChatTabId() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: ['https://chatgpt.com/*'] });
      return Number.isInteger(tabs?.[0]?.id) ? tabs[0].id : null;
    } catch { return null; }
  }

  chrome.runtime.onMessage.addListener((message) => {
    const enableMessage = message?.enabled === true && [
      'SET_BUILD_AUTOMATION_STATE',
      'SET_ACTIVE_CHAT_MONITORING',
      'SET_ACTIVE_CHAT_RECOVERY',
      'RESUME_ACTIVE_CHAT_RECOVERY'
    ].includes(String(message?.type || ''));
    if (!enableMessage) return false;
    setTimeout(async () => {
      const tabId = Number.isInteger(message?.tabId) ? message.tabId : await activeChatTabId();
      if (Number.isInteger(tabId)) await republishExplicitInterruption(tabId);
    }, 250);
    return false;
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !String(tab?.url || '').startsWith('https://chatgpt.com/')) return;
    ensureContentRuntime(tabId).then(() => republishExplicitInterruption(tabId)).catch(() => {});
  });

  async function injectExistingTabs() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); } catch { return; }
    for (const tab of tabs) {
      if (!Number.isInteger(tab?.id) || tab.discarded === true || tab.frozen === true) continue;
      ensureContentRuntime(tab.id).then(() => republishExplicitInterruption(tab.id)).catch(() => {});
    }
  }

  function statusFromRecord(record) {
    return {
      conversationId: String(record?.conversationId || ''),
      conversationUrl: String(record?.conversationUrl || ''),
      documentId: String(record?.documentId || record?.ownerDocumentId || ''),
      promptKey: String(record?.promptKey || ''),
      assistantKey: String(record?.assistantKey || ''),
      revision: String(record?.revision || ''),
      statusCode: String(record?.statusCode || ''),
      statusLine: String(record?.statusLine || ''),
      responseBody: String(record?.responseBody || ''),
      responseText: String(record?.responseText || '')
    };
  }

  function installQueueHook(attempt = 0) {
    if (queueHookInstalled) return;
    const originalQueue = globalThis.queueDurableNotification;
    const continuationHandler = globalThis.handleContinuationClaim;
    if (typeof originalQueue !== 'function' || typeof continuationHandler !== 'function') {
      if (attempt < 80) setTimeout(() => installQueueHook(attempt + 1), 25);
      return;
    }
    if (originalQueue.__chatgptNotifierRecoverableStatusHook === true) {
      queueHookInstalled = true;
      return;
    }

    const wrapped = async function queueRecoverableStatus(record, reason, ...rest) {
      const statusCode = String(record?.statusCode || '');
      const recoverable = globalThis.ChatGPTNotifierContinuationPolicy?.isAutoContinueStatusCode?.(statusCode) === true;
      if (recoverable && statusCode !== 'INCOMPLETE_LIMIT' && INITIAL_CODED_NOTIFICATION_REASONS.has(String(reason || ''))) {
        return await continuationHandler(
          record,
          statusFromRecord(record),
          Number.isInteger(record?.ownerTabId) ? record.ownerTabId : null,
          String(record?.ownerDocumentId || record?.documentId || '')
        );
      }
      return await originalQueue(record, reason, ...rest);
    };
    Object.defineProperty(wrapped, '__chatgptNotifierRecoverableStatusHook', { value: true });
    globalThis.queueDurableNotification = wrapped;
    queueHookInstalled = true;
  }

  setTimeout(() => {
    installQueueHook();
    injectExistingTabs().catch(() => {});
  }, 0);

  globalThis.__chatgptNotifierRecoveryLiveFix = Object.freeze({
    version: RUNTIME_VERSION,
    ensureContentRuntime,
    inspectExplicitInterruption,
    republishExplicitInterruption,
    installQueueHook
  });
})();
