'use strict';

(() => {
  const VERSION = 2;
  if (globalThis.ChatGPTQuickContinueSend?.version === VERSION) return;

  const composerApi = globalThis.ChatGPTQuickContinueComposer;
  if (!composerApi) return;

  const COMPOSER_SELECTORS = Object.freeze([
    '#prompt-textarea',
    'textarea[data-testid="prompt-textarea"]',
    '[contenteditable="true"][data-testid="prompt-textarea"]'
  ]);
  const SEND_BUTTON_SELECTOR = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send"]'
  ].join(',');

  const DEFAULT_TIMEOUT_MS = 1800;

  function usableComposer(node) {
    if (!node || node.isConnected === false) return false;
    if (node.disabled || node.getAttribute?.('aria-disabled') === 'true') return false;
    const isTextarea = typeof HTMLTextAreaElement !== 'undefined' && node instanceof HTMLTextAreaElement;
    const isInput = typeof HTMLInputElement !== 'undefined' && node instanceof HTMLInputElement;
    return Boolean(isTextarea || isInput || node.isContentEditable || typeof node.closest === 'function');
  }

  function liveComposer(previous = null) {
    for (const selector of COMPOSER_SELECTORS) {
      let candidate = null;
      try { candidate = document.querySelector(selector); } catch {}
      if (usableComposer(candidate)) return candidate;
    }
    return usableComposer(previous) ? previous : null;
  }

  function enabledSendButton(composer) {
    const root = composer?.closest?.('form') || document;
    let button = null;
    try {
      button = root.querySelector(SEND_BUTTON_SELECTOR)
        || (root !== document ? document.querySelector(SEND_BUTTON_SELECTOR) : null);
    } catch {}
    if (!button || button.isConnected === false || button.disabled || button.getAttribute?.('aria-disabled') === 'true') return null;
    return button;
  }

  function closestSendButton(node) {
    if (!(node instanceof Element)) return null;
    let button = null;
    try { button = node.closest(SEND_BUTTON_SELECTOR); } catch {}
    if (!button || button.isConnected === false || button.disabled || button.getAttribute?.('aria-disabled') === 'true') return null;
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

  async function settleExpectedComposer(previous, expected, originalText, allowReapply) {
    await afterCommitBoundary();
    let composer = liveComposer(previous);
    if (!composer) return null;
    if (composerApi.read(composer) === expected) return composer;

    if (!allowReapply || composerApi.read(composer) !== originalText) return null;
    if (!composerApi.replace(composer, expected)) return null;

    await afterCommitBoundary();
    composer = liveComposer(composer);
    if (!composer || composerApi.read(composer) !== expected) return null;
    return composer;
  }

  function waitForReady(previous, expectedText, originalText, allowReapply, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const expected = composerApi.normalize(expectedText);

    return new Promise((resolve) => {
      let settled = false;
      let observer = null;
      let timer = null;
      let inspecting = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        try { observer?.disconnect(); } catch {}
        if (timer !== null) clearTimeout(timer);
        resolve(result || null);
      };

      const inspect = async () => {
        if (settled || inspecting) return;
        inspecting = true;
        try {
          const composer = await settleExpectedComposer(previous, expected, originalText, allowReapply);
          if (!composer) return;
          previous = composer;
          const button = enabledSendButton(composer);
          if (button) finish({ composer, button });
        } finally {
          inspecting = false;
        }
      };

      const root = document.body || document.documentElement;
      if (root && typeof MutationObserver === 'function') {
        observer = new MutationObserver(() => { void inspect(); });
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['disabled', 'aria-disabled', 'data-testid', 'aria-label', 'contenteditable']
        });
      }

      timer = setTimeout(() => finish(null), Math.max(0, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
      void inspect();
    });
  }

  async function submit(composer, text, { replace = true, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    composer = liveComposer(composer);
    if (!composer) return { ok: false, reason: 'composer-not-found' };
    const expected = composerApi.normalize(text);
    if (!expected) return { ok: false, reason: 'empty-text' };
    const originalText = composerApi.read(composer);

    if (replace && !composerApi.replace(composer, expected)) {
      return { ok: false, reason: 'write-failed' };
    }
    if (!replace && originalText !== expected) {
      return { ok: false, reason: 'composer-mismatch' };
    }

    const ready = await waitForReady(composer, expected, originalText, replace, timeoutMs);
    if (!ready) return { ok: false, reason: 'send-not-ready' };

    // ChatGPT can remount the Lexical composer while an edit is committing. Never
    // validate a detached editor and then click Send for a different live editor.
    // Cross one more commit boundary, reacquire the current composer, and require
    // the exact expected text on that live node immediately before the one click.
    await afterCommitBoundary();
    composer = liveComposer(ready.composer);
    if (!composer || composerApi.read(composer) !== expected) {
      return { ok: false, reason: 'composer-mismatch' };
    }
    const sendButton = enabledSendButton(composer);
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
    composerSelectors: COMPOSER_SELECTORS,
    liveComposer,
    enabledSendButton,
    closestSendButton,
    submit
  });
})();
