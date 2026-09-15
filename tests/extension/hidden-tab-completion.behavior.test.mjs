import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import './request-completion-status-probe.behavior.test.mjs';
import './response-stream-status.behavior.test.mjs';

const source = readFileSync(new URL('../../extension/content-script.js', import.meta.url), 'utf8');
const lifecycleSource = readFileSync(new URL('../../extension/tab-lifecycle-diagnostics-background.js', import.meta.url), 'utf8');

function createRuntime(initialVisibility) {
  let visibilityState = initialVisibility;
  let now = 0;
  let nextTimerId = 1;
  let nextFrameId = 1;
  const timers = new Map();
  const frames = new Map();
  const listeners = new Map();
  const messages = [];
  const runtimeListeners = [];
  const observers = [];
  const turns = [];
  let cancelledFrame = null;

  class FakeElement {}

  function roleNode(role, text = '') {
    return {
      textContent: text,
      innerText: text,
      matches(selector) {
        return selector === `[data-message-author-role="${role}"]`;
      },
      querySelector(selector) {
        if (selector === '.markdown, [class*="prose"]') return this;
        return null;
      }
    };
  }

  function turn(role, id, text = '') {
    const node = roleNode(role, text);
    return {
      parentElement: null,
      getAttribute(name) {
        if (name === 'data-turn' || name === 'data-message-author-role') return role;
        if (name === 'data-testid') return id;
        return '';
      },
      querySelector(selector) {
        if (selector === `[data-message-author-role="${role}"]`) return node;
        return null;
      },
      matches() { return false; },
      closest() { return null; }
    };
  }

  const root = {};
  const document = {
    title: 'Hidden tab test',
    body: root,
    documentElement: root,
    get visibilityState() { return visibilityState; },
    hasFocus: () => visibilityState === 'visible',
    querySelectorAll: () => turns,
    querySelector: (selector) => selector === 'main' ? root : null,
    addEventListener(type, listener) {
      const bucket = listeners.get(type) || [];
      bucket.push(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      const bucket = listeners.get(type) || [];
      listeners.set(type, bucket.filter((item) => item !== listener));
    }
  };

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe() {}
    disconnect() {}
  }

  const context = vm.createContext({
    console,
    document,
    window: { addEventListener() {} },
    location: { pathname: '/c/test' },
    Element: FakeElement,
    MutationObserver: FakeMutationObserver,
    performance: { now: () => now },
    setTimeout(fn, delay) {
      const id = nextTimerId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) {
      const id = nextFrameId++;
      frames.set(id, fn);
      return id;
    },
    cancelAnimationFrame(id) {
      cancelledFrame = id;
      frames.delete(id);
    },
    chrome: {
      runtime: {
        onMessage: { addListener: (listener) => runtimeListeners.push(listener) },
        sendMessage: async (message) => { messages.push(message); }
      }
    }
  });
  vm.runInContext(source, context);

  return {
    turns,
    turn,
    messages,
    observers,
    frames,
    cancelledFrame: () => cancelledFrame,
    hasTimer(delay) { return [...timers.values()].some((value) => value.delay === delay); },
    arm() { runtimeListeners[0]({ type: 'CHATGPT_CONVERSATION_REQUEST_COMPLETED' }); },
    runTimer(delay) {
      const entry = [...timers.entries()].find(([, value]) => value.delay === delay);
      assert.ok(entry, `timer ${delay} should exist`);
      timers.delete(entry[0]);
      now += delay;
      entry[1].fn();
    },
    mutate() { observers.at(-1).callback([]); },
    hide() {
      visibilityState = 'hidden';
      for (const listener of listeners.get('visibilitychange') || []) listener();
    }
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

test('hidden completion check bypasses both page timer and requestAnimationFrame', async () => {
  const runtime = createRuntime('hidden');
  runtime.turns.push(runtime.turn('user', 'conversation-turn-1'));
  runtime.arm();
  runtime.turns.push(runtime.turn('assistant', 'conversation-turn-2', 'Finished while hidden'));
  runtime.mutate();
  await flush();

  assert.equal(runtime.hasTimer(150), false);
  assert.equal(runtime.frames.size, 0);
  assert.equal(runtime.messages.at(-1)?.type, 'CHATGPT_RESPONSE_COMPLETE');
  assert.equal(runtime.messages.at(-1)?.response, 'Finished while hidden');
});

test('switching hidden rescues a pending throttle timer before it fires', async () => {
  const runtime = createRuntime('visible');
  runtime.turns.push(runtime.turn('user', 'conversation-turn-1'));
  runtime.arm();
  runtime.turns.push(runtime.turn('assistant', 'conversation-turn-2', 'Finished before timer'));
  runtime.mutate();

  assert.equal(runtime.hasTimer(150), true);
  runtime.hide();
  await flush();

  assert.equal(runtime.hasTimer(150), false);
  assert.equal(runtime.frames.size, 0);
  assert.equal(runtime.messages.at(-1)?.type, 'CHATGPT_RESPONSE_COMPLETE');
  assert.equal(runtime.messages.at(-1)?.response, 'Finished before timer');
});

test('switching hidden rescues an already scheduled animation frame', async () => {
  const runtime = createRuntime('visible');
  runtime.turns.push(runtime.turn('user', 'conversation-turn-1'));
  runtime.arm();
  runtime.turns.push(runtime.turn('assistant', 'conversation-turn-2', 'Finished before tab switch'));
  runtime.mutate();
  runtime.runTimer(150);

  assert.equal(runtime.frames.size, 1);
  runtime.hide();
  await flush();

  assert.notEqual(runtime.cancelledFrame(), null);
  assert.equal(runtime.frames.size, 0);
  assert.equal(runtime.messages.at(-1)?.type, 'CHATGPT_RESPONSE_COMPLETE');
  assert.equal(runtime.messages.at(-1)?.response, 'Finished before tab switch');
});

test('tab lifecycle diagnostics are sanitized and observe request completion plus frozen/discarded changes', () => {
  assert.doesNotThrow(() => new vm.Script(lifecycleSource));
  assert.match(lifecycleSource, /request-completed-tab-lifecycle/);
  assert.match(lifecycleSource, /tab-lifecycle-change/);
  assert.match(lifecycleSource, /tab\?\.frozen === true/);
  assert.match(lifecycleSource, /tab\?\.discarded === true/);
  assert.match(lifecycleSource, /tab\?\.active === true/);
  assert.match(lifecycleSource, /chrome\.webRequest\.onCompleted\.addListener/);
  assert.match(lifecycleSource, /chrome\.tabs\.onUpdated\.addListener/);
  assert.doesNotMatch(lifecycleSource, /promptText|assistantText|responseText|responseBody/);
});
