'use strict';

(() => {
  const RUNTIME_VERSION = 1;
  const RUNTIME_KEY = '__chatgptNotifierTypingPerformanceGuard';
  const SIGNAL_ID = 'chatgpt-notifier-draft-transition-signal';
  const SIGNAL_ATTRIBUTE = 'aria-label';
  const COMPOSER_SELECTOR = '#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid="prompt-textarea"]';

  try { globalThis[RUNTIME_KEY]?.dispose?.(); } catch {}

  const PreviousMutationObserver = globalThis.MutationObserver;
  const mutationFilter = globalThis.ChatGPTNotifierOwnedDomMutationFilter;
  if (typeof PreviousMutationObserver !== 'function' || typeof mutationFilter?.isComposerTextMutation !== 'function') return;

  const abortController = new AbortController();
  let lastDraftPresent = null;
  let signalNode = null;

  function filterComposerMutations(records) {
    return Array.from(records || []).filter((record) => mutationFilter.isComposerTextMutation(record) !== true);
  }

  class ComposerQuietMutationObserver {
    constructor(callback) {
      if (typeof callback !== 'function') throw new TypeError('MutationObserver callback must be a function');
      const facade = this;
      this.inner = new PreviousMutationObserver((records) => {
        const filtered = filterComposerMutations(records);
        if (filtered.length) callback(filtered, facade);
      });
    }

    observe(target, options) { return this.inner.observe(target, options); }
    disconnect() { return this.inner.disconnect(); }
    takeRecords() { return filterComposerMutations(this.inner.takeRecords()); }
  }

  globalThis.MutationObserver = ComposerQuietMutationObserver;

  function composerForTarget(target) {
    if (!(target instanceof Element)) return null;
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

  function ensureSignalNode() {
    if (signalNode?.isConnected) return signalNode;
    signalNode = document.getElementById(SIGNAL_ID);
    if (signalNode) return signalNode;
    signalNode = document.createElement('span');
    signalNode.id = SIGNAL_ID;
    signalNode.hidden = true;
    signalNode.setAttribute('data-chatgpt-notifier-draft-transition', '');
    (document.documentElement || document.body)?.append(signalNode);
    return signalNode;
  }

  function publishDraftTransition(present) {
    const node = ensureSignalNode();
    if (!node) return;
    const value = present ? 'ChatGPT draft present' : 'ChatGPT draft empty';
    if (node.getAttribute(SIGNAL_ATTRIBUTE) !== value) node.setAttribute(SIGNAL_ATTRIBUTE, value);
  }

  function handleComposerInput(event) {
    const composer = composerForTarget(event?.target);
    if (!composer) return;
    const present = draftPresent(composer);
    if (present === lastDraftPresent) return;
    lastDraftPresent = present;
    publishDraftTransition(present);
  }

  try {
    document.addEventListener('input', handleComposerInput, {
      capture: true,
      passive: true,
      signal: abortController.signal
    });
  } catch {}

  const runtime = Object.freeze({
    version: RUNTIME_VERSION,
    filterComposerMutations,
    draftPresent,
    dispose() {
      try { abortController.abort(); } catch {}
      try { signalNode?.remove(); } catch {}
      signalNode = null;
      if (globalThis.MutationObserver === ComposerQuietMutationObserver) {
        globalThis.MutationObserver = PreviousMutationObserver;
      }
      if (globalThis[RUNTIME_KEY] === runtime) delete globalThis[RUNTIME_KEY];
    }
  });
  globalThis[RUNTIME_KEY] = runtime;
})();
