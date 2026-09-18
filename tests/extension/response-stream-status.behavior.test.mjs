import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const mainSource = readFileSync(new URL('../../extension/response-stream-status-main.js', import.meta.url), 'utf8');
const bridgeSource = readFileSync(new URL('../../extension/response-stream-status-bridge.js', import.meta.url), 'utf8');
const backgroundSource = readFileSync(new URL('../../extension/response-stream-status-background.js', import.meta.url), 'utf8');
const serviceWorkerSource = readFileSync(new URL('../../extension/service-worker.js', import.meta.url), 'utf8');

function streamResponse(chunks, onClone = () => {}) {
  return {
    clone() {
      onClone();
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
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test('response-stream sources are valid JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(mainSource));
  assert.doesNotThrow(() => new vm.Script(bridgeSource));
  assert.doesNotThrow(() => new vm.Script(backgroundSource));
  assert.doesNotThrow(() => new vm.Script(serviceWorkerSource));
});

test('MAIN-world observer tees the existing fetch once and emits only the terminal status token', async () => {
  const posted = [];
  const calls = [];
  let clones = 0;
  const response = streamResponse([
    'data: {"text":"finished\\n[GITHUB_STA',
    'TUS: COMPLETE_NO_CHANGES]"}\n\ndata: [DONE]\n\n'
  ], () => { clones += 1; });

  const window = {
    fetch: async (...args) => {
      calls.push(args);
      return response;
    },
    postMessage(message, origin) {
      posted.push({ message, origin });
    }
  };
  const context = vm.createContext({
    console,
    window,
    globalThis: window,
    location: {
      href: 'https://chatgpt.com/c/conversation-1',
      origin: 'https://chatgpt.com'
    },
    URL,
    TextDecoder,
    TextEncoder,
    Request: undefined,
    XMLHttpRequest: undefined,
    Symbol,
    Promise
  });

  vm.runInContext(mainSource, context);
  const returned = await window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST' });
  await settle();

  assert.equal(returned, response);
  assert.equal(calls.length, 1, 'the observer must not issue a second ChatGPT request');
  assert.equal(clones, 1);
  const terminal = posted.find((item) => item.message?.kind === 'terminal-status');
  assert.ok(terminal);
  assert.deepEqual(
    JSON.parse(JSON.stringify(terminal.message)),
    {
      marker: 'chatgpt-response-notifier-stream-status-v1',
      kind: 'terminal-status',
      statusCode: 'COMPLETE_NO_CHANGES',
      transport: 'fetch'
    }
  );
  assert.equal(posted.some((item) => 'responseText' in (item.message || {}) || 'responseBody' in (item.message || {})), false);
});

test('MAIN-world observer ignores unrelated fetches', async () => {
  const posted = [];
  let calls = 0;
  let clones = 0;
  const response = streamResponse(['[GITHUB_STATUS: COMPLETE_APPLIED]'], () => { clones += 1; });
  const window = {
    fetch: async () => { calls += 1; return response; },
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
    Promise
  });

  vm.runInContext(mainSource, context);
  await window.fetch('https://chatgpt.com/backend-api/models', { method: 'GET' });
  await settle();
  assert.equal(calls, 1);
  assert.equal(clones, 0);
  assert.equal(posted.length, 0);
});

test('isolated bridge validates status grammar and forwards no response content', async () => {
  const listeners = [];
  const sent = [];
  const window = {
    addEventListener(type, listener) { if (type === 'message') listeners.push(listener); }
  };
  const context = vm.createContext({
    window,
    location: { origin: 'https://chatgpt.com' },
    ChatGPTNotifierStatusCode: {
      isStatusCode(value) { return ['COMPLETE_NO_CHANGES', 'INCOMPLETE_LIMIT'].includes(String(value || '')); }
    },
    chrome: {
      runtime: {
        sendMessage(message) {
          sent.push(message);
          return Promise.resolve();
        }
      }
    },
    Set,
    String,
    Promise
  });
  vm.runInContext(bridgeSource, context);
  assert.equal(listeners.length, 1);

  listeners[0]({
    source: window,
    origin: 'https://chatgpt.com',
    data: {
      marker: 'chatgpt-response-notifier-stream-status-v1',
      kind: 'terminal-status',
      statusCode: 'COMPLETE_NO_CHANGES',
      transport: 'fetch',
      responseText: 'must not cross the bridge'
    }
  });
  listeners[0]({
    source: window,
    origin: 'https://chatgpt.com',
    data: {
      marker: 'chatgpt-response-notifier-stream-status-v1',
      kind: 'terminal-status',
      statusCode: 'NOT_A_REAL_CODE',
      transport: 'fetch'
    }
  });
  await settle();

  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{
    type: 'CHATGPT_RESPONSE_STREAM_TERMINAL_STATUS',
    statusCode: 'COMPLETE_NO_CHANGES',
    transport: 'fetch'
  }]);
});

test('stream delivery remains notification-only while automatic Continue stays DOM verified', () => {
  assert.match(backgroundSource, /state\.queueNotification\('', notification, fingerprint\)/);
  assert.match(backgroundSource, /getEnrollment/);
  assert.match(backgroundSource, /userPaused === true/);
  assert.match(backgroundSource, /response-stream-late-dom-notification-suppressed/);
  assert.doesNotMatch(backgroundSource, /requestContinuation\s*\(/);
  assert.doesNotMatch(backgroundSource, /CHATGPT_CONTINUE_COMMAND/);
  assert.doesNotMatch(backgroundSource, /tabs\.update\([^)]*active:\s*true/);
  assert.doesNotMatch(backgroundSource, /windows\.update\([^)]*focused:\s*true/);
  assert.doesNotMatch(backgroundSource, /api\/auth\/session/i);
});


test('stream early notification uses shared request delivery authority before durable queueing', () => {
  const start = backgroundSource.indexOf('async function queueEarlyNotification');
  const end = backgroundSource.indexOf('async function handleTerminalStatus', start);
  assert.ok(start >= 0 && end > start);
  const queueSource = backgroundSource.slice(start, end);

  const sharedLookup = queueSource.indexOf('__chatgptNotifierDeliveryDedupeHook');
  const sharedReserve = queueSource.indexOf('reserveRequestDelivery');
  const durableQueue = queueSource.indexOf("state.queueNotification('', notification, fingerprint)");
  const sharedCommit = queueSource.indexOf('commitRequestDelivery');

  assert.ok(sharedLookup >= 0);
  assert.ok(sharedReserve > sharedLookup);
  assert.ok(durableQueue > sharedReserve, 'shared request ownership must be reserved before the stream path enters the durable outbox');
  assert.ok(sharedCommit > durableQueue, 'shared ownership commits only after durable queueing succeeds');
  assert.match(queueSource, /response-stream-shared-delivery-suppressed/);
  assert.match(queueSource, /shared-request-delivery-authority-unavailable/);
  assert.match(queueSource, /releaseRequestDelivery/);
});

test('terminal stream routing never waits on a live page reply', () => {
  assert.match(backgroundSource, /PAGE_QUERY_TIMEOUT_MS = 1500/);
  assert.match(backgroundSource, /Promise\.race\(\[query, deadline\]\)/);
  assert.match(backgroundSource, /conversationFromUrl\(details\.documentUrl \|\| ''\)/);

  const currentStart = backgroundSource.indexOf('function currentContext(sender)');
  const identityStart = backgroundSource.indexOf('async function identityForStreamEvent', currentStart);
  const queueStart = backgroundSource.indexOf('async function queueEarlyNotification', identityStart);
  assert.ok(currentStart >= 0 && identityStart > currentStart && queueStart > identityStart);

  const currentSource = backgroundSource.slice(currentStart, identityStart);
  const identitySource = backgroundSource.slice(identityStart, queueStart);
  assert.doesNotMatch(currentSource, /await\s+context\.capturePromise/);
  assert.doesNotMatch(identitySource, /queryMonitorSnapshot\s*\(/);
  assert.match(identitySource, /requestConversation \|\| senderConversation/);
  assert.match(identitySource, /terminal-status-routed-from-request-document-identity/);
});

test('stream dedupe carries exact request identity when page prompt identity is unavailable', () => {
  assert.match(backgroundSource, /const requestId = String\(turnRecord\?\.requestId \|\| ''\)/);
  assert.match(backgroundSource, /getEarlyDelivery\(\{ conversationId, requestId, promptKey \}\)/);
  assert.match(backgroundSource, /ACTIVE_CONTEXT_TTL_MS = 60 \* 60 \* 1000/);
  assert.match(backgroundSource, /SETTLED_CONTEXT_TTL_MS = 10 \* 60 \* 1000/);
  assert.match(backgroundSource, /function requestOwnerForTurn/);
  assert.match(backgroundSource, /exactPrompt\.length === 1/);
  assert.match(backgroundSource, /exactPrompt\.length > 1\) return null/);
  assert.match(backgroundSource, /requestOwnerForTurn,/);
  assert.match(serviceWorkerSource, /__chatgptNotifierResponseStreamStatus\?\.requestOwnerForTurn/);
  assert.match(serviceWorkerSource, /message\?\.requestId \|\| requestOwner\?\.requestId/);
  assert.match(serviceWorkerSource, /if \(!requestId\) return null;/);
});

test('request completion arms durable worker DOM fallback without generating ChatGPT traffic', () => {
  assert.match(backgroundSource, /__chatgptNotifierObservationScheduler\?\.observeRequestCompletion\?\.\(details\)/);
  assert.match(serviceWorkerSource, /__chatgptNotifierWorkerTerminalFallback/);
  assert.match(serviceWorkerSource, /handleWorkerObservedTerminalStatus/);
  assert.match(serviceWorkerSource, /queryImmediateTerminalStatus/);
  assert.match(serviceWorkerSource, /timeoutMs: 1/);
  assert.match(serviceWorkerSource, /request-identity-mismatch/);
  assert.match(serviceWorkerSource, /prompt-identity-mismatch/);
  assert.match(serviceWorkerSource, /assistant-identity-mismatch/);
  assert.match(serviceWorkerSource, /processCodedCompletion/);
  assert.doesNotMatch(serviceWorkerSource.slice(
    serviceWorkerSource.indexOf('async function handleWorkerObservedTerminalStatus'),
    serviceWorkerSource.indexOf('globalThis.__chatgptNotifierWorkerTerminalFallback')
  ), /\bfetch\s*\(|XMLHttpRequest|backend-api/);
});

test('MAIN observer does not poll ChatGPT or use extension privileges', () => {
  assert.match(mainSource, /nativeFetch\.apply\(this, arguments\)/);
  assert.match(mainSource, /response\.clone\(\)/);
  assert.match(mainSource, /clone\.body\.getReader\(\)/);
  assert.match(mainSource, /TAIL_LIMIT = 512/);
  assert.doesNotMatch(mainSource, /chrome\./);
  assert.doesNotMatch(mainSource, /setInterval/);
  assert.doesNotMatch(mainSource, /api\/auth\/session/i);
  assert.doesNotMatch(mainSource, /Regenerate/i);
});
