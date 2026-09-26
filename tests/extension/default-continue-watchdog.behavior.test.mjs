import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');
const invariantSource = readText('extension/watchdog-continuation-invariant-background.js');

function loadPolicy() {
  const context = vm.createContext({ Date, Number, String, Set, Map, Object, Math });
  vm.runInContext(readText('extension/status-code.js'), context);
  vm.runInContext(readText('extension/status-policy.js'), context);
  return context.ChatGPTNotifierContinuationPolicy;
}

function loadInvariant(now = 1_000_000) {
  class FakeRequest {
    constructor(result) {
      this.result = result;
      this.listeners = new Map();
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    fire(type) {
      this.listeners.get(type)?.();
    }
  }

  class FakeIDBObjectStore {
    constructor(name = 'profile') {
      this.name = name;
      this.records = new Map();
      this.lastPut = null;
    }
    get(key) {
      return new FakeRequest(this.records.get(String(key)) || null);
    }
    put(value) {
      this.lastPut = structuredClone(value);
      this.records.set(String(value?.key || ''), this.lastPut);
      return { ok: true };
    }
  }

  const alarms = [];
  const context = vm.createContext({
    IDBObjectStore: FakeIDBObjectStore,
    structuredClone,
    String,
    Number,
    Math,
    Map,
    Object,
    Date: { now: () => now },
    encodeURIComponent,
    chrome: { alarms: { create: (name, options) => alarms.push({ name, options }) } },
    ChatGPTNotifierContinuationPolicy: loadPolicy(),
    globalThis: null
  });
  context.globalThis = context;
  vm.runInContext(invariantSource, context);
  return { Store: FakeIDBObjectStore, alarms, invariant: context.__chatgptNotifierWatchdogContinuationInvariant };
}

function prime(store, record) {
  store.records.set(record.key, structuredClone(record));
  const request = store.get(record.key);
  request.fire('success');
}

test('work status defaults to continue unless the code is an explicit stop', () => {
  const policy = loadPolicy();
  assert.equal(policy.runtimeVersion, 11);
  assert.equal(policy.monitorPolicyVersion, 8);

  for (const code of ['INCOMPLETE_LIMIT', 'INCOMPLETE_TOOL_FAILURE', 'INCOMPLETE_CONTINUE', 'INCOMPLETE_HANDOFF']) {
    assert.equal(policy.isAutoContinueStatusCode(code), true, code);
    assert.equal(policy.isDefinitiveStopStatusCode(code), false, code);
  }
  for (const code of ['PLANNING_ACTIVE', 'COMPLETE_APPLIED', 'COMPLETE_NO_CHANGES', 'BLOCKED_HUMAN']) {
    assert.equal(policy.isDefinitiveStopStatusCode(code), true, code);
    assert.equal(policy.isAutoContinueStatusCode(code), false, code);
  }
});

test('INCOMPLETE_CONTINUE preserves existing watchdog attempts and countdown without scheduling from the invariant', () => {
  const { Store, alarms } = loadInvariant();
  const store = new Store();
  const key = 'code-watchdog:conversation-1';
  prime(store, {
    key,
    conversationId: 'conversation-1',
    sendCount: 2,
    deadlineAt: 2_000_000,
    retryAt: 0,
    retryReason: '',
    waitingForRequestStart: false,
    lastStatusCode: ''
  });

  store.put({
    key,
    conversationId: 'conversation-1',
    sendCount: 0,
    deadlineAt: 0,
    retryAt: 0,
    retryReason: '',
    waitingForRequestStart: true,
    stopped: false,
    lastStatusCode: 'INCOMPLETE_CONTINUE'
  });

  assert.equal(store.lastPut.sendCount, 2);
  assert.equal(store.lastPut.deadlineAt, 2_000_000);
  assert.equal(store.lastPut.retryAt, 0);
  assert.equal(alarms.length, 0);
});

test('an incomplete status with no surviving timer does not invent a one-minute continuation retry', () => {
  const { Store, alarms } = loadInvariant(1_000_000);
  const store = new Store();
  const key = 'code-watchdog:conversation-1';
  prime(store, {
    key,
    conversationId: 'conversation-1',
    sendCount: 1,
    deadlineAt: 0,
    retryAt: 0,
    waitingForRequestStart: false,
    lastStatusCode: ''
  });

  store.put({
    key,
    conversationId: 'conversation-1',
    sendCount: 0,
    deadlineAt: 0,
    retryAt: 0,
    waitingForRequestStart: true,
    stopped: false,
    lastStatusCode: 'INCOMPLETE_CONTINUE'
  });

  assert.equal(store.lastPut.sendCount, 1);
  assert.equal(store.lastPut.retryAt, 0);
  assert.ok(!store.lastPut.retryReason);
  assert.equal(alarms.length, 0);
});

test('the automatic request that follows an incomplete code preserves attempts already used', () => {
  const { Store } = loadInvariant();
  const store = new Store();
  const key = 'code-watchdog:conversation-1';
  prime(store, {
    key,
    conversationId: 'conversation-1',
    sendCount: 2,
    deadlineAt: 2_000_000,
    retryAt: 0,
    waitingForRequestStart: true,
    lastStatusCode: 'INCOMPLETE_CONTINUE'
  });

  store.put({
    key,
    conversationId: 'conversation-1',
    sendCount: 0,
    deadlineAt: 2_500_000,
    retryAt: 0,
    waitingForRequestStart: false,
    stopped: false,
    lastStatusCode: ''
  });

  assert.equal(store.lastPut.sendCount, 2);
  assert.equal(store.lastPut.deadlineAt, 2_500_000);
});

test('explicit operator resets and explicit stop states remain authoritative', () => {
  const { Store } = loadInvariant();
  const store = new Store();
  const key = 'code-watchdog:conversation-1';
  prime(store, {
    key,
    conversationId: 'conversation-1',
    sendCount: 2,
    deadlineAt: 2_000_000,
    retryAt: 0,
    waitingForRequestStart: true,
    budgetResetAt: 0,
    lastStatusCode: 'INCOMPLETE_CONTINUE'
  });

  store.put({
    key,
    conversationId: 'conversation-1',
    sendCount: 0,
    deadlineAt: 2_000_000,
    retryAt: 0,
    waitingForRequestStart: true,
    stopped: false,
    budgetResetAt: 1_000_001,
    lastStatusCode: 'INCOMPLETE_CONTINUE'
  });
  assert.equal(store.lastPut.sendCount, 0, 'manual reset may intentionally replenish the allowance');

  prime(store, {
    key,
    conversationId: 'conversation-1',
    sendCount: 2,
    deadlineAt: 2_000_000,
    retryAt: 0,
    waitingForRequestStart: false,
    stopped: false,
    lastStatusCode: ''
  });
  store.put({
    key,
    conversationId: 'conversation-1',
    sendCount: 0,
    deadlineAt: 0,
    retryAt: 0,
    waitingForRequestStart: false,
    stopped: true,
    stopReason: 'status:COMPLETE_APPLIED',
    lastStatusCode: 'COMPLETE_APPLIED'
  });
  assert.equal(store.lastPut.stopped, true);
  assert.equal(store.lastPut.deadlineAt, 0);
  assert.equal(store.lastPut.sendCount, 0);
});

test('production background loads the watchdog continuation invariant immediately after the monitor owner', () => {
  const background = readText('extension/background.js');
  assert.match(background, /monitor-background\.js[\s\S]*watchdog-continuation-invariant-background\.js[\s\S]*monitor-query-compat-background\.js/);
});
