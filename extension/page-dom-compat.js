'use strict';

(() => {
  const RUNTIME_VERSION = 1;
  try { globalThis.__chatgptNotifierPageDomCompat?.dispose?.(); } catch {}

  if (typeof Document === 'undefined' || typeof Element === 'undefined') return;

  const LEGACY_TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const SEMANTIC_ROLE_SELECTOR = [
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
  const LEGACY_SEND_SELECTORS = new Set([
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send"]'
  ]);
  const LEGACY_STOP_SELECTOR = 'button[data-testid="stop-button"], button[data-testid="fruitjuice-stop-button"], button[aria-label="Stop generating"]';

  const nativeDocumentQuerySelector = Document.prototype.querySelector;
  const nativeDocumentQuerySelectorAll = Document.prototype.querySelectorAll;
  const nativeElementQuerySelector = Element.prototype.querySelector;
  const nativeElementQuerySelectorAll = Element.prototype.querySelectorAll;
  const nativeClosest = Element.prototype.closest;
  const nativeGetAttribute = Element.prototype.getAttribute;

  function nativeQuery(root, selector) {
    try {
      if (root instanceof Document) return nativeDocumentQuerySelector.call(root, selector);
      if (root instanceof Element) return nativeElementQuerySelector.call(root, selector);
    } catch {}
    return null;
  }

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

  function nativeClosestTo(node, selector) {
    try { return nativeClosest.call(node, selector); } catch { return null; }
  }

  function semanticRole(node) {
    const value = String(
      nativeAttribute(node, 'data-message-author-role')
      || nativeAttribute(node, 'data-turn')
      || ''
    ).toLowerCase();
    return value === 'user' || value === 'assistant' ? value : '';
  }

  function compareDomOrder(left, right) {
    if (left === right) return 0;
    try {
      const position = left.compareDocumentPosition(right);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    } catch {}
    return 0;
  }

  function compatibleTurns(root) {
    const legacy = nativeQueryAll(root, LEGACY_TURN_SELECTOR);
    const roles = nativeQueryAll(root, SEMANTIC_ROLE_SELECTOR).filter((node) => semanticRole(node));
    if (!roles.length) return legacy;

    const combined = [...legacy];
    for (const roleNode of roles) {
      if (legacy.some((turn) => turn === roleNode || turn.contains?.(roleNode))) continue;
      const sameRoleAncestor = nativeClosestTo(roleNode.parentElement || roleNode, `[data-message-author-role="${semanticRole(roleNode)}"], [data-turn="${semanticRole(roleNode)}"]`);
      if (sameRoleAncestor && sameRoleAncestor !== roleNode) continue;
      combined.push(roleNode);
    }
    return Array.from(new Set(combined)).sort(compareDomOrder);
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
    if (nativeClosestTo(node, SEMANTIC_ROLE_SELECTOR)) return false;
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
    const candidates = [];
    for (const selector of selectors) {
      for (const node of nativeQueryAll(root, selector)) {
        if (usableComposer(node)) candidates.push(node);
      }
      if (candidates.length) break;
    }
    return candidates[candidates.length - 1] || null;
  }

  function enabledButton(button) {
    return Boolean(button && visibleEnough(button) && !button.disabled && nativeAttribute(button, 'aria-disabled') !== 'true');
  }

  function fallbackSend(root) {
    const candidates = nativeQueryAll(root, 'button').filter(enabledButton);
    for (const button of candidates) {
      const testId = String(nativeAttribute(button, 'data-testid') || '').toLowerCase();
      const label = String(nativeAttribute(button, 'aria-label') || '').trim().toLowerCase();
      if (/^(send|send prompt|send message)$/.test(label)) return button;
      if (/send[-_ ]?button|composer[-_ ]?send/.test(testId)) return button;
    }
    return null;
  }

  function fallbackStop(root) {
    const buttons = nativeQueryAll(root, 'button');
    for (const button of buttons) {
      if (!visibleEnough(button)) continue;
      const testId = String(nativeAttribute(button, 'data-testid') || '').toLowerCase();
      const label = String(nativeAttribute(button, 'aria-label') || '').trim().toLowerCase();
      if (/^stop(?: generating| response)?$/.test(label)) return button;
      if (/stop[-_ ]?(button|generating|response)/.test(testId)) return button;
    }
    return null;
  }

  function compatibleQuery(root, selector, original) {
    const direct = original.call(root, selector);
    if (direct) return direct;
    if (LEGACY_COMPOSER_SELECTORS.has(selector)) return fallbackComposer(root);
    if (LEGACY_SEND_SELECTORS.has(selector)) return fallbackSend(root);
    if (selector === LEGACY_STOP_SELECTOR) return fallbackStop(root);
    return null;
  }

  Document.prototype.querySelector = function notifierCompatDocumentQuerySelector(selector) {
    return compatibleQuery(this, String(selector || ''), nativeDocumentQuerySelector);
  };

  Element.prototype.querySelector = function notifierCompatElementQuerySelector(selector) {
    return compatibleQuery(this, String(selector || ''), nativeElementQuerySelector);
  };

  Document.prototype.querySelectorAll = function notifierCompatDocumentQuerySelectorAll(selector) {
    const value = String(selector || '');
    if (value === LEGACY_TURN_SELECTOR) return compatibleTurns(this);
    return nativeDocumentQuerySelectorAll.call(this, selector);
  };

  Element.prototype.querySelectorAll = function notifierCompatElementQuerySelectorAll(selector) {
    const value = String(selector || '');
    if (value === LEGACY_TURN_SELECTOR) return compatibleTurns(this);
    return nativeElementQuerySelectorAll.call(this, selector);
  };

  Element.prototype.closest = function notifierCompatClosest(selector) {
    const value = String(selector || '');
    const direct = nativeClosest.call(this, selector);
    if (direct || value !== LEGACY_TURN_SELECTOR) return direct;
    return nativeClosestTo(this, SEMANTIC_ROLE_SELECTOR);
  };

  Element.prototype.getAttribute = function notifierCompatGetAttribute(name) {
    const value = nativeGetAttribute.call(this, name);
    if (value != null || String(name || '').toLowerCase() !== 'data-testid') return value;
    const role = semanticRole(this);
    if (!role) return value;

    const messageId = String(
      nativeAttribute(this, 'data-message-id')
      || nativeAttribute(this, 'data-turn-id')
      || ''
    ).trim();
    if (messageId) return `conversation-turn-${messageId}`;

    const roles = nativeQueryAll(document, SEMANTIC_ROLE_SELECTOR).filter((node) => semanticRole(node));
    const index = Math.max(0, roles.indexOf(this));
    return `conversation-turn-compat-${role}-${index}`;
  };

  const runtime = {
    version: RUNTIME_VERSION,
    compatibleTurns,
    fallbackComposer,
    fallbackSend,
    fallbackStop,
    dispose() {
      if (Document.prototype.querySelector === notifierCompatDocumentQuerySelector) Document.prototype.querySelector = nativeDocumentQuerySelector;
      if (Document.prototype.querySelectorAll === notifierCompatDocumentQuerySelectorAll) Document.prototype.querySelectorAll = nativeDocumentQuerySelectorAll;
      if (Element.prototype.querySelector === notifierCompatElementQuerySelector) Element.prototype.querySelector = nativeElementQuerySelector;
      if (Element.prototype.querySelectorAll === notifierCompatElementQuerySelectorAll) Element.prototype.querySelectorAll = nativeElementQuerySelectorAll;
      if (Element.prototype.closest === notifierCompatClosest) Element.prototype.closest = nativeClosest;
      if (Element.prototype.getAttribute === notifierCompatGetAttribute) Element.prototype.getAttribute = nativeGetAttribute;
      if (globalThis.__chatgptNotifierPageDomCompat === runtime) delete globalThis.__chatgptNotifierPageDomCompat;
    }
  };

  // Named declarations are intentionally used so dispose() can compare function identities.
  function notifierCompatDocumentQuerySelector(selector) { return compatibleQuery(this, String(selector || ''), nativeDocumentQuerySelector); }
  function notifierCompatDocumentQuerySelectorAll(selector) {
    const value = String(selector || '');
    if (value === LEGACY_TURN_SELECTOR) return compatibleTurns(this);
    return nativeDocumentQuerySelectorAll.call(this, selector);
  }
  function notifierCompatElementQuerySelector(selector) { return compatibleQuery(this, String(selector || ''), nativeElementQuerySelector); }
  function notifierCompatElementQuerySelectorAll(selector) {
    const value = String(selector || '');
    if (value === LEGACY_TURN_SELECTOR) return compatibleTurns(this);
    return nativeElementQuerySelectorAll.call(this, selector);
  }
  function notifierCompatClosest(selector) {
    const value = String(selector || '');
    const direct = nativeClosest.call(this, selector);
    if (direct || value !== LEGACY_TURN_SELECTOR) return direct;
    return nativeClosestTo(this, SEMANTIC_ROLE_SELECTOR);
  }
  function notifierCompatGetAttribute(name) {
    const value = nativeGetAttribute.call(this, name);
    if (value != null || String(name || '').toLowerCase() !== 'data-testid') return value;
    const role = semanticRole(this);
    if (!role) return value;
    const messageId = String(nativeAttribute(this, 'data-message-id') || nativeAttribute(this, 'data-turn-id') || '').trim();
    if (messageId) return `conversation-turn-${messageId}`;
    const roles = nativeQueryAll(document, SEMANTIC_ROLE_SELECTOR).filter((node) => semanticRole(node));
    const index = Math.max(0, roles.indexOf(this));
    return `conversation-turn-compat-${role}-${index}`;
  }

  Document.prototype.querySelector = notifierCompatDocumentQuerySelector;
  Document.prototype.querySelectorAll = notifierCompatDocumentQuerySelectorAll;
  Element.prototype.querySelector = notifierCompatElementQuerySelector;
  Element.prototype.querySelectorAll = notifierCompatElementQuerySelectorAll;
  Element.prototype.closest = notifierCompatClosest;
  Element.prototype.getAttribute = notifierCompatGetAttribute;

  globalThis.__chatgptNotifierPageDomCompat = runtime;
})();
