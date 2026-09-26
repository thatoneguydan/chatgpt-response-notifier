// Diagnostic reproduction for Notifier 0.9.88; no network or browser actions.
// Run: node tools/reproduce-watchdog-cadence-20260926.mjs
// Assertions document the vulnerable baseline, not acceptance of the fix.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';


const root = new URL('../', import.meta.url);
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
    return new FakeStore(this, this.database.stores.get(name), name);
  }

  request(action) {
    this.pending += 1;
    const handlers = [];
    const request = { result: undefined, error: null, onsuccess: null, onerror: null, addEventListener(kind, fn) { if (kind === 'success') handlers.push(fn); } };
    queueMicrotask(() => {
      if (this.finished) return;
      try {
        request.result = action();
        handlers.forEach(fn => fn());
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
  constructor(transaction, definition, name) {
    this.name = name;
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
  close() {}
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
    projectStartSignal: false,
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

function loadMonitor({ initialTabs = [{ id: 1, url: 'https://chatgpt.com/c/conversation-1', title: 'Build chat', discarded: false, frozen: false, active: true }], sendMessage = null } = {}) {
  let tabs = initialTabs.map(clone);
  let activeTabId = tabs.find((tab) => tab.active)?.id ?? tabs[0]?.id ?? null;
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

  const chrome = {
    runtime: { onMessage: runtimeOnMessage, getManifest: () => ({version: '0.9.88'}) },
    alarms: {
      onAlarm: alarmsOnAlarm,
      create(name, info = {}) { alarmState.set(String(name), clone(info)); },
      async clear(name) { return alarmState.delete(String(name)); }
    },
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
      async sendMessage(...args) {
        if (typeof sendMessage === 'function') return await sendMessage(...args);
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
  vm.runInContext(readText('extension/watchdog-sole-continuation-authority-background.js'), context);
  vm.runInContext(readText('extension/watchdog-authority-v3-background.js'), context);

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
    context, indexedDB, alarmState,
    api: context.__chatgptNotifierMonitorBackground,
    message,
    emit,
    events: { tabsOnUpdated, tabsOnRemoved, webBefore, webCompleted, webError, alarmsOnAlarm },
    getTabs: () => tabs.map(clone),
    setTabs(next) { tabs = next.map(clone); },
    setActive(tabId) { activeTabId = tabId; }
  };
}


let now = 10_000_000;
class Clock extends Date { static now() { return now; } }
const D = 30 * 60_000;
const sender = {tab:{id:1,url:'https://chatgpt.com/c/conversation-1'}};
async function scenario({name, confirmed=true, duplicate=false, future=false, dropped=false}) {
  now = 10_000_000;
  let dispatches=0;
  const snapshot=baseSnapshot({requestStartedAt: now-D, promptKey:'conversation-1|user-1'});
  const monitor=loadMonitor({sendMessage: async (_,m)=>{
    if(m.type==='CHATGPT_MONITOR_QUERY') return {snapshot};
    if(m.type==='CHATGPT_STATUS_FOR_PROMPT_QUERY') return {ok:true,conversationId:'conversation-1',promptKey:snapshot.promptKey,statusCode:''};
    if(m.type==='CHATGPT_WATCHDOG_CONTINUE_COMMAND') {
      dispatches++;
      if(dropped && dispatches===1) throw new Error('response port closed after click');
      return confirmed ? {ok:true,clicked:true,continuationUserKey:'conversation-1|auto-'+dispatches} : {ok:false,clicked:true,reason:'continuation-user-turn-not-confirmed'};
    }
    return {ok:true,runtimeVersion:99};
  }});
  await tick(5);
  await monitor.api.setEnrollment({id:'conversation-1',url:sender.tab.url},true,'operator');
  const db=monitor.indexedDB.databases.get('chatgpt-response-notifier-monitor');
  const state={key:'code-watchdog:conversation-1',conversationId:'conversation-1',conversationUrl:sender.tab.url,ownerTabId:1,sendCount:0,stopped:false,lastRequestStartedAt:snapshot.requestStartedAt,lastPromptKey:snapshot.promptKey,deadlineAt:future?now+D:now,retryAt:0,retryReason:''};
  const tx=db.transaction('profile');tx.objectStore('profile').put(state);await tick();
  if(duplicate) await Promise.all([monitor.context.__chatgptNotifierWatchdogAuthorityV3.runDueWatchdogNow({conversationId:'conversation-1'},sender), monitor.context.__chatgptNotifierWatchdogAuthorityV3.runDueWatchdogNow({conversationId:'conversation-1'},sender)]);
  else await monitor.api.handleCodeWatchdogAlarm('conversation-1');
  const first=await monitor.api.readCodeWatchdog('conversation-1');
  if(!confirmed) {now+=60_000;await monitor.api.handleCodeWatchdogAlarm('conversation-1');}
  const final=await monitor.api.readCodeWatchdog('conversation-1');
  console.log(JSON.stringify({name,dispatches,sendCount:final.sendCount,deadlineAt:final.deadlineAt,retryAt:final.retryAt,lastAutomaticSentAt:final.lastAutomaticSentAt||0,now}));
  return {dispatches,first,final};
}
const early=await scenario({name:'future-deadline stale alarm',future:true});
assert.equal(early.dispatches,1,'reproduces forbidden early dispatch');
const dup=await scenario({name:'two page-authority due signals before serialized queue executes',duplicate:true});
assert.equal(dup.dispatches,2,'reproduces duplicate dispatch within same deadline');
const uncertain=await scenario({name:'clicked but unconfirmed, minute retry',confirmed:false});
assert.equal(uncertain.dispatches,2,'reproduces second dispatch after 60 seconds');
assert.equal(uncertain.final.sendCount,0,'unconfirmed clicks do not consume send budget');
const lost=await scenario({name:'response-port failure after first click',dropped:true});
assert.equal(lost.dispatches,2,'reproduces immediate command replay after transport loss');
