'use strict';

(() => {
  const RUNTIME_VERSION = 1;
  try { globalThis.__chatgptQuickContinueDomCompat?.dispose?.(); } catch {}

  if (typeof Document === 'undefined' || typeof Element === 'undefined') return;

  const MESSAGE_ROLE_SELECTOR = [
    '[data-message-author-role="user"]',
    '[data-message-author-role="assistant"]',
    '[data-turn="user"]',
    '[data-turn="assistant"]'
  ].join(',');
  const LEGACY_COMPOSER_SELECTORS = new Set([
    '#prompt-textarea',
    'textarea[data-testid="prompt-textarea"]',
    '[contenteditable="true"][data-testid="prompt-textarea"]'
  ]);
  const LEGACY_SEND_SELECTOR_PARTS = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send"]'
  ];
  const LEGACY_SEND_SELECTORS = new Set(LEGACY_SEND_SELECTOR_PARTS);
  const LEGACY_SEND_SELECTOR = LEGACY_SEND_SELECTOR_PARTS.join(',');

  const nativeDocumentQuerySelector = Document.prototype.querySelector;
  const nativeDocumentQuerySelectorAll = Document.prototype.querySelectorAll;
  const nativeElementQuerySelector = Element.prototype.querySelector;
  const nativeElementQuerySelectorAll = Element.prototype.querySelectorAll;
  const nativeClosest = Element.prototype.closest;
  const nativeGetAttribute = Element.prototype.getAttribute;

  function nativeQueryAll(root, selector) {
    try {
      if (root instanceof Document) return Array.from(nativeDocumentQuerySelectorAll.call(root, selector));
      if (root instanceof Element) return Array.from(nativeElementQuerySelectorAll.call(root, selector));
    } catch {}
    return [];
  }

  function nativeAttribute(node, name) {
    try { return nativeGetAttribute.call(node, name); } catch { return null; }
  }

  function visibleEnough(node) {
    if (!node || node.isConnected === false) return false;
    if (node.hidden === true || nativeAttribute(node, 'aria-hidden') === 'true') return false;
    try {
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')) return false;
    } catch {}
    return true;
  }

  function usableComposer(node) {
    if (!visibleEnough(node)) return false;
    if (!(node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement || node.isContentEditable)) return false;
    if (node.disabled || nativeAttribute(node, 'aria-disabled') === 'true') return false;
    try { if (nativeClosest.call(node, MESSAGE_ROLE_SELECTOR)) return false; } catch {}
    return true;
  }

  function fallbackComposer(root) {
    const selectors = [
      '[contenteditable="true"][data-lexical-editor="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][data-placeholder]',
      'textarea[placeholder]',
      'form [contenteditable="true"]',
      'form textarea',
      '[contenteditable="true"]'
    ];
    for (const selector of selectors) {
      const candidates = nativeQueryAll(root, selector).filter(usableComposer);
      if (candidates.length) return candidates[candidates.length - 1];
    }
    return null;
  }

  function enabledButton(button) {
    return Boolean(
      button
      && visibleEnough(button)
      && !button.disabled
      && nativeAttribute(button, 'aria-disabled') !== 'true'
    );
  }

  function looksLikeSendButton(button) {
    if (!enabledButton(button)) return false;
    const testId = String(nativeAttribute(button, 'data-testid') || '').toLowerCase();
    const label = String(nativeAttribute(button, 'aria-label') || '').trim().toLowerCase();
    if (/^(send|send prompt|send message)$/.test(label)) return true;
    return /send[-_ ]?button|composer[-_ ]?send/.test(testId);
  }

  function fallbackSend(root) {
    for (const button of nativeQueryAll(root, 'button')) {
      if (looksLikeSendButton(button)) return button;
    }
    return null;
  }

  function compatibleQuery(root, selector, original) {
    let direct = null;
    try { direct = original.call(root, selector); } catch { return null; }
    if (direct) return direct;
    if (LEGACY_COMPOSER_SELECTORS.has(selector)) return fallbackComposer(root);
    if (LEGACY_SEND_SELECTORS.has(selector) || selector === LEGACY_SEND_SELECTOR) return fallbackSend(root);
    return null;
  }

  function notifierCompatDocumentQuerySelector(selector) {
    return compatibleQuery(this, String(selector || ''), nativeDocumentQuerySelector);
  }

  function notifierCompatElementQuerySelector(selector) {
    return compatibleQuery(this, String(selector || ''), nativeElementQuerySelector);
  }

  function notifierCompatClosest(selector) {
    const value = String(selector || '');
    let direct = null;
    try { direct = nativeClosest.call(this, selector); } catch { return null; }
    if (direct) return direct;
    if (!LEGACY_SEND_SELECTORS.has(value) && value !== LEGACY_SEND_SELECTOR) return null;

    let button = null;
    try { button = nativeClosest.call(this, 'button'); } catch {}
    return looksLikeSendButton(button) ? button : null;
  }

  Document.prototype.querySelector = notifierCompatDocumentQuerySelector;
  Element.prototype.querySelector = notifierCompatElementQuerySelector;
  Element.prototype.closest = notifierCompatClosest;

  const runtime = {
    version: RUNTIME_VERSION,
    fallbackComposer,
    fallbackSend,
    looksLikeSendButton,
    dispose() {
      if (Document.prototype.querySelector === notifierCompatDocumentQuerySelector) Document.prototype.querySelector = nativeDocumentQuerySelector;
      if (Element.prototype.querySelector === notifierCompatElementQuerySelector) Element.prototype.querySelector = nativeElementQuerySelector;
      if (Element.prototype.closest === notifierCompatClosest) Element.prototype.closest = nativeClosest;
      if (globalThis.__chatgptQuickContinueDomCompat === runtime) delete globalThis.__chatgptQuickContinueDomCompat;
    }
  };

  globalThis.__chatgptQuickContinueDomCompat = runtime;
})();
