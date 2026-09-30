'use strict';

(() => {
  const RUNTIME_VERSION = 1;
  const existing = globalThis.ChatGPTNotifierOwnedDomMutationFilter;
  if (Number(existing?.version || 0) >= RUNTIME_VERSION) return;

  const OWNED_ROOT_SELECTOR = '#chatgpt-quick-continue-toolbar';

  function elementFor(node) {
    if (!node) return null;
    if (node.nodeType === 1) return node;
    return node.parentElement || null;
  }

  function isOwnedNode(node) {
    const element = elementFor(node);
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
    if (isOwnedNode(record.target)) return true;
    if (record.type !== 'childList') return false;

    const changedNodes = [
      ...Array.from(record.addedNodes || []),
      ...Array.from(record.removedNodes || [])
    ];
    return changedNodes.length > 0 && changedNodes.every(isOwnedNode);
  }

  function hasPageMutation(records) {
    const list = Array.from(records || []);
    if (!list.length) return true;
    return list.some((record) => !isOwnedMutation(record));
  }

  globalThis.ChatGPTNotifierOwnedDomMutationFilter = Object.freeze({
    version: RUNTIME_VERSION,
    ownedRootSelector: OWNED_ROOT_SELECTOR,
    isOwnedNode,
    isOwnedMutation,
    hasPageMutation
  });
})();
