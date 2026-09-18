import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('extension/delivery-dedupe-hook.js', root), 'utf8');
const serviceWorkerSource = readFileSync(new URL('extension/service-worker.js', root), 'utf8');
const contentScriptSource = readFileSync(new URL('extension/content-script.js', root), 'utf8');

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
  const nativeMessages = [];
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
      runtime: { getManifest: () => ({ version: '0.9.29' }) },
      tabs: {
        async get(tabId) {
          assert.equal(tabId, 7);
          return { id: 7, title: 'Actual build chat' };
        }
      }
    },
    sendNative: (message) => nativeMessages.push(clone(message)),
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
  return { context, originalClaims, nativeMessages };
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

test('a different assistant turn remains independently notifiable when request identity is unavailable', async () => {
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


test('one Chrome request remains one delivery across assistant identity remounts', async () => {
  const { context, originalClaims } = loadHook();
  const coordinator = context.__chatgptNotifierCoordinator;
  const owner = {
    tabId: 7,
    documentId: 'document-1',
    requestId: 'request-1',
    notificationTitle: 'ChatGPT'
  };

  const first = await coordinator.claimTurn(snapshot(), { ...owner, notificationId: 'notification-1' });
  const duplicate = await coordinator.claimTurn(
    snapshot({ assistantKey: 'assistant-2', revision: '200:remounted' }),
    { ...owner, notificationId: 'notification-2' }
  );

  assert.equal(first.claimed, true);
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.reason, 'already-delivered-logical-turn');
  assert.equal(originalClaims.length, 1, 'assistant remount under one network request must not produce a second claim');
  assert.equal(originalClaims[0].snapshot.requestId, 'request-1', 'request identity must persist into the coordinator turn record');
});

test('request-key migration respects an already committed legacy logical-turn claim', async () => {
  const { context, originalClaims } = loadHook();
  const coordinator = context.__chatgptNotifierCoordinator;

  const legacy = await coordinator.claimTurn(snapshot(), { tabId: 7, notificationTitle: 'ChatGPT', notificationId: 'legacy-notification' });
  const requestOwned = await coordinator.claimTurn(snapshot(), {
    tabId: 7,
    documentId: 'document-1',
    requestId: 'request-1',
    notificationTitle: 'ChatGPT',
    notificationId: 'request-notification'
  });

  assert.equal(legacy.claimed, true);
  assert.equal(requestOwned.claimed, false);
  assert.equal(requestOwned.reason, 'already-delivered-logical-turn');
  assert.equal(originalClaims.length, 1, 'activation must not replay an already delivered legacy claim');
});
test('a new Chrome request remains independently notifiable even with the same DOM identity', async () => {
  const { context, originalClaims } = loadHook();
  const coordinator = context.__chatgptNotifierCoordinator;
  const owner = { tabId: 7, documentId: 'document-1', notificationTitle: 'ChatGPT' };

  const first = await coordinator.claimTurn(snapshot(), { ...owner, requestId: 'request-1', notificationId: 'notification-1' });
  const second = await coordinator.claimTurn(snapshot(), { ...owner, requestId: 'request-2', notificationId: 'notification-2' });

  assert.equal(first.claimed, true);
  assert.equal(second.claimed, true);
  assert.equal(originalClaims.length, 2, 'a genuine retry/regenerate request must remain independently notifiable');
});

test('request identity is propagated from Chrome completion into both delivery claim paths', () => {
  assert.match(serviceWorkerSource, /signalConversationRequestCompleted\(\s*details\.tabId,\s*String\(details\.requestId \|\| ''\),\s*String\(details\.documentId \|\| ''\)/);
  assert.match(serviceWorkerSource, /requestId:\s*String\(message\?\.requestId \|\| ''\)/);
  assert.match(serviceWorkerSource, /__chatgptNotifierResponseStreamStatus\?\.requestOwnerForTurn/);
  assert.match(serviceWorkerSource, /fingerprint:\s*`worker\|\$\{status\.conversationId\}\|\$\{requestId\}\|\$\{status\.statusCode\}`,\s*requestId,/);
  assert.match(contentScriptSource, /requestId:\s*requestIdentity/);
  assert.match(contentScriptSource, /armForCurrentPrompt\(String\(message\?\.requestId \|\| ''\)\)/);
});
test('delivery identity diagnostics retain same-request assistant remount evidence', async () => {
  const { context, nativeMessages } = loadHook();
  const coordinator = context.__chatgptNotifierCoordinator;
  const base = snapshot({ requestId: 'request-sensitive-12345678' });

  await coordinator.claimTurn(base, {
    tabId: 7,
    documentId: 'document-sensitive-abcdefgh',
    notificationId: 'notification-sensitive-11111111',
    notificationTitle: 'Build chat',
    claimSource: 'coded-completion'
  });
  await coordinator.claimTurn(
    { ...base, assistantKey: 'assistant-sensitive-22222222', revision: '200:remounted' },
    {
      tabId: 7,
      documentId: 'document-sensitive-abcdefgh',
      notificationId: 'notification-sensitive-33333333',
      notificationTitle: 'Build chat',
      claimSource: 'worker-observed-coded-completion'
    }
  );

  const diagnostics = nativeMessages
    .map((item) => item.diagnostic)
    .filter((item) => item?.source === 'delivery-identity');
  const observed = diagnostics.filter((item) => item?.status === 'claim-observed');
  const accepted = diagnostics.filter((item) => item?.status === 'claim-accepted');
  const suppressed = diagnostics.filter((item) => item?.status === 'claim-suppressed');

  assert.equal(observed.length, 2);
  assert.equal(accepted.length, 1);
  assert.equal(suppressed.length, 1);
  assert.equal(observed[0].requestSuffix, '12345678');
  assert.equal(observed[1].requestSuffix, '12345678');
  assert.notEqual(observed[0].assistantSuffix, observed[1].assistantSuffix);
  assert.notEqual(observed[0].notificationSuffix, observed[1].notificationSuffix);
  assert.equal(accepted[0].claimSource, 'coded-completion');
  assert.equal(suppressed[0].claimSource, 'worker-observed-coded-completion');
  assert.equal(suppressed[0].reason, 'already-delivered-logical-turn');
  for (const diagnostic of diagnostics) {
    const serialized = JSON.stringify(diagnostic);
    assert.doesNotMatch(serialized, /request-sensitive-/);
    assert.doesNotMatch(serialized, /document-sensitive-/);
    assert.doesNotMatch(serialized, /notification-sensitive-/);
    assert.doesNotMatch(serialized, /assistant-sensitive-/);
  }
});
