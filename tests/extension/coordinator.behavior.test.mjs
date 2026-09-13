import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import './delivery-dedupe.behavior.test.mjs';
import './delivery-reliability.behavior.test.mjs';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('extension/coordinator-background.js', root), 'utf8');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

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

function loadCoordinator() {
  const context = vm.createContext({
    indexedDB: fakeIndexedDb(),
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
    console
  });
  vm.runInContext(source, context);
  return context.__chatgptNotifierCoordinator;
}

const snapshot = {
  conversationId: 'conversation-1',
  conversationUrl: 'https://chatgpt.com/c/conversation-1',
  documentId: 'document-runtime-a',
  promptKey: 'conversation-1|user-4',
  assistantKey: 'assistant-5',
  revision: '100:abc12345',
  statusCode: 'INCOMPLETE_LIMIT',
  statusLine: '[GITHUB_STATUS: INCOMPLETE_LIMIT]',
  responseBody: 'Continue work.',
  responseText: 'Continue work.\n[GITHUB_STATUS: INCOMPLETE_LIMIT]'
};

test('only the first tab can claim an exact response revision', async () => {
  const coordinator = loadCoordinator();
  const first = await coordinator.claimTurn(snapshot, {
    tabId: 10,
    documentId: 'chrome-document-a',
    notificationId: 'notification-1',
    notificationTitle: 'Build chat',
    notificationPreview: 'Continue work.'
  });
  const duplicateTab = await coordinator.claimTurn(snapshot, {
    tabId: 11,
    documentId: 'chrome-document-b',
    notificationId: 'notification-2'
  });

  assert.equal(first.claimed, true);
  assert.equal(duplicateTab.claimed, false);
  assert.equal(duplicateTab.reason, 'already-claimed');
  assert.equal(duplicateTab.record.ownerTabId, 10);
  assert.equal(duplicateTab.record.notificationId, 'notification-1');

  const newRevision = await coordinator.claimTurn({ ...snapshot, revision: '101:def67890' }, {
    tabId: 11,
    documentId: 'chrome-document-b',
    notificationId: 'notification-3'
  });
  assert.equal(newRevision.claimed, true, 'a genuinely new response revision gets a distinct durable claim');
});

test('notification outbox survives until exact helper acknowledgment', async () => {
  const coordinator = loadCoordinator();
  const claim = await coordinator.claimTurn(snapshot, {
    tabId: 10,
    documentId: 'chrome-document-a',
    notificationId: 'notification-1',
    notificationTitle: 'Build chat',
    notificationPreview: 'Continue work.'
  });

  const notification = {
    id: 'notification-1',
    conversationId: snapshot.conversationId,
    conversationUrl: snapshot.conversationUrl,
    title: 'Build chat',
    preview: 'Continue work.',
    statusCode: 'INCOMPLETE_LIMIT',
    completedAt: '2026-09-12T02:00:00.000Z'
  };

  await coordinator.queueNotification(claim.record.turnKey, notification, 'fingerprint-1');
  assert.equal((await coordinator.listOutbox()).length, 1);
  assert.equal((await coordinator.getTurn(claim.record.turnKey)).state, 'notification-queued');

  await coordinator.noteOutboxAttempt(notification.id);
  assert.equal((await coordinator.listOutbox())[0].attempts, 1);
  assert.equal((await coordinator.listOutbox()).length, 1, 'an attempted delivery is still durable');

  assert.equal(await coordinator.acknowledgeNotification(notification.id), true);
  assert.equal((await coordinator.listOutbox()).length, 0);
  assert.equal((await coordinator.getTurn(claim.record.turnKey)).state, 'notification-acked');
});

test('a clicked but unresolved continuation remains discoverable for safe restart reconciliation', async () => {
  const coordinator = loadCoordinator();
  const claim = await coordinator.claimTurn(snapshot, {
    tabId: 10,
    documentId: 'chrome-document-a',
    notificationId: 'notification-1'
  });
  await coordinator.updateTurn(claim.record.turnKey, {
    state: 'continuation-clicked',
    actionReason: 'continuation-user-turn-not-confirmed'
  });

  const unresolved = await coordinator.listUnresolvedTurns();
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].turnKey, claim.record.turnKey);
  assert.equal(unresolved[0].state, 'continuation-clicked');
});
