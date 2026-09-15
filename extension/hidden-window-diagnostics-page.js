'use strict';

(() => {
  const INSTALL_KEY = '__chatgptNotifierHiddenWindowDiagnosticsPageV1';
  if (globalThis[INSTALL_KEY]) return;
  globalThis[INSTALL_KEY] = true;

  const MARKER = 'chatgpt-response-notifier-hidden-window-diagnostics-v1';
  const ALLOWED_KINDS = new Set(['observer-installed', 'stream-observed', 'stream-ended', 'stream-read-error', 'stream-unreadable']);
  const ALLOWED_TRANSPORTS = new Set(['fetch', 'xhr', 'page', '']);
  const ALLOWED_ROUTES = new Set(['conversation-f', 'conversation', '']);
  const ALLOWED_MEDIA = new Set(['event-stream', 'json', 'text', 'other', 'unknown', '']);
  const ALLOWED_PROTOCOLS = new Set(['sse', 'json', 'text', 'unknown', '']);
  const ALLOWED_REJECTIONS = new Set(['diagnostics-only', 'observer-install-unavailable', 'response-unreadable', 'body-unreadable', 'stream-read-error', 'schema-unclassified', 'raw-token-unscoped', 'no-candidate', '']);
  const pageObserverId = (() => { try { return crypto.randomUUID(); } catch { return `page-${Date.now()}`; } })();
  let pageSequence = 0;
  let pageFrozen = false;

  const integer = (value, max = Number.MAX_SAFE_INTEGER) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.min(max, Math.trunc(number)) : 0;
  };
  const fixed = (value, allowed, fallback = '') => {
    const text = String(value || '');
    return allowed.has(text) ? text : fallback;
  };

  function snapshot() {
    const rawVisibility = String(document.visibilityState || '');
    const visibility = ['visible', 'hidden', 'prerender'].includes(rawVisibility) ? rawVisibility : 'unknown';
    let hasFocus = false;
    try { hasFocus = document.hasFocus() === true; } catch {}
    return { pageObserverId, pageSequence, pageObservedAt: Date.now(), visibility, hasFocus, pageFrozen };
  }

  function sendPageState(state) {
    pageSequence += 1;
    try {
      chrome.runtime.sendMessage({ type: 'CHATGPT_HIDDEN_WINDOW_PAGE_DIAGNOSTIC', bridgeVersion: 1, state: String(state || '').slice(0, 48), ...snapshot() }).catch(() => {});
    } catch {}
  }

  function onWindowMessage(event) {
    if (event?.source !== window || event?.origin !== location.origin) return;
    const data = event?.data;
    const kind = String(data?.kind || '');
    if (!data || data.marker !== MARKER || !ALLOWED_KINDS.has(kind)) return;
    const message = {
      type: 'CHATGPT_HIDDEN_WINDOW_STREAM_DIAGNOSTIC',
      bridgeVersion: 1,
      kind,
      observerVersion: integer(data.observerVersion, 100),
      observerId: String(data.observerId || '').slice(0, 80),
      streamNonce: String(data.streamNonce || '').slice(0, 80),
      eventSequence: integer(data.eventSequence, 1_000_000),
      originObservedAt: integer(data.originObservedAt),
      transport: fixed(data.transport, ALLOWED_TRANSPORTS),
      routeClass: fixed(data.routeClass, ALLOWED_ROUTES),
      httpStatus: integer(data.httpStatus, 999),
      mediaTypeClass: fixed(data.mediaTypeClass, ALLOWED_MEDIA, 'unknown'),
      protocolShape: fixed(data.protocolShape, ALLOWED_PROTOCOLS, 'unknown'),
      byteCount: integer(data.byteCount, 128 * 1024 * 1024),
      chunkCount: integer(data.chunkCount, 1_000_000),
      frameCount: integer(data.frameCount, 1_000_000),
      dataFrameCount: integer(data.dataFrameCount, 1_000_000),
      jsonFrameCount: integer(data.jsonFrameCount, 1_000_000),
      doneFrameCount: integer(data.doneFrameCount, 1_000_000),
      oversizedFrameCount: integer(data.oversizedFrameCount, 1_000_000),
      rawTokenCount: integer(data.rawTokenCount, 10_000),
      decodedCandidateCount: integer(data.decodedCandidateCount, 10_000),
      responseStartMs: integer(data.responseStartMs, 86_400_000),
      firstByteMs: integer(data.firstByteMs, 86_400_000),
      eofMs: integer(data.eofMs, 86_400_000),
      semanticFinalEligible: data.semanticFinalEligible === true,
      semanticRejectionReason: fixed(data.semanticRejectionReason, ALLOWED_REJECTIONS),
      fetchWrapped: typeof data.fetchWrapped === 'boolean' ? data.fetchWrapped : undefined,
      xhrWrapped: typeof data.xhrWrapped === 'boolean' ? data.xhrWrapped : undefined
    };
    try { chrome.runtime.sendMessage(message).catch(() => {}); } catch {}
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'CHATGPT_HIDDEN_WINDOW_DIAGNOSTICS_QUERY') return false;
    sendResponse?.({ ok: true, bridgeVersion: 1, ...snapshot() });
    return false;
  });
  window.addEventListener('message', onWindowMessage);
  try { document.addEventListener('visibilitychange', () => sendPageState('visibility-change')); } catch {}
  try { window.addEventListener('focus', () => sendPageState('focus')); } catch {}
  try { window.addEventListener('blur', () => sendPageState('blur')); } catch {}
  try { window.addEventListener('freeze', () => { pageFrozen = true; sendPageState('freeze'); }); } catch {}
  try { window.addEventListener('resume', () => { pageFrozen = false; sendPageState('resume'); }); } catch {}
  try { window.addEventListener('pagehide', () => sendPageState('pagehide')); } catch {}
  try { window.addEventListener('pageshow', () => { pageFrozen = false; sendPageState('pageshow'); }); } catch {}
  sendPageState('bridge-installed');
})();
