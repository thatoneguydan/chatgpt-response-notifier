import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');

async function flush(times = 12) {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

function fakeIndexedDb() {
  const stores = new Map();
  const ensure = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  function request(value) {
    const result = { result: value, onsuccess: null, onerror: null };
    queueMicrotask(() => result.onsuccess?.());
    return result;
  }
  return {
    stores,
    indexedDB: {
      open() {
        const database = {
          objectStoreNames: { contains: (name) => stores.has(name) },
          createObjectStore(name) { ensure(name); },
          transaction(name) {
            const data = ensure(name);
            const transaction = { oncomplete: null, onerror: null, onabort: null };
            transaction.objectStore = () => ({
              get(key) { return request(data.get(key)); },
              getAll() { return request([...data.values()].map((value) => structuredClone(value))); },
              put(value) {
                data.set(value.deadlineKey, structuredClone(value));
                queueMicrotask(() => transaction.oncomplete?.());
              },
              delete(key) {
                data.delete(key);
                queueMicrotask(() => transaction.oncomplete?.());
              }
            });
            return transaction;
          }
        };
        const openRequest = { result: database, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
        queueMicrotask(() => {
          openRequest.onupgradeneeded?.();
          openRequest.onsuccess?.();
        });
        return openRequest;
      }
    }
  };
}

function createSchedulerRuntime() {
  let now = 10_000;
  const db = fakeIndexedDb();
  const runtimeListeners = [];
  const alarmListeners = [];
  const updatedListeners = [];
  const activatedListeners = [];
  const removedListeners = [];
  const alarms = [];
  const synthetic = [];
  let querySnapshot = null;
  let tabState = { id: 7, discarded: false, frozen: false, active: false };

  class FakeDate extends Date { static now() { return now; } }

  const chrome = {
    alarms: {
      create: async (name, info) => { alarms.push({ name, ...info }); },
      clear: async () => true,
      onAlarm: { addListener: (listener) => alarmListeners.push(listener) }
    },
    runtime: { onMessage: { addListener: (listener) => runtimeListeners.push(listener) } },
    scripting: { executeScript: async () => [{}] },
    tabs: {
      get: async () => ({ ...tabState }),
      sendMessage: async (_tabId, message) => {
        if (message.type === 'CHATGPT_MONITOR_QUERY') return { ok: true, snapshot: structuredClone(querySnapshot) };
        if (message.type === 'CHATGPT_OBSERVATION_SYNTHETIC') {
          synthetic.push(structuredClone(message.snapshot));
          return { ok: true };
        }
        return null;
      },
      onUpdated: { addListener: (listener) => updatedListeners.push(listener) },
      onActivated: { addListener: (listener) => activatedListeners.push(listener) },
      onRemoved: { addListener: (listener) => removedListeners.push(listener) }
    }
  };

  const policyContext = vm.createContext({ Date: FakeDate, Number, String, Set, Object, Math });
  vm.runInContext(readText('extension/status-policy.js'), policyContext);

  const context = vm.createContext({
    console,
    Date: FakeDate,
    Number,
    String,
    Set,
    Object,
    Math,
    structuredClone,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: (() => { let id = 0; return () => `token-${++id}`; })() },
    indexedDB: db.indexedDB,
    chrome,
    ChatGPTNotifierContinuationPolicy: policyContext.ChatGPTNotifierContinuationPolicy
  });
  vm.runInContext(readText('extension/observation-scheduler-background.js'), context);

  const scheduler = context.__chatgptNotifierObservationScheduler;
  const deadlineStore = () => db.stores.get('deadlines') || new Map();
  const snapshot = (overrides = {}) => ({
    conversationId: 'conversation-1',
    documentId: 'document-1',
    promptKey: 'conversation-1|user-1',
    promptRevision: 'prompt-r1',
    assistantKey: 'assistant-1',
    assistantRevision: 'assistant-r1',
    statusCode: '',
    hasStatusEvidence: false,
    observable: true,
    online: true,
    manualStopped: false,
    authRequired: false,
    approvalRequired: false,
    rateLimited: false,
    hasDraft: false,
    hasUpload: false,
    stopGenerating: false,
    toolActivity: false,
    explicitInterruption: false,
    stableTerminal: false,
    silentIdleConfirmations: 0,
    requestPhase: 'completed',
    requestStartedAt: 1_000,
    requestSettledAt: 5_000,
    workingDurationMs: 0,
    ...overrides
  });

  async function publish(value) {
    for (const listener of runtimeListeners) listener({ type: 'CHATGPT_MONITOR_STATE', snapshot: value }, { tab: { id: 7 }, documentId: value.documentId }, () => {});
    await flush();
  }

  return {
    scheduler,
    snapshot,
    publish,
    deadlineStore,
    synthetic,
    alarms,
    setNow(value) { now = value; },
    setQuery(value) { querySnapshot = value; },
    setTab(value) { tabState = { ...tabState, ...value }; },
    async activate() { for (const listener of activatedListeners) listener({ tabId: 7 }); await flush(); }
  };
}

test('assistant missing-footer deadline is persisted and worker-owned', async () => {
  const runtime = createSchedulerRuntime();
  const state = runtime.snapshot();
  runtime.setQuery(state);
  await runtime.publish(state);

  const records = [...runtime.deadlineStore().values()];
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'missing-footer');
  assert.equal(records[0].dueAt, 40_000);
  assert.ok(runtime.alarms.some((alarm) => alarm.name === runtime.scheduler.alarmName && alarm.when === 40_000));

  runtime.setNow(40_000);
  await runtime.scheduler.processDue();
  assert.equal(runtime.synthetic.length, 1);
  assert.equal(runtime.synthetic[0].stableTerminal, true);
  assert.equal(runtime.synthetic[0].workerObservationSynthetic, true);
  assert.equal(runtime.deadlineStore().size, 0);
});

test('silent-stop worker deadline waits 90 seconds then another 30 seconds before confirmation 2', async () => {
  const runtime = createSchedulerRuntime();
  const silent = runtime.snapshot({ assistantKey: '', assistantRevision: '', requestSettledAt: 10_000 });
  runtime.setQuery(silent);
  await runtime.publish(silent);

  let record = [...runtime.deadlineStore().values()][0];
  assert.equal(record.kind, 'silent-first');
  assert.equal(record.dueAt, 100_000);

  runtime.setNow(100_000);
  await runtime.scheduler.processDue();
  record = [...runtime.deadlineStore().values()][0];
  assert.equal(record.kind, 'silent-confirm');
  assert.equal(record.dueAt, 130_000);

  runtime.setNow(130_000);
  await runtime.scheduler.processDue();
  assert.equal(runtime.synthetic.at(-1).silentIdleConfirmations, 2);
  assert.equal(runtime.deadlineStore().size, 0);
});

test('frozen page defers without manufacturing a failure and resumes on lifecycle activity', async () => {
  const runtime = createSchedulerRuntime();
  const state = runtime.snapshot();
  runtime.setQuery(state);
  await runtime.publish(state);
  runtime.setTab({ frozen: true });
  runtime.setNow(40_000);
  await runtime.scheduler.processDue();

  let record = [...runtime.deadlineStore().values()][0];
  assert.equal(record.state, 'deferred');
  assert.equal(record.dueAt, 0);
  assert.equal(record.deferReason, 'page-unobservable');
  assert.equal(runtime.synthetic.length, 0);

  runtime.setTab({ frozen: false });
  await runtime.activate();
  record = [...runtime.deadlineStore().values()][0];
  assert.equal(record.state, 'scheduled');
  assert.equal(record.dueAt, 41_000);

  runtime.setNow(41_000);
  await runtime.scheduler.processDue();
  assert.equal(runtime.synthetic.at(-1).stableTerminal, true);
});

test('identity changes invalidate due observations instead of applying late classification', async () => {
  const runtime = createSchedulerRuntime();
  const state = runtime.snapshot();
  await runtime.publish(state);
  runtime.setQuery(runtime.snapshot({ assistantRevision: 'assistant-r2' }));
  runtime.setNow(40_000);
  await runtime.scheduler.processDue();
  assert.equal(runtime.synthetic.length, 0);
  assert.equal(runtime.deadlineStore().size, 0);
});

test('worker scheduling is local-only, bounded, persistent, and loaded after bounded recovery', () => {
  const source = readText('extension/observation-scheduler-background.js');
  const background = readText('extension/background.js');
  const manifest = JSON.parse(readText('extension/manifest.json'));
  assert.match(source, /indexedDB\.open\(DB_NAME, DB_VERSION\)/);
  assert.match(source, /chrome\.alarms\.create/);
  assert.match(source, /QUERY_TIMEOUT_MS = 5_000/);
  assert.match(source, /Promise\.resolve\(promise\)/);
  assert.match(source, /tab\.discarded === true \|\| tab\.frozen === true/);
  assert.match(source, /state: 'deferred'/);
  assert.match(source, /CHATGPT_OBSERVATION_SYNTHETIC/);
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|backend-api/);
  const boundedIndex = background.indexOf("'bounded-recovery-background.js'");
  const schedulerIndex = background.indexOf("'observation-scheduler-background.js'");
  assert.ok(boundedIndex >= 0 && schedulerIndex > boundedIndex);
  const firstContent = manifest.content_scripts[0].js;
  assert.ok(firstContent.indexOf('observation-relay.js') > firstContent.indexOf('monitor-script.js'));
});

test('page relay rejects stale worker observations and republishes only exact live identity', async () => {
  const listeners = [];
  const outbound = [];
  const live = {
    conversationId: 'conversation-1', documentId: 'document-1', promptKey: 'conversation-1|user-1', promptRevision: 'prompt-r1',
    assistantKey: 'assistant-1', assistantRevision: 'assistant-r1', stableTerminal: false
  };
  const context = vm.createContext({
    globalThis: null,
    chrome: {
      runtime: {
        onMessage: { addListener: (listener) => listeners.push(listener) },
        sendMessage: async (message) => { outbound.push(message); }
      }
    },
    __chatgptNotifierMonitorRuntime: { snapshot: () => ({ ...live }) }
  });
  context.globalThis = context;
  vm.runInContext(readText('extension/observation-relay.js'), context);

  let staleReply = null;
  listeners[0]({ type: 'CHATGPT_OBSERVATION_SYNTHETIC', snapshot: { ...live, assistantRevision: 'assistant-r0', stableTerminal: true } }, {}, (value) => { staleReply = value; });
  assert.equal(staleReply.ok, false);
  assert.equal(outbound.length, 0);

  let acceptedReply = null;
  const asyncResponse = listeners[0]({ type: 'CHATGPT_OBSERVATION_SYNTHETIC', snapshot: { ...live, stableTerminal: true } }, {}, (value) => { acceptedReply = value; });
  assert.equal(asyncResponse, true);
  await flush();
  assert.equal(acceptedReply.ok, true);
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].type, 'CHATGPT_MONITOR_STATE');
  assert.equal(outbound[0].snapshot.stableTerminal, true);
  assert.equal(outbound[0].snapshot.workerObservationSynthetic, true);
});
