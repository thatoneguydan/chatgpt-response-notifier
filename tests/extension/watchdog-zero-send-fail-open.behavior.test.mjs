import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class FakeObjectStore {
  constructor(transaction, name, definition) {
    this.transaction = transaction;
    this.name = name;
    this.definition = definition;
  }

  get(key) {
    return this.transaction.request(() => clone(this.definition.records.get(key)));
  }

  put(value) {
    return this.transaction.request(() => {
      this.definition.records.set(value[this.definition.keyPath], clone(value));
      return value[this.definition.keyPath];
    });
  }
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
    queueMicrotask(() => this.maybeComplete());
  }

  objectStore(name) {
    return new FakeObjectStore(this, name, this.database.stores.get(name));
  }

  request(action) {
    this.pending += 1;
    const request = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      addEventListener(kind, listener) {
        if (kind === 'success') this.successListener = listener;
      }
    };
    queueMicrotask(() => {
      try {
        request.result = action();
        request.successListener?.();
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

class FakeDatabase {
  constructor() {
    this.stores = new Map([
      ['profile', { keyPath: 'key', records: new Map() }],
      ['enrollments', { keyPath: 'conversationId', records: new Map() }]
    ]);
  }

  transaction(names) {
    return new FakeTransaction(this, names);
  }
}

test('definitive no-click releases the watchdog reservation while uncertain click remains consumed', async () => {
  const database = new FakeDatabase();
  const indexedDB = {
    open() {
      const request = { result: database, error: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    }
  };
  let now = 1_000_000;
  class Clock extends Date { static now() { return now; } }
  const chrome = {
    runtime: { onMessage: { addListener() {} } },
    alarms: { clear: async () => true, create() {} }
  };
  const context = vm.createContext({
    globalThis: null,
    console,
    Date: Clock,
    Math,
    Number,
    String,
    Array,
    Object,
    Promise,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    structuredClone: clone,
    crypto: { randomUUID: () => `id-${now}` },
    URL,
    indexedDB,
    IDBObjectStore: FakeObjectStore,
    chrome,
    ChatGPTNotifierContinuationPolicy: {
      watchdogDelayMs: () => 30 * 60_000,
      watchdogMaxSends: () => 3,
      isAutoContinueStatusCode: () => false
    }
  });
  context.globalThis = context;
  vm.runInContext(readText('extension/watchdog-continuation-invariant-background.js'), context);

  const cadence = context.__chatgptNotifierWatchdogContinuationInvariant;
  const conversationId = 'conversation-1';
  const key = `code-watchdog:${conversationId}`;
  const promptKey = 'prompt-1';
  database.stores.get('enrollments').records.set(conversationId, { conversationId, enabled: true, userPaused: false });
  database.stores.get('profile').records.set(key, {
    key,
    conversationId,
    ownerTabId: 1,
    sendCount: 0,
    stopped: false,
    deadlineAt: now - 1,
    retryAt: 0,
    lastPromptKey: promptKey,
    cadenceSchemaVersion: 1,
    cadenceEpoch: 1,
    cadenceSendCount: 0,
    cadenceAttempt: null,
    nextSendEligibleAt: 0
  });
  const sender = { tab: { id: 1, url: `https://chatgpt.com/c/${conversationId}` } };

  const firstAuthorization = await cadence.authorizePageDispatch({ conversationId, promptKey, documentId: 'document-1' }, sender);
  assert.equal(firstAuthorization.granted, true);
  assert.equal((await cadence.readWatchdog(conversationId)).sendCount, 1);

  const noClick = await cadence.finalizePageDispatch({
    conversationId,
    promptKey,
    documentId: 'document-1',
    attemptId: firstAuthorization.attemptId,
    clicked: false,
    ok: false,
    reason: 'composer-not-found'
  }, sender);
  assert.equal(noClick.outcome, 'definitively-not-clicked');
  assert.equal(noClick.released, true);
  assert.equal(noClick.attemptConsumed, false);
  const released = await cadence.readWatchdog(conversationId);
  assert.equal(released.sendCount, 0);
  assert.equal(released.cadenceSendCount, 0);
  assert.equal(released.cadenceAttempt, null);
  assert.ok(released.deadlineAt <= now);
  assert.equal(released.nextSendEligibleAt, 0);

  now += 1;
  const secondAuthorization = await cadence.authorizePageDispatch({ conversationId, promptKey, documentId: 'document-1' }, sender);
  assert.equal(secondAuthorization.granted, true, 'a proven no-click must remain due and retryable');
  const maybeClicked = await cadence.finalizePageDispatch({
    conversationId,
    promptKey,
    documentId: 'document-1',
    attemptId: secondAuthorization.attemptId,
    clicked: true,
    clickedAt: now,
    ok: false,
    reason: 'continuation-user-turn-not-confirmed'
  }, sender);
  assert.equal(maybeClicked.outcome, 'unknown');
  assert.equal(maybeClicked.released, false);
  assert.equal(maybeClicked.attemptConsumed, true);

  now += 60_000;
  const replay = await cadence.authorizePageDispatch({ conversationId, promptKey, documentId: 'document-1' }, sender);
  assert.equal(replay.granted, false);
  assert.equal(replay.syntheticSuccess, true, 'a click that may have fired must not replay at the short retry cadence');
});

test('due watchdog fails open on uncertain observation but preserves explicit blockers', () => {
  const monitorSource = readText('extension/monitor-background.js');
  const statusSource = readText('extension/status-script.js');
  const eligibilityMatch = monitorSource.match(/function codeWatchdogNoCodeEligibility\(snapshot = \{\}\) \{([\s\S]*?)\n  \}/);
  assert.ok(eligibilityMatch, 'watchdog eligibility function must exist');
  const eligibility = eligibilityMatch[1];

  assert.doesNotMatch(eligibility, /snapshot\.observable === false/);
  assert.doesNotMatch(eligibility, /snapshot\.applicationStateIdentityMatched === false/);
  assert.match(eligibility, /snapshot\.online === false/);
  assert.match(eligibility, /snapshot\.authRequired === true/);
  assert.match(eligibility, /snapshot\.approvalRequired === true/);
  assert.match(eligibility, /snapshot\.rateLimited === true/);
  assert.match(eligibility, /snapshot\.hasDraft === true/);
  assert.match(eligibility, /snapshot\.hasUpload === true/);
  assert.match(eligibility, /deadline-no-code-fail-open/);

  assert.match(statusSource, /function watchdogUserBlockReason\(node\)/);
  assert.match(statusSource, /reason === 'active-user-interaction' \? '' : reason/);
  assert.match(statusSource, /const definitivelyNotClicked = raw\?\.clicked !== true/);
  assert.match(statusSource, /watchdogAttemptReleased: finalized\?\.released === true/);
  assert.match(statusSource, /ok: false,/);
});
