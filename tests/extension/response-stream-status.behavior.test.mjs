import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const mainSource = readFileSync(new URL('../../extension/response-stream-status-main.js', import.meta.url), 'utf8');
const bridgeSource = readFileSync(new URL('../../extension/response-stream-status-bridge.js', import.meta.url), 'utf8');
const backgroundSource = readFileSync(new URL('../../extension/response-stream-status-background.js', import.meta.url), 'utf8');

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
