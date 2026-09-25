import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('extension/watchdog-continuation-invariant-background.js', root), 'utf8');
const statusCodeSource = readFileSync(new URL('extension/status-code.js', root), 'utf8');
const statusPolicySource = readFileSync(new URL('extension/status-policy.js', root), 'utf8');

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

  const createdAlarms = [];
  const clearedAlarms = [];
  const context = vm.createContext({
    IDBObjectStore: FakeIDBObjectStore,
    structuredClone,
    String,
    Number,
    Math,
    Map,
    Object,
    Set,
    Date: { now: () => now },
    encodeURIComponent,
    chrome: {
      alarms: {
        create: (name, options) => createdAlarms.push({ name, options }),
        clear: (name) => {
          clearedAlarms.push(name);
          return Promise.resolve(true);
        }
      }
    },
    globalThis: null
  });
  context.globalThis = context;
  vm.runInContext(statusCodeSource, context);
  vm.runInContext(statusPolicySource, context);
  vm.runInContext(source, context);
  return { Store: FakeIDBObjectStore, createdAlarms, clearedAlarms, invariant: context.__chatgptNotifierWatchdogContinuationInvariant };
}

function prime(store, record) {
  store.records.set(record.key, structuredClone(record));
  const request = store.get(record.key);
  request.fire('success');
}

test('definitive stop atomically zeros timer and attempts and records a terminal boundary', () => {
  const now = 1_000_000;
  const { Store, clearedAlarms, invariant } = loadInvariant(now);
  const store = new Store();
  const key = 'code-watchdog:conversation-1';
  prime(store, {
    key,
    conversationId: 'conversation-1',
    sendCount: 2,
    lastRequestStartedAt: 900_000,
    deadlineAt: 1_500_000,
    retryAt: 0,
    stopped: false,
    stopReason: ''
  });

  store.put({
    key,
    conversationId: 'conversation-1',
    sendCount: 2,
    lastRequestStartedAt: 900_000,
    deadlineAt: 1_500_000,
    retryAt: 0,
    stopped: true,
    stopReason: 'status:COMPLETE_APPLIED',
    lastStatusCode: 'COMPLETE_APPLIED'
  });

  assert.equal(invariant.version, 2);
  assert.equal(store.lastPut.stopped, true);
  assert.equal(store.lastPut.stopReason, 'status:COMPLETE_APPLIED');
  assert.equal(store.lastPut.sendCount, 0);
  assert.equal(store.lastPut.deadlineAt, 0);
  assert.equal(store.lastPut.retryAt, 0);
  assert.equal(store.lastPut.waitingForRequestStart, false);
  assert.equal(store.lastPut.terminalStoppedAt, now);
  assert.equal(clearedAlarms.at(-1), 'chatgpt-notifier-code-watchdog:conversation-1');
});

test('late stale active writes cannot reopen a definitive stop', () => {
  const now = 1_000_000;
  const { Store } = loadInvariant(now);
  const store = new Store();
  const key = 'code-watchdog:conversation-1';
  prime(store, {
    key,
    conversationId: 'conversation-1',
    sendCount: 0,
    lastRequestStartedAt: 900_000,
    stopped: true,
    stopReason: 'status:BLOCKED_HUMAN',
    lastStatusCode: 'BLOCKED_HUMAN',
    terminalStoppedAt: 995_000,
    deadlineAt: 0,
    retryAt: 0
  });

  store.put({
    key,
    conversationId: 'conversation-1',
    sendCount: 1,
    lastRequestStartedAt: 900_000,
    stopped: false,
    stopReason: '',
    lastStatusCode: '',
    deadlineAt: 1_700_000,
    retryAt: 0
  });

  assert.equal(store.lastPut.stopped, true);
  assert.equal(store.lastPut.stopReason, 'status:BLOCKED_HUMAN');
  assert.equal(store.lastPut.sendCount, 0);
  assert.equal(store.lastPut.deadlineAt, 0);
  assert.equal(store.lastPut.retryAt, 0);
  assert.equal(store.lastPut.terminalStoppedAt, 995_000);
});

test('a newer request timestamp alone cannot reopen a terminal-stopped watchdog', () => {
  const { Store } = loadInvariant(1_000_000);
  const store = new Store();
  const key = 'code-watchdog:conversation-1';
  prime(store, {
    key,
    conversationId: 'conversation-1',
    sendCount: 0,
    lastRequestStartedAt: 900_000,
    stopped: true,
    stopReason: 'status:COMPLETE_APPLIED',
    lastStatusCode: 'COMPLETE_APPLIED',
    terminalStoppedAt: 995_000,
    deadlineAt: 0,
    retryAt: 0
  });

  store.put({
    key,
    conversationId: 'conversation-1',
    sendCount: 0,
    lastRequestStartedAt: 1_010_000,
    stopped: false,
    stopReason: '',
    lastStatusCode: '',
    deadlineAt: 2_810_000,
    retryAt: 0
  });

  assert.equal(store.lastPut.stopped, true);
  assert.equal(store.lastPut.stopReason, 'status:COMPLETE_APPLIED');
  assert.equal(store.lastPut.deadlineAt, 0);
  assert.equal(store.lastPut.terminalStoppedAt, 995_000);
});

test('an explicit trusted user arm may reset a terminal stop to a fresh 30-minute timer', () => {
  const now = 1_000_000;
  const { Store } = loadInvariant(now);
  const store = new Store();
  const key = 'code-watchdog:conversation-1';
  prime(store, {
    key,
    conversationId: 'conversation-1',
    sendCount: 0,
    lastRequestStartedAt: 900_000,
    stopped: true,
    stopReason: 'status:COMPLETE_APPLIED',
    lastStatusCode: 'COMPLETE_APPLIED',
    terminalStoppedAt: 995_000,
    operatorPromptArmedAt: 0,
    deadlineAt: 0,
    retryAt: 0
  });

  store.put({
    key,
    conversationId: 'conversation-1',
    sendCount: 0,
    lastRequestStartedAt: 1_010_000,
    stopped: false,
    stopReason: '',
    lastStatusCode: '',
    operatorPromptArmedAt: now,
    deadlineAt: now + (30 * 60_000),
    retryAt: 0
  });

  assert.equal(store.lastPut.stopped, false);
  assert.equal(store.lastPut.stopReason, '');
  assert.equal(store.lastPut.sendCount, 0);
  assert.equal(store.lastPut.deadlineAt, now + (30 * 60_000));
  assert.equal(store.lastPut.terminalStoppedAt, 0);
});
