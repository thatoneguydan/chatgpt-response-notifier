'use strict';

(() => {
  if (globalThis.__chatgptNotifierWatchdogRequestStartRearm) return;

  const VERSION = 1;
  const REQUEST_FILTER = {
    urls: [
      'https://chatgpt.com/backend-api/f/conversation*',
      'https://chatgpt.com/backend-api/conversation*'
    ]
  };

  function answerStreamRequest(details) {
    if (!details || details.tabId < 0 || details.method !== 'POST') return false;
    try {
      const path = new URL(String(details.url || '')).pathname.replace(/\/+$/, '');
      return path === '/backend-api/f/conversation' || path === '/backend-api/conversation';
    } catch {
      return false;
    }
  }

  async function rearmFromRequestStart(details) {
    if (!answerStreamRequest(details)) return false;
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    if (!monitor) return false;

    let tab = null;
    try { tab = await chrome.tabs.get(details.tabId); } catch { return false; }
    const target = monitor.chatTargetFromTab?.(tab) || null;
    if (!target?.id || !Number.isInteger(target?.tab?.id)) return false;

    const enrollment = await monitor.getEnrollment?.(target.id);
    if (enrollment?.enabled !== true || enrollment?.userPaused === true) return false;

    const current = await monitor.readCodeWatchdog?.(target.id);
    if (!current?.stopped || !String(current.stopReason || '').startsWith('status:')) return false;

    const observedAt = Math.max(0, Number(details.timeStamp || 0), Date.now());
    if (observedAt <= Math.max(0, Number(current.lastRequestStartedAt || 0))) return false;

    // The network request is authoritative evidence of a new user interaction
    // even before ChatGPT renders the new user turn. Give the existing arm path a
    // temporary request identity so the prior terminal prompt cannot veto the
    // fresh 30-minute epoch. The normal monitor snapshot replaces this temporary
    // identity with the rendered prompt key as soon as the DOM catches up.
    const requestToken = String(details.requestId || observedAt);
    const result = await monitor.armCodeWatchdogForTarget?.({
      conversationId: target.id,
      promptKey: `${target.id}|request-start:${requestToken}`,
      source: 'request-start-terminal-rearm',
      requestId: `request-start:${requestToken}`
    }, target);
    return result?.ok === true;
  }

  const listener = (details) => {
    rearmFromRequestStart(details).catch(() => false);
  };
  chrome.webRequest.onBeforeRequest.addListener(listener, REQUEST_FILTER);

  globalThis.__chatgptNotifierWatchdogRequestStartRearm = Object.freeze({
    version: VERSION,
    rearmFromRequestStart,
    dispose() {
      try { chrome.webRequest.onBeforeRequest.removeListener(listener); } catch {}
      if (globalThis.__chatgptNotifierWatchdogRequestStartRearm?.version === VERSION) {
        delete globalThis.__chatgptNotifierWatchdogRequestStartRearm;
      }
    }
  });
})();
