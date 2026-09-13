'use strict';

const BOOTSTRAP_BRIDGE_URL = 'ws://127.0.0.1:38473/bridge';

function reportBootstrapFailure(status, error) {
  let extensionVersion = '';
  try { extensionVersion = String(chrome.runtime.getManifest().version || ''); } catch {}
  const diagnostic = {
    source: 'extension-bootstrap',
    status: String(status || 'bootstrap-failure'),
    observedAt: new Date().toISOString(),
    extensionVersion,
    reason: 'background-load-failed',
    error: String(error?.message || error || 'unknown').replace(/[\r\n\t]+/g, ' ').slice(0, 240)
  };

  try {
    const socket = new WebSocket(BOOTSTRAP_BRIDGE_URL);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try { socket.close(); } catch {}
    };
    const timeout = setTimeout(finish, 1200);
    socket.onopen = () => {
      try { socket.send(JSON.stringify({ type: 'diagnostics.event', diagnostic })); } catch {}
      clearTimeout(timeout);
      setTimeout(finish, 25);
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      finish();
    };
  } catch {}
}

// Keep Ram Haidar's upstream-compatible completion worker isolated from local
// policy/recovery/history layers. These layers observe browser/page state only;
// none creates ChatGPT HTTP traffic.
let importsReady = false;
try {
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
    'runtime-identity-background.js',
    'normal-continuation-budget-hook.js',
    'delivery-diagnostics-hook.js'
  );
  importsReady = true;
} catch (error) {
  globalThis.__chatgptNotifierBootstrapFailure = String(error?.message || error || 'background import failed');
  reportBootstrapFailure('import-scripts-failed', error);
}

if (importsReady) {
  // The reviewed upstream completion detector remains byte-for-byte unchanged.
  // Its fingerprint already starts with stable page turn identity:
  //   pathname | user-turn-id | assistant-turn-id | rendered-response-prefix
  // Capture those IDs and use them as a strict binding fallback when the detector
  // fires before ChatGPT has finished settling every rendered response block.
  try {
    (() => {
      const CONTEXT_TTL_MS = 120_000;
      const MAX_CONTEXTS_PER_CONVERSATION = 16;
      const contexts = new Map();
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

      function conversationIdFromUrl(rawUrl) {
        try {
          const url = new URL(String(rawUrl || ''));
          if (url.hostname !== 'chatgpt.com' && url.hostname !== 'www.chatgpt.com') return '';
          const parts = url.pathname.split('/').filter(Boolean);
          for (let index = parts.length - 2; index >= 0; index -= 1) {
            if (parts[index] !== 'c') continue;
            return decodeURIComponent(parts[index + 1] || '').trim();
          }
        } catch {}
        return '';
      }

      function parseCompletionFingerprint(value) {
        const fingerprint = String(value || '');
        const first = fingerprint.indexOf('|');
        const second = first >= 0 ? fingerprint.indexOf('|', first + 1) : -1;
        const third = second >= 0 ? fingerprint.indexOf('|', second + 1) : -1;
        if (first <= 0 || second <= first + 1 || third <= second + 1) return null;
        const pathname = fingerprint.slice(0, first).trim();
        const promptTurnId = fingerprint.slice(first + 1, second).trim();
        const assistantKey = fingerprint.slice(second + 1, third).trim();
        if (!pathname || !promptTurnId || !assistantKey) return null;
        return { pathname, promptTurnId, assistantKey };
      }

      function promptTurnIdFromStatus(status) {
        const promptKey = String(status?.promptKey || '');
        const separator = promptKey.lastIndexOf('|');
        return separator >= 0 ? promptKey.slice(separator + 1).trim() : '';
      }

      function prune(now = Date.now()) {
        for (const [conversationId, entries] of contexts) {
          const live = entries
            .filter((entry) => now - Number(entry.at || 0) <= CONTEXT_TTL_MS)
            .slice(-MAX_CONTEXTS_PER_CONVERSATION);
          if (live.length) contexts.set(conversationId, live);
          else contexts.delete(conversationId);
        }
      }

      chrome.runtime.onMessage.addListener((message, sender) => {
        if (message?.type !== 'CHATGPT_RESPONSE_COMPLETE') return false;
        const parsed = parseCompletionFingerprint(message?.fingerprint);
        const conversationId = conversationIdFromUrl(sender?.tab?.url || message?.conversationUrl || '');
        const response = normalize(message?.response);
        if (!parsed || !conversationId || !response) return false;

        const now = Date.now();
        prune(now);
        const entries = contexts.get(conversationId) || [];
        entries.push({
          response,
          promptTurnId: parsed.promptTurnId,
          assistantKey: parsed.assistantKey,
          at: now
        });
        contexts.set(conversationId, entries.slice(-MAX_CONTEXTS_PER_CONVERSATION));
        return false;
      });

      const original = globalThis.statusBoundToCompletion;
      if (typeof original !== 'function') throw new Error('Completion binding hook could not find statusBoundToCompletion.');

      globalThis.statusBoundToCompletion = function statusBoundToCompletionSplitRenderCompat(status, originIdentity, upstreamResponse) {
        if (!status || status.ok !== true || !originIdentity) return false;
        if (String(status.conversationId || '') !== originIdentity.id) return false;
        if (!status.documentId || !status.promptKey || !status.assistantKey || !status.revision) return false;

        const upstream = normalize(upstreamResponse);
        const fullObserved = normalize(status.responseText);
        const parsedBody = normalize(status.responseBody);
        if (upstream && ((fullObserved && upstream === fullObserved) || (parsedBody && upstream === parsedBody))) return true;

        const promptTurnId = promptTurnIdFromStatus(status);
        if (!upstream || !promptTurnId) return false;
        prune();
        const entries = contexts.get(originIdentity.id) || [];
        return entries.some((context) =>
          context.response === upstream &&
          context.promptTurnId === promptTurnId &&
          context.assistantKey === String(status.assistantKey || '')
        );
      };

      const probe = parseCompletionFingerprint('/c/probe|conversation-turn-7|conversation-turn-8|body|with|pipes');
      if (probe?.promptTurnId !== 'conversation-turn-7' || probe?.assistantKey !== 'conversation-turn-8') {
        throw new Error('Completion fingerprint parser self-check failed.');
      }

      globalThis.__chatgptNotifierCompletionBinding = Object.freeze({
        version: 2,
        original,
        parseCompletionFingerprint,
        promptTurnIdFromStatus
      });
    })();
  } catch (error) {
    globalThis.__chatgptNotifierCompletionBindingFailure = String(error?.message || error || 'completion binding failed');
    reportBootstrapFailure('completion-binding-failed', error);
  }
}
