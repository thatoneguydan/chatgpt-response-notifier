'use strict';

(() => {
  if (globalThis.__chatgptNotifierObservationRelay?.version === 1) return;

  function text(value) { return String(value || ''); }

  function identityMatches(current = {}, expected = {}) {
    return Boolean(
      current.conversationId && current.conversationId === text(expected.conversationId) &&
      current.documentId && current.documentId === text(expected.documentId) &&
      current.promptKey && current.promptKey === text(expected.promptKey) &&
      text(current.promptRevision) === text(expected.promptRevision) &&
      text(current.assistantKey) === text(expected.assistantKey) &&
      text(current.assistantRevision) === text(expected.assistantRevision)
    );
  }

  const listener = (message, _sender, sendResponse) => {
    if (message?.type !== 'CHATGPT_OBSERVATION_SYNTHETIC' || !message.snapshot) return false;
    const runtime = globalThis.__chatgptNotifierMonitorRuntime;
    const current = runtime?.snapshot?.();
    if (!current || !identityMatches(current, message.snapshot)) {
      sendResponse?.({ ok: false, reason: 'observation-identity-changed' });
      return false;
    }
    const synthetic = {
      ...current,
      ...message.snapshot,
      conversationId: current.conversationId,
      documentId: current.documentId,
      promptKey: current.promptKey,
      promptRevision: current.promptRevision,
      assistantKey: current.assistantKey,
      assistantRevision: current.assistantRevision,
      workerObservationSynthetic: true
    };
    try {
      chrome.runtime.sendMessage({ type: 'CHATGPT_MONITOR_STATE', snapshot: synthetic }).then(
        () => sendResponse?.({ ok: true }),
        () => sendResponse?.({ ok: false, reason: 'synthetic-observation-delivery-failed' })
      );
      return true;
    } catch {
      sendResponse?.({ ok: false, reason: 'synthetic-observation-delivery-failed' });
      return false;
    }
  };

  chrome.runtime.onMessage.addListener(listener);
  globalThis.__chatgptNotifierObservationRelay = Object.freeze({ version: 1, identityMatches });
})();
