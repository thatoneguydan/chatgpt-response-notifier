'use strict';

(() => {
  const RUNTIME_VERSION = 2;
  const existing = globalThis.ChatGPTNotifierOwnedDomMutationFilter;
  if (Number(existing?.version || 0) >= RUNTIME_VERSION) return;

  const OWNED_ROOT_SELECTOR = '#chatgpt-quick-continue-toolbar';
  const PASSTHROUGH_ATTRIBUTES = new Set(['data-watchdog-settings']);
  const NativeMutationObserver = globalThis.__chatgptNotifierNativeMutationObserver || globalThis.MutationObserver;

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
    if (record.type === 'attributes' && PASSTHROUGH_ATTRIBUTES.has(String(record.attributeName || ''))) return false;
    if (isOwnedNode(record.target)) return true;
    if (record.type !== 'childList') return false;

    const changedNodes = [
      ...Array.from(record.addedNodes || []),
      ...Array.from(record.removedNodes || [])
    ];
    return changedNodes.length > 0 && changedNodes.every(isOwnedNode);
  }

  function filterRecords(records) {
    return Array.from(records || []).filter((record) => !isOwnedMutation(record));
  }

  function hasPageMutation(records) {
    const list = Array.from(records || []);
    if (!list.length) return true;
    return filterRecords(list).length > 0;
  }

  if (typeof NativeMutationObserver === 'function' && globalThis.MutationObserver !== globalThis.__chatgptNotifierFilteredMutationObserver) {
    class NotifierFilteredMutationObserver {
      constructor(callback) {
        if (typeof callback !== 'function') throw new TypeError('MutationObserver callback must be a function');
        const facade = this;
        this.nativeObserver = new NativeMutationObserver((records) => {
          const filtered = filterRecords(records);
          if (filtered.length) callback(filtered, facade);
        });
      }

      observe(target, options) {
        return this.nativeObserver.observe(target, options);
      }

      disconnect() {
        return this.nativeObserver.disconnect();
      }

      takeRecords() {
        return filterRecords(this.nativeObserver.takeRecords());
      }
    }

    globalThis.__chatgptNotifierNativeMutationObserver = NativeMutationObserver;
    globalThis.__chatgptNotifierFilteredMutationObserver = NotifierFilteredMutationObserver;
    globalThis.MutationObserver = NotifierFilteredMutationObserver;
  }

  globalThis.ChatGPTNotifierOwnedDomMutationFilter = Object.freeze({
    version: RUNTIME_VERSION,
    ownedRootSelector: OWNED_ROOT_SELECTOR,
    isOwnedNode,
    isOwnedMutation,
    filterRecords,
    hasPageMutation,
    mutationObserverFiltered: globalThis.MutationObserver === globalThis.__chatgptNotifierFilteredMutationObserver
  });
})();
