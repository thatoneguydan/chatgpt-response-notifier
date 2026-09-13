import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('extension/delivery-dedupe-hook.js', root), 'utf8');

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

function snapshot(overrides = {}) {
  return {
    conversationId: 'conversation-1',
    conversationUrl: 'https://chatgpt.com/c/conversation-1',
    promptKey: 'conversation-1|user-1',
    assistantKey: 'assistant-1',
    revision: '100:first',
    statusCode: 'BLOCKED_HUMAN',
    ...overrides
  };
}

function loadHook() {
  const originalClaims = [];
  const originalCoordinator = {
    async claimTurn(current, owner) {
      originalClaims.push({ snapshot: clone(current), owner: clone(owner) });
      return { claimed: true, reason: 'claimed', record: { turnKey: `${current.assistantKey}|${current.revision}` } };
    },
    passthrough: true
  };

  const context = vm.createContext({
    __chatgptNotifierCoordinator: originalCoordinator,
    indexedDB: fakeIndexedDb(),
    chrome: {
      tabs: {
        async get(tabId) {
          assert.equal(tabId, 7);
          return { id: 7, title: 'Actual build chat' };
        }
      }
    },
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
    console
  });
  vm.runInContext(source, context);
  return { context, originalClaims };
}

test('one logical assistant turn produces one coordinator claim across DOM revision changes', async () => {
  const { context, originalClaims } = loadHook();
  const coordinator = context.__chatgptNotifierCoordinator;

  const first = await coordinator.claimTurn(snapshot(), {
    tabId: 7,
    notificationTitle: 'ChatGPT',
    fingerprint: 'same-logical-response'
  });
  assert.equal(first.claimed, true);
  assert.equal(originalClaims.length, 1);
  assert.equal(originalClaims[0].owner.notificationTitle, 'Actual build chat');

  const duplicate = await coordinator.claimTurn(snapshot({ revision: '120:rerendered' }), {
    tabId: 7,
    notificationTitle: 'Actual build chat',
    fingerprint: 'same-logical-response'
  });
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.reason, 'already-delivered-logical-turn');
  assert.equal(originalClaims.length, 1, 'rerendered revision must not create a second notification claim');
});

test('a different assistant turn remains independently notifiable', async () => {
  const { context, originalClaims } = loadHook();
  const coordinator = context.__chatgptNotifierCoordinator;

  await coordinator.claimTurn(snapshot(), { tabId: 7, notificationTitle: 'ChatGPT', fingerprint: 'response-1' });
  const second = await coordinator.claimTurn(snapshot({ assistantKey: 'assistant-2', revision: '200:second' }), {
    tabId: 7,
    notificationTitle: 'ChatGPT',
    fingerprint: 'response-2'
  });

  assert.equal(second.claimed, true);
  assert.equal(originalClaims.length, 2);
});
