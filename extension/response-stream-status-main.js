'use strict';

(() => {
  const INSTALL_KEY = '__chatgptResponseNotifierStreamStatusMainV1';
  if (globalThis[INSTALL_KEY]) return;
  globalThis[INSTALL_KEY] = true;

  const EVENT_MARKER = 'chatgpt-response-notifier-stream-status-v1';
  const STATUS_PATTERN = /\[GITHUB_STATUS:\s*([A-Z][A-Z0-9_]*)\]/g;
  const TAIL_LIMIT = 512;

  function requestMetadata(input, init = {}) {
    let url = '';
    let method = '';
    try {
      if (typeof Request !== 'undefined' && input instanceof Request) {
        url = String(input.url || '');
        method = String(init?.method || input.method || 'GET').toUpperCase();
      } else {
        url = String(input || '');
        method = String(init?.method || 'GET').toUpperCase();
      }
    } catch {}
    return { url, method };
  }

  function isConversationRequest(url, method) {
    if (String(method || '').toUpperCase() !== 'POST') return false;
    try {
      const parsed = new URL(String(url || ''), location.href);
      if (!['chatgpt.com', 'www.chatgpt.com'].includes(parsed.hostname)) return false;
      const path = parsed.pathname.replace(/\/+$/, '');
      return path === '/backend-api/f/conversation' || path === '/backend-api/conversation';
    } catch {
      return false;
    }
  }

  function publish(kind, fields = {}) {
    try {
      window.postMessage({
        marker: EVENT_MARKER,
        kind: String(kind || ''),
        statusCode: fields.statusCode ? String(fields.statusCode) : '',
        transport: fields.transport ? String(fields.transport) : ''
      }, location.origin);
    } catch {}
  }

  function scanText(state, text) {
    const incoming = String(text || '');
    if (!incoming) return;
    const combined = `${state.tail}${incoming}`;
    STATUS_PATTERN.lastIndex = 0;
    let match = null;
    while ((match = STATUS_PATTERN.exec(combined)) !== null) {
      state.lastStatusCode = String(match[1] || '');
    }
    state.tail = combined.slice(-TAIL_LIMIT);
  }

  async function inspectFetchResponse(response) {
    publish('stream-observed', { transport: 'fetch' });
    if (!response || typeof response.clone !== 'function') {
      publish('stream-unreadable', { transport: 'fetch' });
      return;
    }

    let clone = null;
    try { clone = response.clone(); } catch {}
    if (!clone?.body || typeof clone.body.getReader !== 'function') {
      publish('stream-unreadable', { transport: 'fetch' });
      return;
    }

    const state = { tail: '', lastStatusCode: '' };
    const decoder = new TextDecoder();
    let reader = null;
    try {
      reader = clone.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        scanText(state, decoder.decode(value, { stream: true }));
      }
      scanText(state, decoder.decode());
    } catch {
      // Chrome can throw while releasing/finishing a cloned SSE body even after
      // the terminal footer has already crossed the clone. Preserve that
      // already-observed status instead of discarding it with the read error.
      if (state.lastStatusCode) {
        publish('terminal-status', { transport: 'fetch', statusCode: state.lastStatusCode });
      }
      publish('stream-read-error', { transport: 'fetch' });
      return;
    } finally {
      try { reader?.releaseLock?.(); } catch {}
    }

    if (state.lastStatusCode) publish('terminal-status', { transport: 'fetch', statusCode: state.lastStatusCode });
    else publish('stream-ended-no-status', { transport: 'fetch' });
  }

  try {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function') {
      window.fetch = function chatgptNotifierObservedFetch(input, init) {
        const metadata = requestMetadata(input, init);
        const result = nativeFetch.apply(this, arguments);
        if (!isConversationRequest(metadata.url, metadata.method)) return result;
        return Promise.resolve(result).then((response) => {
          inspectFetchResponse(response).catch(() => {});
          return response;
        });
      };
    }
  } catch {}

  try {
    const proto = globalThis.XMLHttpRequest?.prototype;
    if (proto?.open && proto?.send) {
      const nativeOpen = proto.open;
      const nativeSend = proto.send;
      const META = Symbol('chatgptNotifierStreamStatusMeta');

      proto.open = function chatgptNotifierObservedOpen(method, url) {
        try { this[META] = { method: String(method || '').toUpperCase(), url: String(url || '') }; } catch {}
        return nativeOpen.apply(this, arguments);
      };

      proto.send = function chatgptNotifierObservedSend() {
        const meta = this[META] || {};
        if (isConversationRequest(meta.url, meta.method)) {
          try {
            this.addEventListener('loadend', () => {
              publish('stream-observed', { transport: 'xhr' });
              let text = '';
              try {
                if (!this.responseType || this.responseType === 'text') text = String(this.responseText || '');
              } catch {}
              if (!text) {
                publish('stream-unreadable', { transport: 'xhr' });
                return;
              }
              const state = { tail: '', lastStatusCode: '' };
              scanText(state, text);
              if (state.lastStatusCode) publish('terminal-status', { transport: 'xhr', statusCode: state.lastStatusCode });
              else publish('stream-ended-no-status', { transport: 'xhr' });
            }, { once: true });
          } catch {}
        }
        return nativeSend.apply(this, arguments);
      };
    }
  } catch {}
})();
