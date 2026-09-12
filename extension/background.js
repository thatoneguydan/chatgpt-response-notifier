'use strict';

// Keep Ram Haidar's upstream-compatible completion worker isolated from local
// policy/recovery/history layers. These layers observe browser/page state only;
// none creates ChatGPT HTTP traffic.
importScripts(
  'status-code.js',
  'status-policy.js',
  'recovery-model.js',
  'coordinator-background.js',
  'delivery-dedupe-hook.js',
  'recovery-background.js',
  'history-background.js',
  'monitor-background.js',
  'monitor-query-compat-background.js',
  'recovery-control-background.js',
  'bounded-recovery-background.js',
  'bounded-recovery-attachment-background.js',
  'service-worker.js',
  'normal-continuation-budget-hook.js'
);

// The reviewed upstream completion detector intentionally reads only its first
// rendered markdown/prose block. ChatGPT can render the canonical terminal
// footer in a later block, while status-script correctly observes the whole
// assistant turn. Preserve all existing identity checks, but consider the
// detector exactly bound when its text equals either the full observed turn or
// the exact parsed body with only the terminal footer removed.
(() => {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const original = globalThis.statusBoundToCompletion;
  if (typeof original !== 'function') return;

  globalThis.statusBoundToCompletion = function statusBoundToCompletionSplitRenderCompat(status, originIdentity, upstreamResponse) {
    if (!status || status.ok !== true || !originIdentity) return false;
    if (String(status.conversationId || '') !== originIdentity.id) return false;
    if (!status.documentId || !status.promptKey || !status.assistantKey || !status.revision) return false;

    const upstream = normalize(upstreamResponse);
    const fullObserved = normalize(status.responseText);
    const parsedBody = normalize(status.responseBody);
    return Boolean(upstream && ((fullObserved && upstream === fullObserved) || (parsedBody && upstream === parsedBody)));
  };

  globalThis.__chatgptNotifierCompletionBinding = Object.freeze({
    version: 1,
    original
  });
})();
