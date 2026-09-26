'use strict';

(() => {
  const VERSION = 3;
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
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';

  const DEFAULT_TIMEOUT_MS = 1800;
  const SEND_CONFIRM_TIMEOUT_MS = 1500;

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

  function visibleEnough(node) {
    if (!node || node.isConnected === false || node.hidden === true) return false;
    if (node.getAttribute?.('aria-hidden') === 'true') return false;
    try { if (node.closest?.('[hidden], [aria-hidden="true"], [inert]')) return false; } catch {}
    try {
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')) return false;
    } catch {}
    return true;
  }

  function usableSendButton(button) {
    return Boolean(
      button
      && visibleEnough(button)
      && !button.disabled
      && button.getAttribute?.('aria-disabled') !== 'true'
    );
  }

  function composerScope(composer) {
    if (!composer) return document;
    try {
      return composer.closest?.('form')
        || composer.closest?.('[data-type="unified-composer"]')
        || composer.closest?.('[data-testid*="composer" i]')
        || composer.parentElement
        || document;
    } catch {
      return document;
    }
  }

  function appendCandidate(candidates, seen, button) {
    if (!usableSendButton(button) || seen.has(button)) return;
    seen.add(button);
    candidates.push(button);
  }

  function sendCandidates(root) {
    const candidates = [];
    const seen = new Set();
    try {
      for (const button of root?.querySelectorAll?.(SEND_BUTTON_SELECTOR) || []) {
        appendCandidate(candidates, seen, button);
      }
    } catch {}
    try {
      appendCandidate(candidates, seen, globalThis.__chatgptQuickContinueDomCompat?.fallbackSend?.(root));
    } catch {}
    return candidates;
  }

  function enabledSendButton(composer) {
    const scope = composerScope(composer);
    const scoped = sendCandidates(scope);
    if (scoped.length) return scoped[0];
    if (scope !== document) {
      const documentCandidates = sendCandidates(document);
      if (documentCandidates.length) return documentCandidates[documentCandidates.length - 1];
    }
    return null;
  }

  function closestSendButton(node) {
    if (!(node instanceof Element)) return null;
    let button = null;
    try { button = node.closest('button'); } catch {}
    if (!usableSendButton(button)) return null;
    try {
      if (button.matches?.(SEND_BUTTON_SELECTOR)) return button;
      if (globalThis.__chatgptQuickContinueDomCompat?.looksLikeSendButton?.(button)) return button;
    } catch {}
    return null;
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
          attributeFilter: ['disabled', 'aria-disabled', 'aria-hidden', 'hidden', 'data-testid', 'aria-label', 'contenteditable']
        });
      }

      timer = setTimeout(() => finish(null), Math.max(0, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
      void inspect();
    });
  }

  function latestUserTurnToken() {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(TURN_SELECTOR)); } catch {}
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const turn = nodes[index];
      let role = '';
      try {
        role = String(turn?.getAttribute?.('data-turn') || turn?.getAttribute?.('data-message-author-role') || '').toLowerCase();
        if (role !== 'user' && turn?.querySelector?.('[data-message-author-role="user"], [data-turn="user"]')) role = 'user';
      } catch {}
      if (role !== 'user') continue;
      const id = String(turn?.getAttribute?.('data-testid') || turn?.getAttribute?.('data-message-id') || turn?.id || '').trim();
      const text = String(turn?.innerText || turn?.textContent || '').replace(/\r\n?/g, '\n');
      return `${id || index}|${text}`;
    }
    return '';
  }

  function sendAccepted(previousUserToken) {
    const nextUserToken = latestUserTurnToken();
    if (nextUserToken && nextUserToken !== previousUserToken) return true;
    const composer = liveComposer();
    return Boolean(composer && composerApi.read(composer) === '');
  }

  function waitForSendAccepted(previousUserToken, timeoutMs = SEND_CONFIRM_TIMEOUT_MS) {
    const immediate = sendAccepted(previousUserToken);
    if (immediate) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let observer = null;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try { observer?.disconnect(); } catch {}
        if (timer !== null) clearTimeout(timer);
        resolve(value === true);
      };
      const inspect = () => {
        if (sendAccepted(previousUserToken)) finish(true);
      };
      const root = document.body || document.documentElement;
      if (root && typeof MutationObserver === 'function') {
        observer = new MutationObserver(inspect);
        observer.observe(root, { childList: true, subtree: true, characterData: true });
      }
      timer = setTimeout(() => finish(sendAccepted(previousUserToken)), Math.max(0, Number(timeoutMs) || SEND_CONFIRM_TIMEOUT_MS));
      inspect();
    });
  }

  function activateSend(composer, sendButton) {
    const form = sendButton?.form || composer?.closest?.('form') || null;
    if (form && typeof form.requestSubmit === 'function') {
      const type = String(sendButton?.getAttribute?.('type') || sendButton?.type || 'submit').toLowerCase();
      if (type !== 'button') {
        try {
          form.requestSubmit(sendButton);
          return 'request-submit';
        } catch {}
      }
    }
    sendButton.click();
    return 'button-click';
  }

  async function submit(composer, text, { replace = true, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    composer = liveComposer(composer);
    if (!composer) return { ok: false, reason: 'composer-not-found' };
    const expected = composerApi.normalize(text);
    if (!expected) return { ok: false, reason: 'empty-text' };
    const originalText = composerApi.read(composer);
    const previousUserToken = latestUserTurnToken();

    if (replace && !composerApi.replace(composer, expected)) {
      return { ok: false, reason: 'write-failed' };
    }
    if (!replace && originalText !== expected) {
      return { ok: false, reason: 'composer-mismatch' };
    }

    const ready = await waitForReady(composer, expected, originalText, replace, timeoutMs);
    if (!ready) return { ok: false, reason: 'send-not-ready' };

    // ChatGPT can remount the Lexical composer while an edit is committing. Never
    // validate a detached editor and then activate a Send control for another
    // editor. Reacquire both the editor and its authoritative enabled Send control
    // at the final boundary.
    await afterCommitBoundary();
    composer = liveComposer(ready.composer);
    if (!composer || composerApi.read(composer) !== expected) {
      return { ok: false, reason: 'composer-mismatch' };
    }
    const sendButton = enabledSendButton(composer);
    if (!sendButton) return { ok: false, reason: 'send-not-ready' };

    let activationMethod = '';
    try {
      activationMethod = activateSend(composer, sendButton);
    } catch {
      return { ok: false, reason: 'send-failed' };
    }

    const accepted = await waitForSendAccepted(previousUserToken);
    if (!accepted) {
      return { ok: false, reason: 'send-not-confirmed', activated: true, activationMethod };
    }
    return { ok: true, reason: 'sent', activated: true, activationMethod };
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
