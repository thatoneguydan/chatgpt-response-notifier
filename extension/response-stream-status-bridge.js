'use strict';

(() => {
  const RUNTIME_VERSION = 2;
  try { globalThis.__chatgptNotifierStreamStatusBridge?.dispose?.(); } catch {}

  const EVENT_MARKER = 'chatgpt-response-notifier-stream-status-v1';
  const ALLOWED_KINDS = new Set([
    'stream-observed',
    'stream-unreadable',
    'stream-read-error',
    'stream-ended-no-status',
    'terminal-status'
  ]);
  const ALLOWED_TRANSPORTS = new Set(['fetch', 'xhr']);

  function onMessage(event) {
    if (event?.source !== window || event?.origin !== location.origin) return;
    const data = event?.data;
    if (!data || data.marker !== EVENT_MARKER) return;

    const kind = String(data.kind || '');
    const transport = String(data.transport || '');
    if (!ALLOWED_KINDS.has(kind) || !ALLOWED_TRANSPORTS.has(transport)) return;

    if (kind === 'terminal-status') {
      const statusCode = String(data.statusCode || '');
      if (!globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(statusCode)) return;
      try {
        chrome.runtime.sendMessage({
          type: 'CHATGPT_RESPONSE_STREAM_TERMINAL_STATUS',
          statusCode,
          transport
        }).catch(() => {});
      } catch {}
      return;
    }

    try {
      chrome.runtime.sendMessage({
        type: 'CHATGPT_RESPONSE_STREAM_DIAGNOSTIC',
        state: kind,
        transport
      }).catch(() => {});
    } catch {}
  }

  try { window.addEventListener('message', onMessage); } catch {}

  const runtime = Object.freeze({
    version: RUNTIME_VERSION,
    dispose() {
      try { window.removeEventListener('message', onMessage); } catch {}
      if (globalThis.__chatgptNotifierStreamStatusBridge === runtime) {
        delete globalThis.__chatgptNotifierStreamStatusBridge;
      }
    }
  });
  globalThis.__chatgptNotifierStreamStatusBridge = runtime;
})();
