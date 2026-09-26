// Safe watchdog-cadence acceptance reproductions for Notifier 0.9.89+.
// No browser, network, ChatGPT, or real-message actions are performed.
// Run: node tools/reproduce-watchdog-cadence-20260926.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');
const D = 30 * 60_000;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class FakeTransaction {
  constructor(database, names, startPromise = Promise.resolve(), release = null) {
    this.database = database;
    this.names = Array.isArray(names) ? names : [names];
    this.startPromise = startPromise;
    this.release = release;
    this.pending = 0;
    this.finished = false;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
  }

  objectStore(name) {
    if (!this.names.includes(name)) throw new Error(`Store ${name} is outside transaction`);
    return new FakeStore(this, this.database.stores.get(name), name);
  }

  request(action) {
    this.pending += 1;
    const handlers = [];
    const request = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      addEventListener(kind, fn) { if (kind === 'success') handlers.push(fn); }
    };
    this.startPromise.then(() => queueMicrotask(() => {
      if (this.finished) return;
      try {
        request.result = action();
        handlers.forEach((fn) => fn());
        request.onsuccess?.();
      } catch (error) {
        request.error = error;
        this.error = error;
        request.onerror?.();
        this.finished = true;
        this.release?.();
        this.onerror?.();
        this.onabort?.();
        return;
      } finally {
        this.pending -= 1;
      }
      this.maybeComplete();
    }));
    return request;
  }

  maybeComplete() {
    if (this.finished || this.pending !== 0) return;
    setTimeout(() => {
      if (this.finished || this.pending !== 0) return;
      this.finished = true;
      this.release?.();
      this.oncomplete?.();
    }, 0);
  }
}

class FakeStore {
  constructor(transaction, definition, name) {
    this.name = name;
    this.transaction = transaction;
    this.definition = definition;
  }

  keyOf(value) { return value?.[this.definition.keyPath]; }
  get(key) { return this.transaction.request(() => clone(this.definition.records.get(key))); }
  getAll() { return this.transaction.request(() => Array.from(this.definition.records.values(), clone)); }
  put(value) {
    return this.transaction.request(() => {
      const key = this.keyOf(value);
      this.definition.records.set(key, clone(value));
      return key;
    });
  }
  delete(key) { return this.transaction.request(() => this.definition.records.delete(key)); }
}

class FakeDatabase {
  close() {}
  constructor() {
    this.stores = new Map();
    this.objectStoreNames = { contains: (name) => this.stores.has(name) };
    this.writeTail = Promise.resolve();
  }

  createObjectStore(name, options) {
    this.stores.set(name, { keyPath: options.keyPath, records: new Map() });
    return this.stores.get(name);
  }

  transaction(names, mode = 'readonly') {
    let startPromise = Promise.resolve();
    let release = null;
    if (mode === 'readwrite') {
      startPromise = this.writeTail;
      let unlock;
      const held = new Promise((resolve) => { unlock = resolve; });
      this.writeTail = startPromise.then(() => held);
      release = unlock;
    }
    const transaction = new FakeTransaction(this, names, startPromise, release);
    queueMicrotask(() => transaction.maybeComplete());
    return transaction;
  }
}

function fakeIndexedDb() {
  const databases = new Map();
  return {
    databases,
    open(name) {
      const request = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        const created = !databases.has(name);
        if (created) databases.set(name, new FakeDatabase());
        request.result = databases.get(name);
        if (created) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    }
  };
}

function eventHub() {
  const listeners = [];
  return { listeners, addListener(listener) { listeners.push(listener); }, removeListener(listener) {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  } };
}

async function tick(count = 3) {
  for (let index = 0; index < count; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

let now = 10_000_000;
class Clock extends Date { static now() { return now; } }

function loadHarness() {
  let uuid = 0;
  const runtimeOnMessage = eventHub();
  const tabsOnUpdated = eventHub();
  const tabsOnRemoved = eventHub();
  const webBefore = eventHub();
  const webCompleted = eventHub();
  const webError = eventHub();
  const alarmsOnAlarm = eventHub();
  const alarmState = new Map();
  const indexedDB = fakeIndexedDb();
  const tabs = [{ id: 1, url: 'https://chatgpt.com/c/bootstrap', title: 'Build chat', discarded: false, frozen: false, active: true }];

  const chrome = {
    runtime: {
      onMessage: runtimeOnMessage,
      getManifest: () => ({ version: '0.9.89' })
    },
    alarms: {
      onAlarm: alarmsOnAlarm,
      create(name, info = {}) { alarmState.set(String(name), clone(info)); },
      async clear(name) { return alarmState.delete(String(name)); }
    },
    webRequest: { onBeforeRequest: webBefore, onCompleted: webCompleted, onErrorOccurred: webError },
    tabs: {
      onUpdated: tabsOnUpdated,
      onRemoved: tabsOnRemoved,
      async query() { return tabs.map(clone); },
      async get(tabId) {
        const tab = tabs.find((entry) => entry.id === tabId);
        if (!tab) throw new Error('No tab');
        return clone(tab);
      },
      async sendMessage(_tabId, message) {
        if (message?.type === 'CHATGPT_MONITOR_QUERY') return { snapshot: null };
        if (message?.type === 'CHATGPT_NOTIFIER_ATTACHMENT_PING') return { ok: true, runtimeVersion: 99, extensionVersion: '0.9.89' };
        if (message?.type === 'CHATGPT_STATUS_RUNTIME_PING') return { ok: true, runtimeVersion: 99 };
        if (message?.type === 'CHATGPT_BOUNDED_RECOVERY_PING') return { ok: true, runtimeVersion: 99 };
        return { ok: true };
      }
    },
    scripting: { async executeScript() {} }
  };

  const context = vm.createContext({
    chrome,
    IDBObjectStore: FakeStore,
    indexedDB,
    structuredClone: clone,
    crypto: { randomUUID: () => `uuid-${++uuid}` },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Date: Clock,
    Number,
    String,
    Array,
    Set,
    Map,
    Math,
    URL,
    console
  });
  vm.runInContext(readText('extension/status-code.js'), context);
  vm.runInContext(readText('extension/status-policy.js'), context);
  vm.runInContext(readText('extension/monitor-background.js'), context);
  vm.runInContext(readText('extension/watchdog-continuation-invariant-background.js'), context);
  return {
    context,
    indexedDB,
    alarmState,
    monitor: context.__chatgptNotifierMonitorBackground,
    cadence: context.__chatgptNotifierWatchdogContinuationInvariant
  };
}

async function putRecord(database, storeName, record) {
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(record);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('write failed'));
    transaction.onabort = () => reject(transaction.error || new Error('write aborted'));
  });
}

async function seedConversation(harness, id, recordPatch = {}) {
  const url = `https://chatgpt.com/c/${id}`;
  await harness.monitor.setEnrollment({ id, url }, true, 'operator');
  const database = harness.indexedDB.databases.get('chatgpt-response-notifier-monitor');
  const promptKey = `${id}|user-1`;
  const record = {
    key: `code-watchdog:${id}`,
    conversationId: id,
    conversationUrl: url,
    ownerTabId: 1,
    sendCount: 0,
    stopped: false,
    stopReason: '',
    waitingForRequestStart: false,
    lastRequestStartedAt: now - D,
    lastPromptKey: promptKey,
    lastStatusCode: '',
    deadlineAt: now,
    retryAt: 0,
    retryReason: '',
    ...recordPatch
  };
  await putRecord(database, 'profile', record);
  await tick();
  return { url, promptKey, sender: { tab: { id: 1, url } } };
}

function dueCadencePatch() {
  return {
    cadenceSchemaVersion: 1,
    cadenceEpoch: 1,
    cadenceSendCount: 0,
    cadenceAttempt: null,
    nextSendEligibleAt: 0
  };
}

const harness = loadHarness();
await tick(6);
assert.equal(harness.cadence.version, 4, 'cadence owner v4 must be loaded');

// 1. A stale alarm cannot authorize a click before the persisted deadline.
now = 10_000_000;
{
  const target = await seedConversation(harness, 'future-deadline', { deadlineAt: now + D });
  const auth = await harness.cadence.authorizePageDispatch({
    conversationId: 'future-deadline', promptKey: target.promptKey, documentId: 'document-future'
  }, target.sender);
  assert.equal(auth.granted, false, 'future deadline must not authorize a watchdog click');
  const state = await harness.cadence.readWatchdog('future-deadline');
  assert.ok(state.nextSendEligibleAt >= now + D, 'migration preserves the future 30-minute floor');
  console.log(JSON.stringify({ scenario: 'future-deadline stale alarm', clicks: 0, granted: auth.granted, nextSendEligibleAt: state.nextSendEligibleAt }));
}

// 2. Two concurrent wake signals serialize on one durable reservation.
now = 20_000_000;
{
  const target = await seedConversation(harness, 'concurrent-due', dueCadencePatch());
  const request = () => harness.cadence.authorizePageDispatch({
    conversationId: 'concurrent-due', promptKey: target.promptKey, documentId: 'document-concurrent'
  }, target.sender);
  const results = await Promise.all([request(), request()]);
  const granted = results.filter((entry) => entry.granted === true);
  assert.equal(granted.length, 1, 'exactly one concurrent wake may reserve the interval');
  assert.equal(results.filter((entry) => entry.syntheticSuccess === true).length, 1, 'the losing wake must observe the consumed reservation');
  const state = await harness.cadence.readWatchdog('concurrent-due');
  assert.equal(state.sendCount, 1, 'attempt budget is consumed before page dispatch');
  assert.equal(state.cadenceSendCount, 1, 'cadence budget is durable before page dispatch');
  console.log(JSON.stringify({ scenario: 'concurrent due signals', reservations: granted.length, sendCount: state.sendCount, nextSendEligibleAt: state.nextSendEligibleAt }));
}

// 3. clicked=true with no confirmation becomes unknown and cannot retry after 60 seconds.
now = 30_000_000;
{
  const target = await seedConversation(harness, 'clicked-unconfirmed', dueCadencePatch());
  const auth = await harness.cadence.authorizePageDispatch({
    conversationId: 'clicked-unconfirmed', promptKey: target.promptKey, documentId: 'document-unknown'
  }, target.sender);
  assert.equal(auth.granted, true, 'due interval must reserve once');
  const clickedAt = now + 100;
  const finalized = await harness.cadence.finalizePageDispatch({
    conversationId: 'clicked-unconfirmed', promptKey: target.promptKey, documentId: 'document-unknown',
    attemptId: auth.attemptId, clicked: true, clickedAt, ok: false, reason: 'continuation-user-turn-not-confirmed'
  }, target.sender);
  assert.equal(finalized.outcome, 'unknown', 'unconfirmed click must remain an unknown side effect');
  now += 60_000;
  const retry = await harness.cadence.authorizePageDispatch({
    conversationId: 'clicked-unconfirmed', promptKey: target.promptKey, documentId: 'document-unknown'
  }, target.sender);
  assert.equal(retry.granted, false, 'unknown side effect must not authorize a one-minute replay');
  assert.equal(retry.syntheticSuccess, true, 'legacy caller gets a consumed-attempt acknowledgement instead of replay authority');
  const state = await harness.cadence.readWatchdog('clicked-unconfirmed');
  assert.equal(state.sendCount, 1, 'unknown click consumes exactly one attempt');
  assert.equal(state.retryAt, 0, 'unknown click cannot create a one-minute send retry');
  assert.ok(state.deadlineAt >= auth.authorizationExpiresAt + D, 'unknown outcome keeps a conservative full 30-minute floor');
  console.log(JSON.stringify({ scenario: 'clicked but unconfirmed', clicks: 1, replayGranted: retry.granted, sendCount: state.sendCount, deadlineAt: state.deadlineAt }));
}

// 4. Losing the response port after a possible click cannot replay the command immediately.
now = 40_000_000;
{
  const target = await seedConversation(harness, 'transport-loss', dueCadencePatch());
  const first = await harness.cadence.authorizePageDispatch({
    conversationId: 'transport-loss', promptKey: target.promptKey, documentId: 'document-loss'
  }, target.sender);
  assert.equal(first.granted, true, 'first command reserves the interval');
  // Simulate the page click happening and the reply port disappearing before finalization.
  const clicks = 1;
  const replay = await harness.cadence.authorizePageDispatch({
    conversationId: 'transport-loss', promptKey: target.promptKey, documentId: 'document-loss'
  }, target.sender);
  assert.equal(replay.granted, false, 'lost acknowledgement must not authorize immediate replay');
  assert.equal(replay.syntheticSuccess, true, 'duplicate command is acknowledged as already consumed');
  assert.equal(replay.attemptId, first.attemptId, 'duplicate command resolves against the durable reservation');
  const state = await harness.cadence.readWatchdog('transport-loss');
  assert.equal(state.sendCount, 1, 'transport uncertainty consumes one attempt before any reply');
  assert.ok(state.deadlineAt >= first.authorizationExpiresAt + D, 'transport uncertainty reserves the next full interval');
  console.log(JSON.stringify({ scenario: 'response-port loss after possible click', clicks, replayGranted: replay.granted, sendCount: state.sendCount, deadlineAt: state.deadlineAt }));
}

console.log('watchdog cadence acceptance reproductions passed');
