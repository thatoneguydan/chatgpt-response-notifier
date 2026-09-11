'use strict';

(() => {
  if (globalThis.__chatgptNotifierPersistenceInstalled) return;
  globalThis.__chatgptNotifierPersistenceInstalled = true;

  let lastSignalAt = 0;
  let lastSignalUrl = '';

  function signalInteraction(event) {
    if (event?.isTrusted === false) return;

    const now = Date.now();
    const url = location.href;
    if (url === lastSignalUrl && now - lastSignalAt < 750) return;
    lastSignalAt = now;
    lastSignalUrl = url;

    try {
      chrome.runtime.sendMessage({
        type: 'CHATGPT_CONVERSATION_USER_INTERACTED',
        conversationUrl: url
      }).catch(() => {});
    } catch {}
  }

  document.addEventListener('pointerdown', signalInteraction, { capture: true, passive: true });
  document.addEventListener('keydown', signalInteraction, { capture: true, passive: true });
})();
