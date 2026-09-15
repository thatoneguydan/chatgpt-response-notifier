import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const reliabilitySource = readFileSync(new URL('extension/delivery-reliability-background.js', root), 'utf8');
const normalSource = readFileSync(new URL('extension/normal-continuation-budget-hook.js', root), 'utf8');

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

class FakeTransaction {
  constructor(database, names) {
    this.database = database;
    this.names = Array.isArray(names) ? names : [names];
    this.pending = 0;
    this.finished = false;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
  }

  objectStore(name) {
    if (!this.names.includes(name)) throw new Error(`Store ${name} is outside transaction`);
    return new FakeStore(this, this.database.stores.get(name));
  }

  request(action) {
    this.pending += 1;
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      if (this.finished) return;
      try {
        request.result = action();
        request.onsuccess?.();
      } catch (error) {
        request.error = error;
        this.error = error;
        request.onerror?.();
        this.finished = true;
        this.onerror?.();
        this.onabort?.();
        return;
      } finally {
        this.pending -= 1;
      }
      this.maybeComplete();
    });
    return request;
  }

  maybeComplete() {
    if (this.finished || this.pending !== 0) return;
    setTimeout(() => {
      if (this.finished || this.pending !== 0) return;
      this.finished = true;
      this.oncomplete?.();
    }, 0);
  }
}

class FakeStore {
  constructor(transaction, definition) {
    this.transaction = transaction;
    this.definition = definition;
  }

  keyOf(value) {
    return value?.[this.definition.keyPath];
  }

  get(key) {
    return this.transaction.request(() => clone(this.definition.records.get(key)));
  }

  getAll() {
    return this.transaction.request(() => Array.from(this.definition.records.values(), clone));
  }

  add(value) {
    return this.transaction.request(() => {
      const key = this.keyOf(value);
      if (this.definition.records.has(key)) throw new Error('ConstraintError');
      this.definition.records.set(key, clone(value));
      return key;
    });
  }

  put(value) {
    return this.transaction.request(() => {
      const key = this.keyOf(value);
      this.definition.records.set(key, clone(value));
      return key;
    });
  }

  delete(key) {
    return this.transaction.request(() => this.definition.records.delete(key));
  }
}

class FakeDatabase {
  constructor() {
    this.stores = new Map();
    this.objectStoreNames = { contains: (name) => this.stores.has(name) };
  }

  createObjectStore(name, options) {
    this.stores.set(name, { keyPath: options.keyPath, records: new Map() });
    return this.stores.get(name);
  }

  transaction(names) {
    const transaction = new FakeTransaction(this, names);
    queueMicrotask(() => transaction.maybeComplete());
    return transaction;
  }
}

function fakeIndexedDb() {
  const databases = new Map();
  return {
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

function eventHook() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); }
  };
}

function baseChrome(tab = { id: 7, title: 'Build chat', url: 'https://chatgpt.com/c/conversation-1' }) {
  return {
    runtime: {
      getManifest: () => ({ version: '0.9.8' }),
      onMessage: eventHook(),
      onStartup: eventHook()
    },
    alarms: {
      created: [],
      cleared: [],
      onAlarm: eventHook(),
      create(name, options) { this.created.push({ name, options }); },
      async clear(name) { this.cleared.push(name); return true; }
    },
    tabs: {
      onRemoved: eventHook(),
      async get(tabId) {
        if (tabId !== tab.id) throw new Error('No tab');
        return clone(tab);
      }
    },
    webRequest: {
      onBeforeRequest: eventHook(),
      onHeadersReceived: eventHook(),
      onErrorOccurred: eventHook(),
      onCompleted: eventHook()
    }
  };
}

function makeCoordinator() {
  const turns = new Map();
  const outbox = [];
  return {
    turns,
    outbox,
    async claimTurn(status, owner) {
      const turnKey = [status.conversationId, status.promptKey, status.assistantKey, status.revision].join('|');
      if (turns.has(turnKey)) return { claimed: false, reason: 'already-claimed', record: clone(turns.get(turnKey)) };
      const record = {
        turnKey,
        conversationId: status.conversationId,
        conversationUrl: status.conversationUrl,
        documentId: status.documentId,
        promptKey: status.promptKey,
        assistantKey: status.assistantKey,
        revision: status.revision,
        statusCode: status.statusCode,
        responseBody: status.responseBody || '',
        responseText: status.responseText || '',
        ownerTabId: owner.tabId,
        ownerDocumentId: owner.documentId,
        notificationId: owner.notificationId,
        notificationTitle: owner.notificationTitle,
        notificationPreview: owner.notificationPreview,
        fingerprint: owner.fingerprint,
        state: 'claimed'
      };
      turns.set(turnKey, clone(record));
      return { claimed: true, reason: 'claimed', record: clone(record) };
    },
    async getTurn(turnKey) { return clone(turns.get(turnKey)) || null; },
    async updateTurn(turnKey, patch) {
      const current = turns.get(turnKey);
      if (!current) return null;
      const updated = { ...current, ...clone(patch) };
      turns.set(turnKey, updated);
      return clone(updated);
    },
    async listOutbox() { return clone(outbox); },
    async noteOutboxAttempt(notificationId) {
      const record = outbox.find((item) => item.notification?.id === notificationId);
      if (!record) return null;
      record.attempts = Number(record.attempts || 0) + 1;
      return clone(record);
    },
    async acknowledgeNotification(notificationId) {
      const index = outbox.findIndex((item) => item.notification?.id === notificationId);
      if (index < 0) return false;
      outbox.splice(index, 1);
      return true;
    }
  };
}

function makeContext({
  indexedDB = fakeIndexedDb(),
  tab = { id: 7, title: 'Build chat', url: 'https://chatgpt.com/c/conversation-1' },
  coordinatorState = makeCoordinator(),
  queryTerminalStatus = async () => null,
  handleContinuationClaim = async () => null,
  sendNativeRequest = async () => null
} = {}) {
  const chrome = baseChrome(tab);
  const diagnostics = [];
  const queued = [];
  const context = vm.createContext({
    indexedDB,
    structuredClone: clone,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Date,
    Number,
    String,
    Array,
    Set,
    Map,
    Math,
    Promise,
    URL,
    crypto: globalThis.crypto,
    console,
    WebSocket: { OPEN: 1 },
    bridgeSocket: { readyState: 1 },
    chrome,
    activeTurnKeys: new Set(),
    ChatGPTNotifierStatusCode: {
      isStatusCode: (value) => [
        'COMPLETE', 'BLOCKED_HUMAN', 'BLOCKED_EXTERNAL', 'BLOCKED_ENVIRONMENT',
        'INCOMPLETE_LIMIT', 'INCOMPLETE_HANDOFF', 'PLAN_IN_PROGRESS'
      ].includes(String(value || ''))
    },
    truncateResponse: (value) => String(value || '').slice(0, 300),
    coordinator: () => coordinatorState,
    sendNative: (message) => diagnostics.push(clone(message)),
    sendNativeRequest,
    async queueDurableNotification(record, reason = '') {
      queued.push({ record: clone(record), reason });
      await coordinatorState.updateTurn(record.turnKey, { state: 'notification-queued', actionReason: reason });
      coordinatorState.outbox.push({
        notificationId: record.notificationId,
        turnKey: record.turnKey,
        notification: {
          id: record.notificationId,
          conversationId: record.conversationId,
          conversationUrl: record.conversationUrl,
          title: record.notificationTitle,
          preview: record.notificationPreview,
          statusCode: record.statusCode
        },
        attempts: 0
      });
      return record.notificationId;
    },
    async flushNotificationOutbox() {},
    async handleNativeMessage() {},
    queryTerminalStatus,
    handleContinuationClaim,
    requestContinuation: async () => ({ ok: false, clicked: false, reason: 'not-used' }),
    importScripts: () => {}
  });
  return { context, chrome, coordinatorState, diagnostics, queued };
}

function loadReliability(environment) {
  vm.runInContext(reliabilitySource, environment.context);
  return environment.context.__chatgptNotifierDeliveryReliability;
}

function loadNormal(environment) {
  vm.runInContext(normalSource, environment.context);
  return environment.context.__chatgptNotifierNormalContinuationBudgetHook;
}

const snapshot = {
  conversationId: 'conversation-1',
  conversationUrl: 'https://chatgpt.com/c/conversation-1',
  documentId: 'monitor-runtime-local',
  promptKey: 'conversation-1|conversation-turn-4',
  promptRevision: '20:prompt',
  assistantKey: 'conversation-turn-5',
  assistantRevision: '42:assistant',
  statusCode: 'BLOCKED_HUMAN'
};

const validStatus = {
  ok: true,
  conversationId: snapshot.conversationId,
  conversationUrl: snapshot.conversationUrl,
  documentId: 'status-runtime-local',
  promptKey: snapshot.promptKey,
  promptRevision: snapshot.promptRevision,
  assistantKey: snapshot.assistantKey,
  revision: snapshot.assistantRevision,
  statusCode: snapshot.statusCode,
  responseBody: 'Needs operator input.',
  responseText: 'Needs operator input.\n[GITHUB_STATUS: BLOCKED_HUMAN]'
};

test('terminal observation remains retryable after a first null status query and resolves exactly once', async () => {
  let queryCount = 0;
  const environment = makeContext({
    queryTerminalStatus: async () => {
      queryCount += 1;
      return queryCount === 1 ? null : clone(validStatus);
    },
    sendNativeRequest: async (message) => ({
      type: 'toast.accepted',
      notificationId: message.notification?.id,
      accepted: true,
      presented: true,
      presentationState: 'presented'
    })
  });
  const reliability = loadReliability(environment);
  const normal = loadNormal(environment);
  const sender = { tab: { id: 7, title: 'Build chat', url: snapshot.conversationUrl }, documentId: 'chrome-document-real' };

  await normal.scheduleObservedStatusDelivery({ type: 'CHATGPT_MONITOR_STATE', snapshot }, sender);
  assert.equal(environment.queued.length, 0, 'a transient first query miss must not create or consume a durable outcome');
  let pending = await reliability.listPendingObservations();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].state, 'pending');

  await new Promise((resolve) => setTimeout(resolve, 800));
  await normal.scheduleObservedStatusDelivery({ type: 'CHATGPT_MONITOR_STATE', snapshot }, sender);

  assert.equal(queryCount, 2);
  assert.equal(environment.queued.length, 1, 'the identical later observation is still eligible');
  pending = await reliability.listPendingObservations();
  assert.equal(pending.length, 0, 'successful durable handling resolves the observation');
  const turn = Array.from(environment.coordinatorState.turns.values())[0];
  assert.equal(turn.ownerChromeDocumentId, 'chrome-document-real');
  assert.equal(turn.statusRuntimeId, 'status-runtime-local');
  assert.equal(turn.monitorRuntimeId, 'monitor-runtime-local');
  assert.notEqual(turn.ownerChromeDocumentId, turn.statusRuntimeId);
  assert.notEqual(turn.ownerChromeDocumentId, turn.monitorRuntimeId);
});

test('INCOMPLETE_LIMIT continuation routes the real Chrome document id, not either local runtime id', async () => {
  const calls = [];
  const limitSnapshot = { ...snapshot, statusCode: 'INCOMPLETE_LIMIT' };
  const limitStatus = { ...validStatus, statusCode: 'INCOMPLETE_LIMIT' };
  const environment = makeContext({
    queryTerminalStatus: async () => clone(limitStatus),
    handleContinuationClaim: async (record, status, tabId, chromeDocumentId) => {
      calls.push({ record: clone(record), status: clone(status), tabId, chromeDocumentId });
      return null;
    }
  });
  loadReliability(environment);
  const normal = loadNormal(environment);
  const sender = { tab: { id: 7, title: 'Build chat', url: limitSnapshot.conversationUrl }, documentId: 'chrome-document-real' };

  await normal.scheduleObservedStatusDelivery({ type: 'CHATGPT_MONITOR_STATE', snapshot: limitSnapshot }, sender);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].chromeDocumentId, 'chrome-document-real');
  assert.notEqual(calls[0].chromeDocumentId, limitSnapshot.documentId);
  assert.notEqual(calls[0].chromeDocumentId, limitStatus.documentId);
});

test('a route change while a status query is settling vetoes both notification and continuation', async () => {
  const tab = { id: 7, title: 'Build chat', url: snapshot.conversationUrl };
  let queryResolve;
  const queryPromise = new Promise((resolve) => { queryResolve = resolve; });
  let continuationCalls = 0;
  const environment = makeContext({
    tab,
    queryTerminalStatus: async () => await queryPromise,
    handleContinuationClaim: async () => {
      continuationCalls += 1;
      return null;
    }
  });
  const reliability = loadReliability(environment);
  const normal = loadNormal(environment);
  const sender = { tab: { id: 7, title: 'Build chat', url: snapshot.conversationUrl }, documentId: 'chrome-document-real' };

  const scheduled = normal.scheduleObservedStatusDelivery({ type: 'CHATGPT_MONITOR_STATE', snapshot }, sender);
  await new Promise((resolve) => setTimeout(resolve, 0));
  tab.url = 'https://chatgpt.com/c/conversation-2';
  queryResolve(clone(validStatus));
  await scheduled;

  assert.equal(environment.queued.length, 0);
  assert.equal(continuationCalls, 0);
  assert.equal((await reliability.listPendingObservations()).length, 0);
});

test('pending terminal observation survives a worker restart boundary', async () => {
  const indexedDB = fakeIndexedDb();
  const first = makeContext({ indexedDB });
  const firstReliability = loadReliability(first);
  const observation = await firstReliability.enqueueObservation({
    tabId: 7,
    chromeDocumentId: 'chrome-document-real',
    monitorRuntimeId: snapshot.documentId,
    conversationId: snapshot.conversationId,
    conversationUrl: snapshot.conversationUrl,
    promptKey: snapshot.promptKey,
    promptRevision: snapshot.promptRevision,
    assistantKey: snapshot.assistantKey,
    assistantRevision: snapshot.assistantRevision,
    statusCode: snapshot.statusCode
  });
  assert.ok(observation?.observationKey);

  const second = makeContext({ indexedDB });
  const secondReliability = loadReliability(second);
  const pending = await secondReliability.listPendingObservations();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].observationKey, observation.observationKey);
  assert.equal(pending[0].chromeDocumentId, 'chrome-document-real');
});

test('an enqueue wake arriving while another helper ACK is pending is drained before the active flush completes', async () => {
  const coordinatorState = makeCoordinator();
  let resolveFirstAck;
  const firstAck = new Promise((resolve) => { resolveFirstAck = resolve; });
  const sent = [];
  const environment = makeContext({
    coordinatorState,
    sendNativeRequest: async (message) => {
      const id = message.notification?.id;
      sent.push(id);
      if (id === 'notification-a') return await firstAck;
      return {
        type: 'toast.accepted',
        notificationId: id,
        accepted: true,
        presented: true,
        presentationState: 'presented'
      };
    }
  });
  const reliability = loadReliability(environment);

  coordinatorState.outbox.push({
    notificationId: 'notification-a',
    turnKey: 'turn-a',
    notification: {
      id: 'notification-a',
      conversationId: 'conversation-1',
      conversationUrl: snapshot.conversationUrl,
      title: 'A',
      preview: 'A',
      statusCode: 'BLOCKED_HUMAN'
    },
    attempts: 0
  });
  coordinatorState.turns.set('turn-a', { turnKey: 'turn-a', deliveryCorrelationId: 'correlation-a' });

  const firstFlush = reliability.flushNotificationOutbox();
  while (!sent.includes('notification-a')) await new Promise((resolve) => setTimeout(resolve, 0));

  coordinatorState.outbox.push({
    notificationId: 'notification-b',
    turnKey: 'turn-b',
    notification: {
      id: 'notification-b',
      conversationId: 'conversation-1',
      conversationUrl: snapshot.conversationUrl,
      title: 'B',
      preview: 'B',
      statusCode: 'BLOCKED_HUMAN'
    },
    attempts: 0
  });
  coordinatorState.turns.set('turn-b', { turnKey: 'turn-b', deliveryCorrelationId: 'correlation-b' });
  const secondWake = reliability.flushNotificationOutbox();

  resolveFirstAck({
    type: 'toast.accepted',
    notificationId: 'notification-a',
    accepted: true,
    presented: true,
    presentationState: 'presented'
  });

  await Promise.all([firstFlush, secondWake]);
  assert.deepEqual(sent, ['notification-a', 'notification-b']);
  assert.equal(coordinatorState.outbox.length, 0);
});
