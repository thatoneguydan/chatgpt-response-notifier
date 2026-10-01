'use strict';

(() => {
  const RUNTIME_VERSION = 7;
  try { globalThis.__chatgptNotifierPageDomCompat?.dispose?.(); } catch {}

  if (typeof Document === 'undefined' || typeof Element === 'undefined') return;

  const LEGACY_TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const SEMANTIC_ROLE_SELECTOR = [
    '[data-message-author-role="user"]',
    '[data-message-author-role="assistant"]',
    '[data-turn="user"]',
    '[data-turn="assistant"]'
  ].join(',');
  const NORMALIZED_SEMANTIC_ROLE_SELECTOR = SEMANTIC_ROLE_SELECTOR.replace(/\s*,\s*/g, ',');
  const SPEAKER_LABEL_SELECTOR = [
    'h1.sr-only', 'h2.sr-only', 'h3.sr-only', 'h4.sr-only', 'h5.sr-only', 'h6.sr-only',
    'h1.visually-hidden', 'h2.visually-hidden', 'h3.visually-hidden', 'h4.visually-hidden', 'h5.visually-hidden', 'h6.visually-hidden',
    'h1.cdk-visually-hidden', 'h2.cdk-visually-hidden', 'h3.cdk-visually-hidden', 'h4.cdk-visually-hidden', 'h5.cdk-visually-hidden', 'h6.cdk-visually-hidden'
  ].join(',');
  const TURN_CONTAINER_SELECTOR = [
    LEGACY_TURN_SELECTOR,
    '[data-turn-id]',
    '[data-message-id]',
    '[data-turn]',
    'article',
    'section'
  ].join(',');
  const SPEAKER_CACHE_MS = 500;
  const OWNED_ROOT_SELECTOR = '#chatgpt-quick-continue-toolbar';
  const OWNED_MUTATION_PASSTHROUGH_ATTRIBUTES = new Set(['data-watchdog-settings']);
  const MONITOR_ATTRIBUTE_FILTER = Object.freeze([
    'data-testid',
    'aria-label',
    'aria-disabled',
    'aria-hidden',
    'hidden',
    'disabled'
  ]);
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
  const nativeMutationObserver = globalThis.MutationObserver;
  const speakerRoles = new WeakMap();
  const speakerTurnCache = new WeakMap();
  const syntheticTurnIds = new WeakMap();
  const composerMutationRoots = new WeakMap();
  let nextSyntheticTurnId = 1;

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

  function normalizedSelector(value) {
    return String(value || '').replace(/\s*,\s*/g, ',');
  }

  function isSemanticRoleSelector(value) {
    return normalizedSelector(value) === NORMALIZED_SEMANTIC_ROLE_SELECTOR;
  }

  function elementForMutationNode(node) {
    if (!node) return null;
    if (node.nodeType === 1) return node;
    return node.parentElement || null;
  }

  function isOwnedMutationNode(node) {
    const element = elementForMutationNode(node);
    if (!element) return false;
    try {
      return element.matches?.(OWNED_ROOT_SELECTOR) === true
        || Boolean(element.closest?.(OWNED_ROOT_SELECTOR));
    } catch {
      return false;
    }
  }

  function isOwnedMutation(record) {
    if (!record) return false;
    if (
      record.type === 'attributes'
      && OWNED_MUTATION_PASSTHROUGH_ATTRIBUTES.has(String(record.attributeName || ''))
    ) return false;
    return isOwnedMutationNode(record.target);
  }

  function filterOwnedMutations(records) {
    return Array.from(records || []).filter((record) => !isOwnedMutation(record));
  }

  function stableComposerIdentity(composer) {
    return nativeAttribute(composer, 'id') === 'prompt-textarea'
      || nativeAttribute(composer, 'data-testid') === 'prompt-textarea';
  }

  function composerForTextMutation(record) {
    if (!['childList', 'characterData'].includes(record?.type)) return null;
    const element = elementForMutationNode(record.target);
    if (!element) return null;
    const cached = composerMutationRoots.get(element);
    if (cached) {
      if (cached.isConnected !== false) return cached;
      composerMutationRoots.delete(element);
    }

    const composer = nativeClosestTo(element, '#prompt-textarea, [contenteditable="true"], textarea');
    if (!composer) return null;
    if (nativeClosestTo(composer, SEMANTIC_ROLE_SELECTOR) || nativeClosestTo(composer, LEGACY_TURN_SELECTOR)) return null;
    for (let ancestor = composer; ancestor; ancestor = ancestor.parentElement) {
      if (speakerRoles.has(ancestor)) return null;
    }
    // The normal ChatGPT composer has a stable id/testid. Cache only that
    // positive case, so inline editors inside assistant/user turns are always
    // revalidated instead of inheriting a stale classification.
    if (stableComposerIdentity(composer)) composerMutationRoots.set(element, composer);
    return composer;
  }

  function isComposerTextMutation(record) {
    return Boolean(composerForTextMutation(record));
  }

  function draftPresentForMutation(record) {
    const composer = composerForTextMutation(record);
    if (!composer) return null;
    try {
      const value = 'value' in composer ? composer.value : composer.textContent;
      return String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().length > 0;
    } catch {
      return null;
    }
  }

  function isMonitorObservation(options) {
    if (options?.attributes !== true || options?.childList !== true || options?.subtree !== true || options?.characterData !== true) return false;
    const filter = new Set(Array.isArray(options?.attributeFilter) ? options.attributeFilter.map(String) : []);
    return MONITOR_ATTRIBUTE_FILTER.every((name) => filter.has(name));
  }

  function filterObserverMutations(records, state) {
    const output = [];
    let deliveredDraftTransition = false;
    for (const record of Array.from(records || [])) {
      // Composer typing is the hot path. Classify it first so a keystroke never
      // pays the unrelated toolbar-owned closest()/matches() checks.
      if (isComposerTextMutation(record)) {
        if (state?.monitorObservation !== true || deliveredDraftTransition) continue;
        const present = draftPresentForMutation(record);
        if (present === null || state.lastDraftPresent === present) continue;
        state.lastDraftPresent = present;
        deliveredDraftTransition = true;
        output.push(record);
        continue;
      }
      if (isOwnedMutation(record)) continue;
      output.push(record);
    }
    return output;
  }

  class NotifierFilteredMutationObserver {
    constructor(callback) {
      if (typeof callback !== 'function') throw new TypeError('MutationObserver callback must be a function');
      const facade = this;
      this.state = {
        monitorObservation: false,
        lastDraftPresent: null
      };
      this.nativeObserver = new nativeMutationObserver((records) => {
        const filtered = filterObserverMutations(records, this.state);
        if (filtered.length) callback(filtered, facade);
      });
    }

    observe(target, options) {
      this.state.monitorObservation = isMonitorObservation(options);
      this.state.lastDraftPresent = null;
      return this.nativeObserver.observe(target, options);
    }

    disconnect() {
      return this.nativeObserver.disconnect();
    }

    takeRecords() {
      return filterObserverMutations(this.nativeObserver.takeRecords(), this.state);
    }
  }

  function speakerLabelRole(node) {
    const text = String(node?.textContent || node?.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (text === 'you said:') return 'user';
    if (text === 'chatgpt said:' || text === 'assistant said:') return 'assistant';
    return '';
  }

  function semanticRole(node) {
    const synthetic = speakerRoles.get(node);
    if (synthetic === 'user' || synthetic === 'assistant') return synthetic;
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
      const following = typeof Node === 'function' ? Node.DOCUMENT_POSITION_FOLLOWING : 4;
      const preceding = typeof Node === 'function' ? Node.DOCUMENT_POSITION_PRECEDING : 2;
      if (position & following) return -1;
      if (position & preceding) return 1;
    } catch {}
    return 0;
  }

  function syntheticTurnId(node, role) {
    let value = syntheticTurnIds.get(node);
    if (value) return value;
    value = `conversation-turn-compat-${role}-${nextSyntheticTurnId}`;
    nextSyntheticTurnId += 1;
    syntheticTurnIds.set(node, value);
    return value;
  }

  function speakerLabelTurns(root) {
    const now = Date.now();
    const cached = speakerTurnCache.get(root);
    if (
      cached
      && now - cached.observedAt < SPEAKER_CACHE_MS
      && cached.turns.every((turn) => turn?.isConnected !== false)
    ) {
      return cached.turns;
    }

    const turns = [];
    const seen = new Set();
    for (const label of nativeQueryAll(root, SPEAKER_LABEL_SELECTOR)) {
      const role = speakerLabelRole(label);
      if (!role) continue;
      let turn = nativeClosestTo(label, TURN_CONTAINER_SELECTOR);
      if (!turn) turn = label.parentElement || null;
      if (!turn || seen.has(turn)) continue;
      speakerRoles.set(turn, role);
      syntheticTurnId(turn, role);
      seen.add(turn);
      turns.push(turn);
    }
    const ordered = turns.sort(compareDomOrder);
    speakerTurnCache.set(root, { observedAt: now, turns: ordered });
    return ordered;
  }

  function semanticTurns(legacy, roles) {
    const combined = [...legacy];
    for (const roleNode of roles) {
      if (legacy.some((turn) => turn === roleNode || turn.contains?.(roleNode))) continue;
      const role = semanticRole(roleNode);
      const parent = roleNode.parentElement || roleNode;
      const sameRoleAncestor = nativeClosestTo(parent, `[data-message-author-role="${role}"], [data-turn="${role}"]`);
      if (sameRoleAncestor && sameRoleAncestor !== roleNode) continue;
      combined.push(roleNode);
    }
    return Array.from(new Set(combined)).sort(compareDomOrder);
  }

  function hydrateLegacyTurnRoles(root, legacy) {
    if (!legacy.some((turn) => !semanticRole(turn))) return;
    speakerLabelTurns(root);
  }

  function compatibleTurns(root) {
    const legacy = nativeQueryAll(root, LEGACY_TURN_SELECTOR);
    const roles = nativeQueryAll(root, SEMANTIC_ROLE_SELECTOR).filter((node) => semanticRole(node));
    hydrateLegacyTurnRoles(root, legacy);
    if (legacy.length || roles.length) return semanticTurns(legacy, roles);
    return speakerLabelTurns(root);
  }

  function compatibleRoleNodes(root) {
    const legacy = nativeQueryAll(root, LEGANTIC_ROLE_SELECTOR).filter((node) => semanticRole(node));
    hydrateLegacyTurnRoles(root, legacy);
    if (!legacy.length && !roles.length) return speakerLabelTurns(root).filter((node) => semanticRole(node));

    const syntheticLegacy = legacy.filter((turn) => (
      semanticRole(turn)
      && !roles.some((roleNode) => turn === roleNode || turn.contains?.(roleNode))
    ));
    return Array.from(new Set([...roles, ...syntheticLegacy])).sort(compareDomOrder);
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
    for (const selector of selectors) {
      const candidates = nativeQueryAll(root, selector).filter(usableComposer);
      if (candidates.length) return candidates[candidates.length - 1];
    }
    return null;
  }

  function enabledButton(button) {
    return Boolean(button && visibleEnough(button) && !button.disabled && nativeAttribute(button, 'aria-disabled') !== 'true');
  }

  function fallbackSend(root) {
    for (const button of nativeQueryAll(root, 'button').filter(enabledButton)) {
      const testId = String(nativeAttribute(button, 'data-testid') || '').toLowerCase();
      const label = String(nativeAttribute(button, 'aria-label') || '').trim().toLowerCase();
      if (/^(send|send prompt|send message)$/.test(label)) return button;
      if (/send[-_ ]?button|composer[-_ ]?send/.test(testId)) return button;
    }
    return null;
  }

  function fallbackStop(root) {
    for (const button of nativeQueryAll(root, 'button')) {
      if (!visibleEnough(button)) continue;
      const testId = String(nativeAttribute(button, 'data-testid') || '').toLowerCase();
      const label = String(nativeAttribute(button, 'aria-label') || '').trim().toLowerCase();
      if (/^stop(?: generating| response)?$/.test(label)) return button;
      if (/stop[-_ ]?(button|generating|response)/.test(testId)) return button;
    }
    return null;
  }

  function compatibleQuery(root, selector, original) {
    let direct = null;
    try { direct = original.call(root, selector); } catch { return null; }
    if (direct) return direct;
    if (LEGACY_COMPOSER_SELECTORS.has(selector)) return fallbackComposer(root);
    if (LEGACY_SEND_SELECTORS.has(selector)) return fallbackSend(root);
    if (selector === LEGACY_STOP_SELECTOR) return fallbackStop(root);
    return null;
  }

  function notifierCompatDocumentQuerySelector(selector) {
    return compatibleQuery(this, String(selector || ''), nativeDocumentQuerySelector);
  }

  function notifierCompatDocumentQuerySelectorAll(selector) {
    const value = String(selector || '');
    if (value === LEGACY_TURN_SELECTOR) return compatibleTurns(this);
    if (isSemanticRoleSelector(value)) return compatibleRoleNodes(this);
    return nativeDocumentQuerySelectorAll.call(this, selector);
  }

  function notifierCompatElementQuerySelector(selector) {
    return compatibleQuery(this, String(selector || ''), nativeElementQuerySelector);
  }

  function notifierCompatElementQuerySelectorAll(selector) {
    const value = String(selector || '');
    if (value === LEGACY_TURN_SELECTOR) return compatibleTurns(this);
    if (isSemanticRoleSelector(value)) return compatibleRoleNodes(this);
    return nativeElementQuerySelectorAll.call(this, selector);
  }

  function notifierCompatClosest(selector) {
    const value = String(selector || '');
    const direct = nativeClosest.call(this, selector);
    if (direct || value !== LEGACY_TURN_SELECTOR) return direct;
    const semantic = nativeClosestTo(this, SEMANTIC_ROLE_SELECTOR);
    if (semantic) return semantic;
    let candidate = this;
    while (candidate) {
      if (speakerRoles.get(candidate)) return candidate;
      candidate = candidate.parentElement || null;
    }
    return null;
  }

  function notifierCompatGetAttribute(name) {
    const value = nativeGetAttribute.call(this, name);
    if (value != null) return value;
    const normalizedName = String(name || '').toLowerCase();
    if (normalizedName !== 'data-turn' && normalizedName !== 'data-message-author-role' && normalizedName !== 'data-testid') return value;
    const role = semanticRole(this);
    if ((normalizedName === 'data-turn' || normalizedName === 'data-message-author-role') && role) return role;
    if (normalizedName !== 'data-testid' || !role) return value;

    const messageId = String(
      nativeAttribute(this, 'data-message-id')
      || nativeAttribute(this, 'data-turn-id')
      || ''
    ).trim();
    if (messageId) return `conversation-turn-${messageId}`;
    return syntheticTurnId(this, role);
  }

  Document.prototype.querySelector = notifierCompatDocumentQuerySelector;
  Document.prototype.querySelectorAll = notifierCompatDocumentQuerySelectorAll;
  Element.prototype.querySelector = notifierCompatElementQuerySelector;
  Element.prototype.querySelectorAll = notifierCompatElementQuerySelectorAll;
  Element.prototype.closest = notifierCompatClosest;
  Element.prototype.getAttribute = notifierCompatGetAttribute;
  if (typeof nativeMutationObserver === 'function') globalThis.MutationObserver = NotifierFilteredMutationObserver;

  const mutationFilter = Object.freeze({
    version: RUNTIME_VERSION,
    ownedRootSelector: OWNED_ROOT_SELECTOR,
    isOwnedNode: isOwnedMutationNode,
    isOwnedMutation,
    filterRecords: filterOwnedMutations,
    isComposerTextMutation,
    isMonitorObservation,
    mutationObserverFiltered: globalThis.MutationObserver === NotifierFilteredMutationObserver
  });

  const runtime = {
    version: RUNTIME_VERSION,
    compatibleTurns,
    compatibleRoleNodes,
    speakerLabelTurns,
    fallbackComposer,
    fallbackSend,
    fallbackStop,
    mutationFilter,
    dispose() {
      if (Document.prototype.querySelector === notifierCompatDocumentQuerySelector) Document.prototype.querySelector = nativeDocumentQuerySelector;
      if (Document.prototype.querySelectorAll === notifierCompatDocumentQuerySelectorAll) Document.prototype.querySelectorAll = nativeDocumentQuerySelectorAll;
      if (Element.prototype.querySelector === notifierCompatElementQuerySelector) Element.prototype.querySelector = nativeElementQuerySelector;
      if (Element.prototype.querySelectorAll === notifierCompatElementQuerySelectorAll) Element.prototype.querySelectorAll = nativeElementQuerySelectorAll;
      if (Element.prototype.closest === notifierCompatClosest) Element.prototype.closest = nativeClosest;
      if (Element.prototype.getAttribute === notifierCompatGetAttribute) Element.prototype.getAttribute = nativeGetAttribute;
      if (globalThis.MutationObserver === NotifierFilteredMutationObserver) globalThis.MutationObserver = nativeMutationObserver;
      if (globalThis.ChatGPTNotifierOwnedDomMutationFilter === mutationFilter) delete globalThis.ChatGPTNotifierOwnedDomMutationFilter;
      if (globalThis.__chatgptNotifierPageDomCompat === runtime) delete globalThis.__chatgptNotifierPageDomCompat;
    }
  };

  globalThis.ChatGPTNotifierOwnedDomMutationFilter = mutationFilter;
  globalThis.__chatgptNotifierPageDomCompat = runtime;
})();