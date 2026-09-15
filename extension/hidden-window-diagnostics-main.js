'use strict';

(() => {
  const INSTALL_KEY = '__chatgptNotifierHiddenWindowDiagnosticsMainV1';
  if (globalThis[INSTALL_KEY]) return;
  globalThis[INSTALL_KEY] = true;

  const MARKER = 'chatgpt-response-notifier-hidden-window-diagnostics-v1';
  const OBSERVER_VERSION = 1;
  const STATUS_PATTERN = /\[GITHUB_STATUS:\s*([A-Z][A-Z0-9_]*)\]/g;
  const TAIL_LIMIT = 512;
  const FRAME_BUFFER_LIMIT = 8192;
  const STRING_WALK_NODE_LIMIT = 128;
  const STRING_WALK_DEPTH_LIMIT = 6;
  const observerId = randomId();

  function randomId() {
    try { return crypto.randomUUID(); } catch {}
    return `diag-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

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

  function routeClass(url, method) {
    if (String(method || '').toUpperCase() !== 'POST') return '';
    try {
      const parsed = new URL(String(url || ''), location.href);
      if (!['chatgpt.com', 'www.chatgpt.com'].includes(parsed.hostname)) return '';
      const path = parsed.pathname.replace(/\/+$/, '');
      if (path === '/backend-api/f/conversation') return 'conversation-f';
      if (path === '/backend-api/conversation') return 'conversation';
    } catch {}
    return '';
  }

  function mediaTypeClass(value) {
    const mediaType = String(value || '').split(';', 1)[0].trim().toLowerCase();
    if (mediaType === 'text/event-stream') return 'event-stream';
    if (mediaType === 'application/json' || mediaType.endsWith('+json')) return 'json';
    if (mediaType.startsWith('text/')) return 'text';
    return mediaType ? 'other' : 'unknown';
  }

  function publish(kind, state, fields = {}) {
    try {
      window.postMessage({
        marker: MARKER,
        kind: String(kind || ''),
        observerVersion: OBSERVER_VERSION,
        observerId,
        streamNonce: state?.streamNonce ? String(state.streamNonce) : '',
        eventSequence: Number(state?.eventSequence || 0),
        originObservedAt: Number(fields.originObservedAt || Date.now()),
        transport: fields.transport ? String(fields.transport) : '',
        routeClass: fields.routeClass ? String(fields.routeClass) : '',
        httpStatus: Number.isFinite(Number(fields.httpStatus)) ? Number(fields.httpStatus) : 0,
        mediaTypeClass: fields.mediaTypeClass ? String(fields.mediaTypeClass) : '',
        protocolShape: fields.protocolShape ? String(fields.protocolShape) : '',
        byteCount: Number(fields.byteCount || 0),
        chunkCount: Number(fields.chunkCount || 0),
        frameCount: Number(fields.frameCount || 0),
        dataFrameCount: Number(fields.dataFrameCount || 0),
        jsonFrameCount: Number(fields.jsonFrameCount || 0),
        doneFrameCount: Number(fields.doneFrameCount || 0),
        oversizedFrameCount: Number(fields.oversizedFrameCount || 0),
        rawTokenCount: Number(fields.rawTokenCount || 0),
        decodedCandidateCount: Number(fields.decodedCandidateCount || 0),
        responseStartMs: Number(fields.responseStartMs || 0),
        firstByteMs: Number(fields.firstByteMs || 0),
        eofMs: Number(fields.eofMs || 0),
        semanticFinalEligible: fields.semanticFinalEligible === true,
        semanticRejectionReason: fields.semanticRejectionReason ? String(fields.semanticRejectionReason) : '',
        fetchWrapped: typeof fields.fetchWrapped === 'boolean' ? fields.fetchWrapped : undefined,
        xhrWrapped: typeof fields.xhrWrapped === 'boolean' ? fields.xhrWrapped : undefined
      }, location.origin);
    } catch {}
  }

  function newState(transport, route, startedAt) {
    return {
      streamNonce: randomId(),
      eventSequence: 0,
      transport,
      routeClass: route,
      startedAt,
      rawTail: '',
      decodedTail: '',
      frameBuffer: '',
      byteCount: 0,
      chunkCount: 0,
      frameCount: 0,
      dataFrameCount: 0,
      jsonFrameCount: 0,
      doneFrameCount: 0,
      oversizedFrameCount: 0,
      rawTokenCount: 0,
      decodedCandidateCount: 0,
      firstByteAt: 0,
      protocolShape: 'unknown'
    };
  }

  function nextEvent(state) {
    state.eventSequence += 1;
    return state.eventSequence;
  }

  function scanPattern(state, field, text, counterField) {
    const incoming = String(text || '');
    if (!incoming) return;
    const previous = String(state[field] || '');
    const combined = `${previous}${incoming}`;
    STATUS_PATTERN.lastIndex = 0;
    let match = null;
    while ((match = STATUS_PATTERN.exec(combined)) !== null) {
      if (match.index + match[0].length > previous.length) state[counterField] += 1;
    }
    state[field] = combined.slice(-TAIL_LIMIT);
  }

  function walkStrings(value, visitor, depth = 0, budget = { nodes: 0 }) {
    if (budget.nodes >= STRING_WALK_NODE_LIMIT || depth > STRING_WALK_DEPTH_LIMIT) return;
    budget.nodes += 1;
    if (typeof value === 'string') {
      visitor(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walkStrings(item, visitor, depth + 1, budget);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const item of Object.values(value)) walkStrings(item, visitor, depth + 1, budget);
  }

  function inspectFrame(state, frame) {
    const text = String(frame || '');
    if (!text.trim()) return;
    state.frameCount += 1;
    const dataLines = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!dataLines.length) return;
    state.dataFrameCount += 1;
    state.protocolShape = 'sse';
    const payload = dataLines.join('\n');
    if (payload.trim() === '[DONE]') {
      state.doneFrameCount += 1;
      return;
    }
    try {
      const parsed = JSON.parse(payload);
      state.jsonFrameCount += 1;
      walkStrings(parsed, (value) => scanPattern(state, 'decodedTail', value, 'decodedCandidateCount'));
    } catch {}
  }

  function inspectProtocolText(state, text) {
    const incoming = String(text || '');
    if (!incoming) return;
    state.frameBuffer += incoming;
    const parts = state.frameBuffer.split(/\r?\n\r?\n/);
    state.frameBuffer = parts.pop() || '';
    for (const frame of parts) inspectFrame(state, frame);
    if (state.frameBuffer.length > FRAME_BUFFER_LIMIT) {
      state.oversizedFrameCount += 1;
      state.frameBuffer = state.frameBuffer.slice(-FRAME_BUFFER_LIMIT);
    }
  }

  function finishProtocol(state) {
    if (state.frameBuffer.trim()) inspectFrame(state, state.frameBuffer);
    state.frameBuffer = '';
  }

  function protocolShape(state, mediaClass) {
    if (state.protocolShape === 'sse' || mediaClass === 'event-stream') return 'sse';
    if (mediaClass === 'json') return 'json';
    if (mediaClass === 'text') return 'text';
    return 'unknown';
  }

  function summary(state, mediaClass, httpStatus, now = Date.now()) {
    const rejection = state.decodedCandidateCount > 0
      ? 'schema-unclassified'
      : state.rawTokenCount > 0
        ? 'raw-token-unscoped'
        : 'no-candidate';
    return {
      transport: state.transport,
      routeClass: state.routeClass,
      httpStatus,
      mediaTypeClass: mediaClass,
      protocolShape: protocolShape(state, mediaClass),
      byteCount: state.byteCount,
      chunkCount: state.chunkCount,
      frameCount: state.frameCount,
      dataFrameCount: state.dataFrameCount,
      jsonFrameCount: state.jsonFrameCount,
      doneFrameCount: state.doneFrameCount,
      oversizedFrameCount: state.oversizedFrameCount,
      rawTokenCount: state.rawTokenCount,
      decodedCandidateCount: state.decodedCandidateCount,
      responseStartMs: Math.max(0, Number(state.responseStartedAt || 0) - state.startedAt),
      firstByteMs: state.firstByteAt ? Math.max(0, state.firstByteAt - state.startedAt) : 0,
      eofMs: Math.max(0, now - state.startedAt),
      semanticFinalEligible: false,
      semanticRejectionReason: rejection
    };
  }

  async function inspectFetchResponse(response, route, startedAt) {
    const state = newState('fetch', route, startedAt);
    state.responseStartedAt = Date.now();
    const httpStatus = Number(response?.status || 0);
    let mediaClass = 'unknown';
    try { mediaClass = mediaTypeClass(response?.headers?.get?.('content-type')); } catch {}
    nextEvent(state);
    publish('stream-observed', state, { ...summary(state, mediaClass, httpStatus, state.responseStartedAt), originObservedAt: state.responseStartedAt });

    if (!response || typeof response.clone !== 'function') {
      nextEvent(state);
      publish('stream-unreadable', state, { ...summary(state, mediaClass, httpStatus), semanticRejectionReason: 'response-unreadable' });
      return;
    }

    let clone = null;
    try { clone = response.clone(); } catch {}
    if (!clone?.body || typeof clone.body.getReader !== 'function') {
      nextEvent(state);
      publish('stream-unreadable', state, { ...summary(state, mediaClass, httpStatus), semanticRejectionReason: 'body-unreadable' });
      return;
    }

    const decoder = new TextDecoder();
    let reader = null;
    try {
      reader = clone.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!state.firstByteAt) state.firstByteAt = Date.now();
        state.chunkCount += 1;
        state.byteCount += Number(value?.byteLength || 0);
        const text = decoder.decode(value, { stream: true });
        scanPattern(state, 'rawTail', text, 'rawTokenCount');
        inspectProtocolText(state, text);
      }
      const tail = decoder.decode();
      scanPattern(state, 'rawTail', tail, 'rawTokenCount');
      inspectProtocolText(state, tail);
      finishProtocol(state);
    } catch {
      nextEvent(state);
      publish('stream-read-error', state, { ...summary(state, mediaClass, httpStatus), semanticRejectionReason: 'stream-read-error' });
      return;
    } finally {
      try { reader?.releaseLock?.(); } catch {}
    }

    nextEvent(state);
    publish('stream-ended', state, summary(state, mediaClass, httpStatus));
  }

  let fetchWrapped = false;
  let xhrWrapped = false;

  try {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function') {
      window.fetch = function chatgptNotifierHiddenWindowDiagnosticsFetch(input, init) {
        const metadata = requestMetadata(input, init);
        const route = routeClass(metadata.url, metadata.method);
        const startedAt = Date.now();
        const result = nativeFetch.apply(this, arguments);
        if (!route) return result;
        return Promise.resolve(result).then((response) => {
          inspectFetchResponse(response, route, startedAt).catch(() => {});
          return response;
        });
      };
      fetchWrapped = true;
    }
  } catch {}

  try {
    const proto = globalThis.XMLHttpRequest?.prototype;
    if (proto?.open && proto?.send) {
      const nativeOpen = proto.open;
      const nativeSend = proto.send;
      const META = Symbol('chatgptNotifierHiddenWindowDiagnosticsMeta');
      proto.open = function chatgptNotifierHiddenWindowDiagnosticsOpen(method, url) {
        try {
          const route = routeClass(url, method);
          this[META] = { route, startedAt: 0 };
        } catch {}
        return nativeOpen.apply(this, arguments);
      };
      proto.send = function chatgptNotifierHiddenWindowDiagnosticsSend() {
        const meta = this[META] || {};
        if (meta.route) {
          meta.startedAt = Date.now();
          try {
            this.addEventListener('loadend', () => {
              const state = newState('xhr', meta.route, meta.startedAt || Date.now());
              state.responseStartedAt = Date.now();
              let mediaClass = 'unknown';
              let text = '';
              try { mediaClass = mediaTypeClass(this.getResponseHeader?.('content-type')); } catch {}
              try {
                if (!this.responseType || this.responseType === 'text') text = String(this.responseText || '');
              } catch {}
              const httpStatus = Number(this.status || 0);
              nextEvent(state);
              publish('stream-observed', state, { ...summary(state, mediaClass, httpStatus, state.responseStartedAt), originObservedAt: state.responseStartedAt });
              if (!text) {
                nextEvent(state);
                publish('stream-unreadable', state, { ...summary(state, mediaClass, httpStatus), semanticRejectionReason: 'body-unreadable' });
                return;
              }
              const encoded = new TextEncoder().encode(text);
              state.firstByteAt = Date.now();
              state.chunkCount = 1;
              state.byteCount = encoded.byteLength;
              scanPattern(state, 'rawTail', text, 'rawTokenCount');
              inspectProtocolText(state, text);
              finishProtocol(state);
              nextEvent(state);
              publish('stream-ended', state, summary(state, mediaClass, httpStatus));
            }, { once: true });
          } catch {}
        }
        return nativeSend.apply(this, arguments);
      };
      xhrWrapped = true;
    }
  } catch {}

  const installState = { streamNonce: '', eventSequence: 1 };
  publish('observer-installed', installState, {
    originObservedAt: Date.now(),
    transport: 'page',
    fetchWrapped,
    xhrWrapped,
    semanticFinalEligible: false,
    semanticRejectionReason: fetchWrapped || xhrWrapped ? 'diagnostics-only' : 'observer-install-unavailable'
  });
})();
