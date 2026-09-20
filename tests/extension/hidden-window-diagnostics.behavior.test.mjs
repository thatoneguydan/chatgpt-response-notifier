import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const mainSource = read('extension/hidden-window-diagnostics-main.js');
const pageSource = read('extension/hidden-window-diagnostics-page.js');
const backgroundSource = read('extension/hidden-window-diagnostics-background.js');
const bootstrapSource = read('extension/diagnostics-bootstrap.js');
const sanitizerSource = read('src/ChatGPTResponseNotifier.Host/DiagnosticsSanitizer.cs');
const retentionSource = read('src/ChatGPTResponseNotifier.Host/HiddenWindowIncidentRetention.cs');
const publisherSource = read('src/ChatGPTResponseNotifier.Host/RuntimeEvidencePublisher.cs');
const safeEvidenceSource = read('tools/Add-NotifierSafeEvidence.ps1');

function streamResponse(chunks, contentType = 'text/event-stream') {
  return {
    status: 200,
    headers: { get: (name) => String(name).toLowerCase() === 'content-type' ? contentType : null },
    clone() {
      let index = 0;
      return {
        body: {
          getReader() {
            return {
              async read() {
                if (index >= chunks.length) return { done: true, value: undefined };
                return { done: false, value: new TextEncoder().encode(chunks[index++]) };
              },
              releaseLock() {}
            };
          }
        }
      };
    }
  };
}

async function settle() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function makeBackgroundHarness({ pageReply = 'reply', startTime = 1_000_000 } = {}) {
  let now = startTime;
  let uuid = 0;
  let timerId = 0;
  const timers = [];
  const nativeMessages = [];
  const beforeRequest = [];
  const completedRequest = [];
  const erroredRequest = [];
  const runtimeMessages = [];
  const alarmListeners = [];
  const removedListeners = [];

  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }

  const pendingPageReply = new Promise(() => {});
  const chrome = {
    runtime: {
      getManifest: () => ({ version: '0.9.29' }),
      onMessage: { addListener: (listener) => runtimeMessages.push(listener) }
    },
    webRequest: {
      onBeforeRequest: { addListener: (listener) => beforeRequest.push(listener) },
      onCompleted: { addListener: (listener) => completedRequest.push(listener) },
      onErrorOccurred: { addListener: (listener) => erroredRequest.push(listener) }
    },
    tabs: {
      query: async () => [],
      get: async (tabId) => ({ id: tabId, active: false, frozen: false, discarded: false, windowId: 11 }),
      sendMessage: async () => pageReply === 'never'
        ? pendingPageReply
        : ({ ok: true, visibility: 'hidden', hasFocus: false, pageFrozen: false, pageObservedAt: now, pageObserverId: 'page-observer' }),
      onRemoved: { addListener: (listener) => removedListeners.push(listener) }
    },
    windows: {
      get: async () => ({ focused: false, state: 'normal' })
    },
    scripting: { executeScript: async () => [] },
    alarms: {
      create() {},
      clear: async () => true,
      onAlarm: { addListener: (listener) => alarmListeners.push(listener) }
    }
  };

  const context = vm.createContext({
    chrome,
    crypto: { randomUUID: () => `uuid-${++uuid}` },
    sendNative: (message) => nativeMessages.push(message),
    URL,
    TextEncoder,
    Date: FakeDate,
    Promise,
    Map,
    Set,
    Object,
    Array,
    JSON,
    Number,
    String,
    Math,
    Error,
    setTimeout: (fn, delay) => {
      const timer = { id: ++timerId, fn, delay, cleared: false };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout: (id) => {
      const timer = timers.find((item) => item.id === id);
      if (timer) timer.cleared = true;
    }
  });

  vm.runInContext(backgroundSource, context);

  const diagnostics = () => nativeMessages
    .filter((item) => item?.type === 'diagnostics.event')
    .map((item) => item.diagnostic);
  const incidentSnapshots = () => diagnostics()
    .filter((item) => item?.status === 'incident-snapshot')
    .map((item) => item.incident);

  return {
    beforeRequest,
    completedRequest,
    erroredRequest,
    runtimeMessages,
    alarmListeners,
    removedListeners,
    diagnostics,
    incidentSnapshots,
    now: () => now,
    advance: (milliseconds) => { now += milliseconds; },
    fireTimers: (delay) => {
      for (const timer of timers.filter((item) => !item.cleared && item.delay === delay)) {
        timer.cleared = true;
        timer.fn();
      }
    }
  };
}

function requestDetails({ requestId = 'req-1', tabId = 7, documentId = 'document-1' } = {}) {
  return {
    requestId,
    tabId,
    documentId,
    method: 'POST',
    url: 'https://chatgpt.com/backend-api/f/conversation'
  };
}

function streamDiagnostic(harness, {
  kind = 'stream-observed',
  streamNonce = 'stream-1',
  tabId = 7,
  documentId = 'document-1',
  originObservedAt = harness.now()
} = {}) {
  const message = {
    type: 'CHATGPT_HIDDEN_WINDOW_STREAM_DIAGNOSTIC',
    kind,
    observerVersion: 1,
    observerId: 'observer-1',
    streamNonce,
    eventSequence: kind === 'stream-observed' ? 1 : 2,
    originObservedAt,
    transport: 'fetch',
    routeClass: 'conversation-f',
    httpStatus: 200,
    mediaTypeClass: 'event-stream',
    protocolShape: 'sse',
    byteCount: 321,
    chunkCount: 3,
    frameCount: 3,
    dataFrameCount: 3,
    jsonFrameCount: 2,
    doneFrameCount: 1,
    decodedCandidateCount: 1,
    semanticFinalEligible: false,
    semanticRejectionReason: 'schema-unclassified'
  };
  for (const listener of harness.runtimeMessages) listener(message, { tab: { id: tabId }, documentId }, () => {});
}

test('hidden-window diagnostic sources are syntactically valid and wired after the canonical background', () => {
  assert.doesNotThrow(() => new vm.Script(mainSource));
  assert.doesNotThrow(() => new vm.Script(pageSource));
  assert.doesNotThrow(() => new vm.Script(backgroundSource));
  assert.doesNotThrow(() => new vm.Script(bootstrapSource));
  assert.match(bootstrapSource, /importScripts\('background\.js'\)/);
  assert.match(bootstrapSource, /hidden-window-diagnostics-background\.js/);

  const manifest = JSON.parse(read('extension/manifest.json'));
  assert.equal(manifest.version, '0.9.48');
  assert.equal(manifest.background.service_worker, 'diagnostics-bootstrap.js');
  const scripts = manifest.content_scripts.flatMap((item) => item.js || []);
  assert.ok(scripts.includes('hidden-window-diagnostics-main.js'));
  assert.ok(scripts.includes('hidden-window-diagnostics-page.js'));
});

test('passive MAIN observer exposes logical-delta evidence without authorizing a terminal result', async () => {
  const posted = [];
  const calls = [];
  const response = streamResponse([
    'data: {"v":"[GITHUB_STA"}\n\n',
    'data: {"v":"TUS: COMPLETE_NO_CHANGES]"}\n\n',
    'data: [DONE]\n\n'
  ]);
  const window = {
    fetch: async (...args) => { calls.push(args); return response; },
    postMessage(message, origin) { posted.push({ message, origin }); }
  };
  const context = vm.createContext({
    console,
    window,
    globalThis: window,
    location: { href: 'https://chatgpt.com/c/conversation-1', origin: 'https://chatgpt.com' },
    URL,
    TextDecoder,
    TextEncoder,
    Request: undefined,
    XMLHttpRequest: undefined,
    Symbol,
    Promise,
    Date,
    Math,
    Object,
    Array,
    JSON,
    Number,
    String,
    crypto: { randomUUID: () => `uuid-${posted.length}-${calls.length}` }
  });
  window.crypto = context.crypto;

  vm.runInContext(mainSource, context);
  const returned = await window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST' });
  await settle();

  assert.equal(returned, response);
  assert.equal(calls.length, 1, 'diagnostics must clone the existing response, not issue a second request');
  const final = posted.find((item) => item.message?.kind === 'stream-ended')?.message;
  assert.ok(final, 'final diagnostic summary should be emitted');
  assert.equal(final.rawTokenCount, 0, 'the raw transport should not falsely report a contiguous token');
  assert.ok(final.decodedCandidateCount >= 1, 'decoded string-delta evidence should expose the split candidate');
  assert.equal(final.semanticFinalEligible, false, 'diagnostic candidates must never authorize notification or Continue');
  assert.equal(final.semanticRejectionReason, 'schema-unclassified');
  assert.equal(final.protocolShape, 'sse');
  assert.equal(final.doneFrameCount, 1);
  assert.equal('responseText' in final, false);
  assert.equal('responseBody' in final, false);
  assert.equal('url' in final, false);
});

test('decoded JSON escapes remain evidence only, never a terminal authorization', async () => {
  const posted = [];
  const response = streamResponse([
    'data: {"v":"\\u005bGITHUB_STATUS: COMPLETE_NO_CHANGES]"}\n\n',
    'data: [DONE]\n\n'
  ]);
  const window = {
    fetch: async () => response,
    postMessage(message) { posted.push(message); }
  };
  const context = vm.createContext({
    window,
    globalThis: window,
    location: { href: 'https://chatgpt.com/c/conversation-1', origin: 'https://chatgpt.com' },
    URL,
    TextDecoder,
    TextEncoder,
    Request: undefined,
    XMLHttpRequest: undefined,
    Symbol,
    Promise,
    Date,
    Math,
    Object,
    Array,
    JSON,
    Number,
    String,
    crypto: { randomUUID: () => 'uuid-json-escape' }
  });
  window.crypto = context.crypto;
  vm.runInContext(mainSource, context);
  await window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST' });
  await settle();
  const final = posted.find((item) => item.kind === 'stream-ended');
  assert.ok(final);
  assert.equal(final.rawTokenCount, 0);
  assert.equal(final.decodedCandidateCount, 1);
  assert.equal(final.semanticFinalEligible, false);
  assert.equal(final.semanticRejectionReason, 'schema-unclassified');
});

test('MAIN observer remains read-only and bounded', () => {
  assert.match(mainSource, /nativeFetch\.apply\(this, arguments\)/);
  assert.match(mainSource, /response\.clone\(\)/);
  assert.match(mainSource, /TAIL_LIMIT = 512/);
  assert.match(mainSource, /FRAME_BUFFER_LIMIT = 8192/);
  assert.match(mainSource, /STRING_WALK_NODE_LIMIT = 128/);
  assert.doesNotMatch(mainSource, /chrome\./);
  assert.doesNotMatch(mainSource, /setInterval/);
  assert.doesNotMatch(mainSource, /api\/auth\/session/i);
  assert.doesNotMatch(mainSource, /Regenerate/i);
});

test('isolated page bridge forwards only fixed metadata and never response content', async () => {
  const windowListeners = [];
  const runtimeListeners = [];
  const sent = [];
  const window = {
    addEventListener(type, listener) { if (type === 'message') windowListeners.push(listener); }
  };
  const document = {
    visibilityState: 'hidden',
    hasFocus: () => false,
    addEventListener() {}
  };
  const context = vm.createContext({
    window,
    document,
    location: { origin: 'https://chatgpt.com' },
    chrome: {
      runtime: {
        sendMessage(message) { sent.push(message); return Promise.resolve(); },
        onMessage: { addListener(listener) { runtimeListeners.push(listener); } }
      }
    },
    crypto: { randomUUID: () => 'page-observer-1' },
    Date,
    Number,
    String,
    Set,
    Promise
  });
  vm.runInContext(pageSource, context);
  assert.equal(windowListeners.length, 1);
  assert.equal(runtimeListeners.length, 1);

  windowListeners[0]({
    source: window,
    origin: 'https://chatgpt.com',
    data: {
      marker: 'chatgpt-response-notifier-hidden-window-diagnostics-v1',
      kind: 'stream-ended',
      observerVersion: 1,
      observerId: 'observer-1',
      streamNonce: 'stream-1',
      eventSequence: 2,
      originObservedAt: 123,
      transport: 'fetch',
      routeClass: 'conversation-f',
      httpStatus: 200,
      mediaTypeClass: 'event-stream',
      protocolShape: 'sse',
      byteCount: 100,
      decodedCandidateCount: 1,
      semanticFinalEligible: false,
      semanticRejectionReason: 'schema-unclassified',
      responseText: 'must never cross the bridge',
      url: 'https://chatgpt.com/private'
    }
  });
  await settle();

  const forwarded = sent.find((item) => item.type === 'CHATGPT_HIDDEN_WINDOW_STREAM_DIAGNOSTIC');
  assert.ok(forwarded);
  assert.equal(forwarded.semanticFinalEligible, false);
  assert.equal('responseText' in forwarded, false);
  assert.equal('url' in forwarded, false);
  assert.equal(forwarded.routeClass, 'conversation-f');
});

test('one request remains traceable after more than five minutes without request-context expiry', async () => {
  const harness = makeBackgroundHarness();
  harness.beforeRequest[0](requestDetails());
  await settle();
  harness.advance(300_001);
  streamDiagnostic(harness, { kind: 'stream-observed', originObservedAt: harness.now() });
  await settle();
  streamDiagnostic(harness, { kind: 'stream-ended', originObservedAt: harness.now() });
  await settle();

  const incident = harness.incidentSnapshots().findLast((item) => item?.requestSuffix === 'req-1');
  assert.ok(incident, 'long-running request should retain an incident');
  assert.equal(incident.mappingConfidence, 'document-single-request');
  assert.equal(incident.firstUnresolvedBoundary, '');
  assert.ok(incident.transitions.some((item) => item.stage === 'stream-stream-ended' && item.contextAgeMs >= 300_001));
});

test('overlapping requests fail closed as ambiguous instead of silently choosing the newest request', async () => {
  const harness = makeBackgroundHarness();
  harness.beforeRequest[0](requestDetails({ requestId: 'request-a' }));
  harness.beforeRequest[0](requestDetails({ requestId: 'request-b' }));
  await settle();
  streamDiagnostic(harness, { kind: 'stream-observed', streamNonce: 'ambiguous-stream' });
  await settle();

  const incident = harness.incidentSnapshots().findLast((item) => item?.kind === 'stream-orphan');
  assert.ok(incident, 'ambiguous stream should produce its own explicit incident');
  assert.equal(incident.mappingConfidence, 'ambiguous-overlap');
  assert.equal(incident.mappingCandidateCount, 2);
  assert.equal(incident.firstUnresolvedBoundary, 'request-stream-mapping-ambiguous');
  assert.equal(incident.traceState, 'failed-boundary');
});

test('never-replying page query reaches a worker-owned deadline with the boundary retained', async () => {
  const harness = makeBackgroundHarness({ pageReply: 'never' });
  harness.beforeRequest[0](requestDetails());
  await settle();
  harness.fireTimers(2000);
  await settle();

  const incident = harness.incidentSnapshots().findLast((item) => item?.requestSuffix === 'req-1');
  assert.ok(incident);
  assert.equal(incident.firstUnresolvedBoundary, 'page-query-deadline');
  assert.equal(incident.traceState, 'failed-boundary');
  assert.ok(incident.transitions.some((item) => item.stage === 'page-query-deadline'));
});

test('extension incident retention evicts oldest traces beyond the twenty-incident budget', async () => {
  const harness = makeBackgroundHarness();
  for (let index = 0; index < 22; index += 1) {
    const tabId = 100 + index;
    const documentId = `document-${index}`;
    const requestId = `request-${index}`;
    harness.beforeRequest[0](requestDetails({ requestId, tabId, documentId }));
    await settle();
    streamDiagnostic(harness, {
      kind: 'stream-ended',
      streamNonce: `stream-${index}`,
      tabId,
      documentId,
      originObservedAt: harness.now()
    });
    await settle();
  }

  const snapshots = harness.incidentSnapshots();
  const latest = snapshots.at(-1);
  assert.ok(latest);
  assert.ok(latest.retentionEvictedIncidents >= 2, 'retention should report evictions rather than grow without bound');
});

test('worker diagnostics bound correlation, deadlines, persistence and retention without action authority', () => {
  assert.match(backgroundSource, /MAX_INCIDENTS = 20/);
  assert.match(backgroundSource, /MAX_TRANSITIONS = 48/);
  assert.match(backgroundSource, /MAX_METADATA_BYTES = 128 \* 1024/);
  assert.match(backgroundSource, /PAGE_QUERY_DEADLINE_MS = 2000/);
  assert.match(backgroundSource, /STREAM_FINAL_DEADLINE_MS = 30_000/);
  assert.match(backgroundSource, /indexedDB\.open/);
  assert.match(backgroundSource, /requestIndex/);
  assert.match(backgroundSource, /streamIndex/);
  assert.match(backgroundSource, /ambiguous-overlap/);
  assert.match(backgroundSource, /request-stream-mapping-ambiguous/);
  assert.match(backgroundSource, /page-query-deadline/);
  assert.match(backgroundSource, /stream-final-not-observed/);
  assert.match(backgroundSource, /kind === 'observer-installed'/);
  assert.match(backgroundSource, /main-observer-installed/);
  assert.match(backgroundSource, /chrome\.alarms\.create/);
  assert.match(backgroundSource, /chrome\.windows\.get/);
  assert.ok(
    backgroundSource.indexOf("files: ['hidden-window-diagnostics-page.js']") < backgroundSource.indexOf("files: ['hidden-window-diagnostics-main.js']"),
    'existing tabs must install the isolated bridge before the MAIN observer'
  );
  assert.doesNotMatch(backgroundSource, /\bfetch\s*\(/);
  assert.doesNotMatch(backgroundSource, /XMLHttpRequest/);
  assert.doesNotMatch(backgroundSource, /requestContinuation\s*\(/);
  assert.doesNotMatch(backgroundSource, /CHATGPT_CONTINUE_COMMAND/);
  assert.doesNotMatch(backgroundSource, /tabs\.update\([^)]*active:\s*true/);
  assert.doesNotMatch(backgroundSource, /windows\.update\([^)]*focused:\s*true/);
});

test('safe evidence projection retains incidents outside the flat diagnostic ring', () => {
  assert.match(sanitizerSource, /HiddenWindowIncident/);
  assert.match(sanitizerSource, /TakeLast\(48\)/);
  assert.match(sanitizerSource, /requestSuffix/);
  assert.match(sanitizerSource, /workerInstanceSuffix/);
  assert.doesNotMatch(sanitizerSource, /requestId\s*=/);

  assert.match(retentionSource, /MaxIncidents = 20/);
  assert.match(retentionSource, /MaxMetadataBytes = 128 \* 1024/);
  assert.match(retentionSource, /TryUpsert/);
  assert.match(publisherSource, /_hiddenWindowIncidents\.TryUpsert\(diagnostic\)/);
  assert.match(publisherSource, /hiddenWindowDiagnostics = _hiddenWindowIncidents\.Snapshot\(\)/);
  assert.match(safeEvidenceSource, /Copy-SafeHiddenWindowDiagnostics/);
  assert.match(safeEvidenceSource, /Select-Object -Last 20/);
  assert.match(safeEvidenceSource, /Select-Object -Last 48/);
  assert.match(safeEvidenceSource, /hiddenWindowDiagnostics/);
});