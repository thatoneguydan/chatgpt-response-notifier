'use strict';

(() => {
  if (globalThis.__chatgptNotifierMonitorQueryCompat) return;
  const originalSendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);

  chrome.tabs.sendMessage = async function normalizedMonitorSendMessage(tabId, message, ...rest) {
    const result = await originalSendMessage(tabId, message, ...rest);
    if (message?.type !== 'CHATGPT_MONITOR_QUERY' || !result?.snapshot || result.conversationId) return result;
    return { ...result.snapshot, ...result, snapshot: result.snapshot };
  };

  globalThis.__chatgptNotifierMonitorQueryCompat = Object.freeze({ version: 1 });
})();
