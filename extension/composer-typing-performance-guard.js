'use strict';

(() => {
  const RUNTIME_VERSION = 2;
  const RUNTIME_KEY = '__chatgptNotifierTypingPerformanceGuard';
  const COMPOSER_SELECTOR = '#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid="prompt-textarea"]';
  const MONITOR_ATTRIBUTE_FILTER = Object.freeze([
    'data-testid',
    'aria-label',
    'aria-disabled',
    'aria-hidden',
    'hidden',
    'disabled'
  ]);

  try { globalThis[RUNTIME_KEY]?.dispose?.(); } catch {}

  const PreviousMutationObserver = globalThis.MutationObserver;
  const mutationFilter = globalThis.ChatGPTNotifierOwnedDomMutationFilter;
  if (typeof PreviousMutationObserver !== 'function' || typeof mutationFilter?.isComposerTextMutation !== 'function') return;

  function elementForNode(node) {
    if (node instanceof Element) return node;
    return node?.parentElement || null;
  }

  function composerForRecord(record) {
    const target = elementForNode(record?.target);
    if (!target) return null;
    try {
      if (target.matches(COMPOSER_SELECTOR)) return target;
      return target.closest(COMPOSER_SELECTOR);
    } catch {
      return null;
    }
  }

  function draftPresent(composer) {
    if (!composer) return false;
    try {
      const value = 'value' in composer ? composer.value : composer.textContent;
      return String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().length > 0;
    } catch {
      return false;
    }
  }

  function isMonitorObservation(options) {
    if (options?.attributes !== true || options?.childList !== true || options?.subtree !== true || options?.characterData !== true) return false;
    const filter = new Set(Array.isArray(options?.attributeFilter) ? options.attributeFilter.map(String) : []);
    return MONITOR_ATTRIBUTE_FILTER.every((name) => filter.has(name));
  }

  function filterComposerMutations(records, state = null) {
    const output = [];
    let deliveredDraftTransition = false;
    for (const record of Array.from(records || [])) {
      if (mutationFilter.isComposerTextMutation(record) !== true) {
        output.push(record);
        continue;
      }
      if (state?.monitorObservation !== true || deliveredDraftTransition) continue;
      const composer = composerForRecord(record);
      if (!composer) continue;
      const present = draftPresent(composer);
      if (state.lastDraftPresent === present) continue;
      state.lastDraftPresent = present;
      deliveredDraftTransition = true;
      output.push(record);
    }
    return output;
  }

  class ComposerQuietMutationObserver {
    constructor(callback) {
      if (typeof callback !== 'function') throw new TypeError('MutationObserver callback must be a function');
      const facade = this;
      this.state = {
        monitorObservation: false,
        lastDraftPresent: null
      };
      this.inner = new PreviousMutationObserver((records) => {
        const filtered = filterComposerMutations(records, this.state);
        if (filtered.length) callback(filtered, facade);
      });
    }

    observe(target, options) {
      this.state.monitorObservation = isMonitorObservation(options);
      this.state.lastDraftPresent = null;
      return this.inner.observe(target, options);
    }

    disconnect() { return this.inner.disconnect(); }
    takeRecords() { return filterComposerMutations(this.inner.takeRecords(), this.state); }
  }

  globalThis.MutationObserver = ComposerQuietMutationObserver;

  const runtime = Object.freeze({
    version: RUNTIME_VERSION,
    filterComposerMutations,
    isMonitorObservation,
    draftPresent,
    dispose() {
      if (globalThis.MutationObserver === ComposerQuietMutationObserver) {
        globalThis.MutationObserver = PreviousMutationObserver;
      }
      if (globalThis[RUNTIME_KEY] === runtime) delete globalThis[RUNTIME_KEY];
    }
  });
  globalThis[RUNTIME_KEY] = runtime;
})();
