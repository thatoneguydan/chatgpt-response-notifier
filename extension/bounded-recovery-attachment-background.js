'use strict';

(() => {
  if (globalThis.__chatgptNotifierBoundedRecoveryAttachment) return;
  globalThis.__chatgptNotifierBoundedRecoveryAttachment = true;

  const RUNTIME_VERSION = 2;
  const CHATGPT_URL = /^https:\/\/chatgpt\.com\//i;
  const previousSendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);

  async function ensureRecoveryPageRuntime(tabId) {
    if (!Number.isInteger(tabId)) return false;
    try {
      const ping = await previousSendMessage(tabId, { type: 'CHATGPT_BOUNDED_RECOVERY_PING' });
      if (ping?.ok === true && Number(ping.runtimeVersion || 0) >= 3) return true;
    } catch {}
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!CHATGPT_URL.test(String(tab?.url || '')) || tab.discarded === true || tab.frozen === true) return false;
      // The supporting status/policy/monitor scripts are manifest content scripts.
      // Re-inject only the action runtime so its document identity cannot diverge
      // from the monitor identity immediately before an automatic send.
      await chrome.scripting.executeScript({ target: { tabId }, files: ['bounded-recovery-script.js'] });
    } catch { return false; }
    try {
      const ping = await previousSendMessage(tabId, { type: 'CHATGPT_BOUNDED_RECOVERY_PING' });
      return ping?.ok === true && Number(ping.runtimeVersion || 0) >= 3;
    } catch { return false; }
  }

  async function recoveryClass(expected = {}) {
    const conversationId = String(expected?.conversationId || '');
    if (!conversationId) return { recoveryClass: 'silent-stop', recoveryReason: '' };
    let reason = '';
    try {
      const overview = await globalThis.__chatgptNotifierBoundedRecovery?.overview?.(conversationId);
      reason = String(overview?.incident?.reason || '');
    } catch {}
    const model = globalThis.ChatGPTNotifierRecoveryModel;
    const explicitReasons = new Set([
      ...(Array.isArray(model?.explicitReloadReasons) ? model.explicitReloadReasons : []),
      String(model?.postReloadExplicitReason || '')
    ].filter(Boolean));
    return {
      recoveryClass: explicitReasons.has(reason) ? 'explicit-interruption' : 'silent-stop',
      recoveryReason: reason
    };
  }

  chrome.tabs.sendMessage = async function recoveryCommandAwareSendMessage(tabId, message, ...rest) {
    if (message?.type !== 'CHATGPT_BOUNDED_RECOVERY_COMMAND') {
      return await previousSendMessage(tabId, message, ...rest);
    }
    if (!(await ensureRecoveryPageRuntime(tabId))) {
      throw new Error('bounded-recovery-page-runtime-unavailable');
    }
    const recovery = await recoveryClass(message?.expected || {});
    return await previousSendMessage(tabId, {
      ...message,
      expected: {
        ...(message?.expected || {}),
        ...recovery
      }
    }, ...rest);
  };

  async function attachToExistingTabs() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); } catch { return; }
    for (const tab of tabs) {
      if (!Number.isInteger(tab?.id) || tab.discarded === true || tab.frozen === true) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['status-code.js', 'status-policy.js', 'monitor-script.js', 'bounded-recovery-script.js']
        });
      } catch {}
    }
  }

  globalThis.__chatgptNotifierBoundedRecoveryAttach = Object.freeze({
    version: RUNTIME_VERSION,
    attachToExistingTabs,
    ensureRecoveryPageRuntime,
    recoveryClass
  });
  attachToExistingTabs().catch(() => {});
})();