'use strict';

(() => {
  const VERSION = 1;
  if (globalThis.ChatGPTQuickContinueSend?.version === VERSION) return;

  const composerApi = globalThis.ChatGPTQuickContinueComposer;
  if (!composerApi) return;

  const SEND_BUTTON_SELECTOR = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send"]'
  ].join(',');

  const DEFAULT_TIMEOUT_MS = 1800;

  function enabledSendButton(composer) {
    const root = composer?.closest?.('form') || document;
    let button = null;
    try {
      button = root.querySelector(SEND_BUTTON_SELECTOR)
        || (root !== document ? document.querySelector(SEND_BUTTON_SELECTOR) : null);
    } catch {}
    if (!button || button.disabled || button.getAttribute?.('aria-disabled') === 'true') return null;
    return button;
  }

  function closestSendButton(node) {
    if (!(node instanceof Element)) return null;
    let button = null;
    try { button = node.closest(SEND_BUTTON_SELECTOR); } catch {}
    if (!button || button.disabled || button.getAttribute?.('aria-disabled') === 'true') return null;
    return button;
  }

  function afterCommitBoundary() {
    return new Promise((resolve) => {
      const raf = globalThis.requestAnimationFrame;
      if (typeof raf === 'function' && document.visibilityState !== 'hidden') {
        raf(() => raf(resolve));
        return;
      }
      setTimeout(resolve, 32);
    });
  }

  async function waitForReady(composer, expectedText, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const expected = composerApi.normalize(expectedText);
    await afterCommitBoundary();

    const immediate = enabledSendButton(composer);
    if (immediate && composerApi.read(composer) === expected) return immediate;

    return new Promise((resolve) => {
      let settled = false;
      let observer = null;
      const root = composer?.closest?.('form') || document.body || document.documentElement;

      const finish = (button) => {
        if (settled) return;
        settled = true;
        try { observer?.disconnect(); } catch {}
        clearTimeout(timer);
        resolve(button || null);
      };

      const inspect = () => {
        if (composerApi.read(composer) !== expected) return;
        const button = enabledSendButton(composer);
        if (button) finish(button);
      };

      if (root && typeof MutationObserver === 'function') {
        observer = new MutationObserver(inspect);
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['disabled', 'aria-disabled', 'data-testid', 'aria-label']
        });
      }

      const timer = setTimeout(() => finish(null), Math.max(0, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
      inspect();
    });
  }

  async function submit(composer, text, { replace = true, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!composer) return { ok: false, reason: 'composer-not-found' };
    const expected = composerApi.normalize(text);
    if (!expected) return { ok: false, reason: 'empty-text' };

    if (replace && !composerApi.replace(composer, expected)) {
      return { ok: false, reason: 'write-failed' };
    }
    if (composerApi.read(composer) !== expected) {
      return { ok: false, reason: 'composer-mismatch' };
    }

    let sendButton = await waitForReady(composer, expected, timeoutMs);
    if (!sendButton) return { ok: false, reason: 'send-not-ready' };

    // The editor DOM and the send button can update before ChatGPT's React/Lexical
    // state has finished committing. Cross one more browser commit boundary, then
    // reacquire and revalidate both before issuing the one programmatic submit.
    await afterCommitBoundary();
    if (composerApi.read(composer) !== expected) {
      return { ok: false, reason: 'composer-mismatch' };
    }
    sendButton = enabledSendButton(composer);
    if (!sendButton) return { ok: false, reason: 'send-not-ready' };

    try {
      sendButton.click();
      return { ok: true, reason: 'sent' };
    } catch {
      return { ok: false, reason: 'send-failed' };
    }
  }

  globalThis.ChatGPTQuickContinueSend = Object.freeze({
    version: VERSION,
    selector: SEND_BUTTON_SELECTOR,
    enabledSendButton,
    closestSendButton,
    submit
  });
})();
