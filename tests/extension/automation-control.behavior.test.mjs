import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');

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
  return {
    listeners,
    addListener(listener) { listeners.push(listener); }
  };
}

function baseSnapshot(overrides = {}) {
  return {
    monitorRuntimeVersion: 2,
    policyVersion: 3,
    conversationId: 'conversation-1',
    conversationUrl: 'https://chatgpt.com/c/conversation-1',
    documentId: 'document-1',
    promptKey: 'conversation-1|user-1',
    promptRevision: '1:a',
    assistantKey: 'assistant-1',
    assistantRevision: '1:b',
    statusCode: '',
    workStartSignal: false,
    observable: true,
    online: true,
    manualStopped: false,
    hasDraft: false,
    hasUpload: false,
    stopGenerating: false,
    toolActivity: false,
    stableTerminal: false,
    silentIdleConfirmations: 0,
    requestPhase: 'started',
    requestId: 'request-1',
    requestStartedAt: 1_000,
    requestSettledAt: 0,
    workingDurationMs: 1_000,
    rateLimited: false,
    authRequired: false,
    approvalRequired: false,
    explicitInterruption: false,
    interruptionKind: '',
    ...overrides
  };
}

async function tick(count = 3) {
  for (let index = 0; index < count; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function loadMonitor({ initialTabs = [{ id: 1, url: 'https://chatgpt.com/c/conversation-1', title: 'Build chat', discarded: false, frozen: false, active: true }] } = {}) {
  let tabs = initialTabs.map(clone);
  let activeTabId = tabs.find((tab) => tab.active)?.id ?? tabs[0]?.id ?? null;
  let uuid = 0;
  const runtimeOnMessage = eventHub();
  const tabsOnUpdated = eventHub();
  const tabsOnRemoved = eventHub();
  const webBefore = eventHub();
  const webCompleted = eventHub();
  const webError = eventHub();
  const indexedDB = fakeIndexedDb();

  const chrome = {
    runtime: { onMessage: runtimeOnMessage },
    webRequest: {
      onBeforeRequest: webBefore,
      onCompleted: webCompleted,
      onErrorOccurred: webError
    },
    tabs: {
      onUpdated: tabsOnUpdated,
      onRemoved: tabsOnRemoved,
      async query(query = {}) {
        let result = tabs;
        if (query.active === true) result = result.filter((tab) => tab.id === activeTabId);
        if (query.currentWindow === true) result = result.filter((tab) => tab.currentWindow !== false);
        if (query.url) result = result.filter((tab) => String(tab.url || '').startsWith('https://chatgpt.com/'));
        return result.map(clone);
      },
      async get(tabId) {
        const tab = tabs.find((item) => item.id === tabId);
        if (!tab) throw new Error('No tab');
        return clone(tab);
      },
      async sendMessage() {
        return { ok: true };
      }
    },
    scripting: { async executeScript() {} }
  };

  const context = vm.createContext({
    chrome,
    indexedDB,
    structuredClone: clone,
    crypto: { randomUUID: () => `uuid-${++uuid}` },
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
    URL,
    console
  });
  vm.runInContext(readText('extension/status-code.js'), context);
  vm.runInContext(readText('extension/status-policy.js'), context);
  vm.runInContext(readText('extension/monitor-background.js'), context);

  async function message(message, sender = {}) {
    for (const listener of runtimeOnMessage.listeners) {
      let settled = false;
      let response;
      let resolveResponse;
      const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
      const returned = listener(message, sender, (value) => {
        settled = true;
        response = value;
        resolveResponse(value);
      });
      if (returned === true) {
        if (!settled) response = await responsePromise;
        return clone(response);
      }
      if (settled) return clone(response);
    }
    return undefined;
  }

  async function emit(event, ...args) {
    for (const listener of event.listeners) listener(...args);
    await tick();
  }

  return {
    api: context.__chatgptNotifierMonitorBackground,
    message,
    emit,
    events: { tabsOnUpdated, tabsOnRemoved, webBefore, webCompleted, webError },
    getTabs: () => tabs.map(clone),
    setTabs(next) { tabs = next.map(clone); },
    setActive(tabId) { activeTabId = tabId; }
  };
}

test('one write commits monitoring and recovery together and revision conflicts fail closed', async () => {
  const monitor = loadMonitor();
  await tick();

  const enabled = await monitor.message({
    type: 'SET_BUILD_AUTOMATION_STATE',
    enabled: true,
    tabId: 1,
    conversationId: 'conversation-1',
    expectedRevision: 0,
    requestId: 'enable-1'
  });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.requestId, 'enable-1');
  assert.equal(enabled.automationEnabled, true);
  assert.equal(enabled.monitoring, true);
  assert.equal(enabled.recoveryEnabled, true);
  assert.equal(enabled.pausedByUser, false);
  assert.equal(enabled.stateRevision, 1);

  const stale = await monitor.message({
    type: 'SET_BUILD_AUTOMATION_STATE',
    enabled: false,
    tabId: 1,
    conversationId: 'conversation-1',
    expectedRevision: 0,
    requestId: 'stale-1'
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'state-revision-mismatch');
  assert.equal(stale.automationEnabled, true);
  assert.equal(stale.stateRevision, 1);
});

test('operator Pause is persistent and fresh START or terminal status cannot silently undo it', async () => {
  const monitor = loadMonitor();
  await tick();
  await monitor.message({ type: 'SET_BUILD_AUTOMATION_STATE', enabled: true, tabId: 1, conversationId: 'conversation-1', expectedRevision: 0, requestId: 'enable' });
  const paused = await monitor.message({ type: 'SET_BUILD_AUTOMATION_STATE', enabled: false, tabId: 1, conversationId: 'conversation-1', expectedRevision: 1, requestId: 'pause' });
  assert.equal(paused.ok, true);
  assert.equal(paused.pausedByUser, true);
  assert.equal(paused.automationEnabled, false);
  assert.equal(paused.stateRevision, 2);

  const observed = await monitor.message({
    type: 'CHATGPT_MONITOR_STATE',
    snapshot: baseSnapshot({ workStartSignal: true, statusCode: 'INCOMPLETE_LIMIT' })
  }, { tab: { id: 1, url: 'https://chatgpt.com/c/conversation-1', title: 'Build chat' }, documentId: 'document-1' });
  assert.equal(observed.ok, true);
  assert.equal(observed.monitored, false);

  const enrollment = await monitor.api.getEnrollment('conversation-1');
  assert.equal(enrollment.userPaused, true);
  assert.equal(enrollment.enabled, false);
  assert.equal(enrollment.recoveryEnabled, false);
  assert.equal(enrollment.revision, 2);
});

test('START and terminal-code fallback enroll only with fresh request evidence', async () => {
  const monitor = loadMonitor();
  await tick();

  const staleStart = await monitor.message({
    type: 'CHATGPT_MONITOR_STATE',
    snapshot: baseSnapshot({ workStartSignal: true, requestStartedAt: 0, requestPhase: 'unknown', requestId: '' })
  }, { tab: { id: 1, url: 'https://chatgpt.com/c/conversation-1', title: 'Build chat' }, documentId: 'document-1' });
  assert.equal(staleStart.monitored, false);
  assert.equal(await monitor.api.getEnrollment('conversation-1'), null);

  const freshStart = await monitor.message({
    type: 'CHATGPT_MONITOR_STATE',
    snapshot: baseSnapshot({ workStartSignal: true })
  }, { tab: { id: 1, url: 'https://chatgpt.com/c/conversation-1', title: 'Build chat' }, documentId: 'document-1' });
  assert.equal(freshStart.monitored, true);
  assert.equal((await monitor.api.getEnrollment('conversation-1')).source, 'work-start-signal');

  const second = loadMonitor({ initialTabs: [{ id: 2, url: 'https://chatgpt.com/c/conversation-2', title: 'Build chat 2', discarded: false, frozen: false, active: true }] });
  await tick();
  const coded = await second.message({
    type: 'CHATGPT_MONITOR_STATE',
    snapshot: baseSnapshot({
      conversationId: 'conversation-2',
      conversationUrl: 'https://chatgpt.com/c/conversation-2',
      promptKey: 'conversation-2|user-1',
      statusCode: 'COMPLETE_APPLIED'
    })
  }, { tab: { id: 2, url: 'https://chatgpt.com/c/conversation-2', title: 'Build chat 2' }, documentId: 'document-2' });
  assert.equal(coded.monitored, true);
  assert.equal((await second.api.getEnrollment('conversation-2')).source, 'coded-turn');
});

test('manual Monitor on a new-chat page binds only after the next ChatGPT request is observed', async () => {
  const monitor = loadMonitor({ initialTabs: [{ id: 7, url: 'https://chatgpt.com/', title: 'New chat', discarded: false, frozen: false, active: true }] });
  await tick();
  const armed = await monitor.message({
    type: 'SET_BUILD_AUTOMATION_STATE',
    enabled: true,
    tabId: 7,
    conversationId: '',
    expectedRevision: 0,
    requestId: 'provisional'
  });
  assert.equal(armed.ok, true);
  assert.equal(armed.provisional, true);
  assert.equal(armed.automationEnabled, true);

  monitor.setTabs([{ id: 7, url: 'https://chatgpt.com/c/conversation-7', title: 'Build chat', discarded: false, frozen: false, active: true }]);
  await monitor.emit(monitor.events.tabsOnUpdated, 7, { url: 'https://chatgpt.com/c/conversation-7' }, monitor.getTabs()[0]);
  assert.equal(await monitor.api.getEnrollment('conversation-7'), null, 'navigation alone cannot transfer provisional authorization');

  monitor.setTabs([{ id: 7, url: 'https://chatgpt.com/', title: 'New chat', discarded: false, frozen: false, active: true }]);
  const rearmed = await monitor.message({
    type: 'SET_BUILD_AUTOMATION_STATE',
    enabled: true,
    tabId: 7,
    conversationId: '',
    expectedRevision: 0,
    requestId: 'provisional-2'
  });
  assert.equal(rearmed.ok, true);
  await monitor.emit(monitor.events.webBefore, { tabId: 7, method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation', requestId: 'network-7' });
  monitor.setTabs([{ id: 7, url: 'https://chatgpt.com/c/conversation-7', title: 'Build chat', discarded: false, frozen: false, active: true }]);
  await monitor.emit(monitor.events.tabsOnUpdated, 7, { url: 'https://chatgpt.com/c/conversation-7' }, monitor.getTabs()[0]);
  const enrollment = await monitor.api.getEnrollment('conversation-7');
  assert.equal(enrollment.enabled, true);
  assert.equal(enrollment.recoveryEnabled, true);
  assert.equal(enrollment.source, 'operator-provisional');
});

test('closing the owner tab detaches quietly and creates no needs-attention record', async () => {
  const monitor = loadMonitor();
  await tick();
  await monitor.message({ type: 'SET_BUILD_AUTOMATION_STATE', enabled: true, tabId: 1, conversationId: 'conversation-1', expectedRevision: 0, requestId: 'enable' });
  await monitor.message({
    type: 'CHATGPT_MONITOR_STATE',
    snapshot: baseSnapshot()
  }, { tab: { id: 1, url: 'https://chatgpt.com/c/conversation-1', title: 'Build chat' }, documentId: 'document-1' });

  monitor.setTabs([]);
  await monitor.emit(monitor.events.tabsOnRemoved, 1, { windowId: 1, isWindowClosing: false });
  const overview = await monitor.api.monitorOverview({ id: 'conversation-1', url: 'https://chatgpt.com/c/conversation-1', tab: { id: 1 } });
  assert.equal(overview.run.state, 'detached');
  assert.equal(overview.run.reason, 'owner-tab-closed-quiet');
  assert.equal(overview.run.ownerTabId, null);
  assert.equal(overview.attention.length, 0);
});

test('closing one duplicate tab transfers ownership to another observable copy without an alert', async () => {
  const monitor = loadMonitor({ initialTabs: [
    { id: 1, url: 'https://chatgpt.com/c/conversation-1', title: 'Build A', discarded: false, frozen: false, active: true },
    { id: 2, url: 'https://chatgpt.com/c/conversation-1', title: 'Build B', discarded: false, frozen: false, active: false }
  ] });
  await tick();
  await monitor.message({ type: 'SET_BUILD_AUTOMATION_STATE', enabled: true, tabId: 1, conversationId: 'conversation-1', expectedRevision: 0, requestId: 'enable' });
  await monitor.message({
    type: 'CHATGPT_MONITOR_STATE',
    snapshot: baseSnapshot()
  }, { tab: { id: 1, url: 'https://chatgpt.com/c/conversation-1', title: 'Build A' }, documentId: 'document-1' });

  monitor.setTabs([{ id: 2, url: 'https://chatgpt.com/c/conversation-1', title: 'Build B', discarded: false, frozen: false, active: true }]);
  monitor.setActive(2);
  await monitor.emit(monitor.events.tabsOnRemoved, 1, { windowId: 1, isWindowClosing: false });
  const overview = await monitor.api.monitorOverview({ id: 'conversation-1', url: 'https://chatgpt.com/c/conversation-1', tab: { id: 2 } });
  assert.equal(overview.run.ownerTabId, 2);
  assert.equal(overview.run.reason, 'owner-transferred-after-close');
  assert.equal(overview.attention.length, 0);
});
