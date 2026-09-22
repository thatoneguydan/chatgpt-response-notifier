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

function loadRequestPhaseHandler() {
  const source = readText('extension/monitor-script.js');
  const start = source.indexOf('function setRequestPhase');
  const end = source.indexOf('const messageListener', start);
  assert.ok(start >= 0 && end > start, 'request phase handler must exist');

  const context = vm.createContext({ Date, Math, Number, String, globalThis: null });
  context.globalThis = context;
  vm.runInContext(`
    let requestPhase = 'unknown';
    let requestStartedAt = 0;
    let requestSettledAt = 0;
    let requestId = '';
    let manualStopped = false;
    function resetStability() {}
    function schedulePublish() {}
    ${source.slice(start, end)}
    globalThis.__setRequestPhase = setRequestPhase;
    globalThis.__requestState = () => ({ requestPhase, requestStartedAt, requestSettledAt, requestId });
  `, context);

  return {
    apply: context.__setRequestPhase,
    state: context.__requestState
  };
}

test('completed-only request phase reconstructs fresh start evidence after page runtime replacement', () => {
  const handler = loadRequestPhaseHandler();
  handler.apply({
    phase: 'completed',
    requestId: 'network-new-chat',
    requestStartedAt: 1_000,
    observedAt: 2_000
  });
  assert.deepEqual(
    { ...handler.state() },
    {
      requestPhase: 'completed',
      requestStartedAt: 1_000,
      requestSettledAt: 2_000,
      requestId: 'network-new-chat'
    }
  );
});


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
    runtime: { onMessage: runtimeOnMessage },
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
    events: { tabsOnUpdated, tabsOnRemoved, webBefore, webCompleted, webError, alarmsOnAlarm },
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

test('sender-scoped in-page automation control mirrors popup Monitor Pause Resume semantics on its own tab', async () => {
  const monitor = loadMonitor({ initialTabs: [
    { id: 1, url: 'https://chatgpt.com/c/conversation-1', title: 'Other build', discarded: false, frozen: false, active: true },
    { id: 2, url: 'https://chatgpt.com/c/conversation-2', title: 'Indicator build', discarded: false, frozen: false, active: false }
  ] });
  await tick();

  const sender = { tab: { id: 2, url: 'https://chatgpt.com/c/conversation-2', title: 'Indicator build' } };
  const initial = await monitor.message({ type: 'GET_BUILD_AUTOMATION_OVERVIEW_FOR_SENDER' }, sender);
  assert.equal(initial.ok, true);
  assert.equal(initial.activeTabId, 2);
  assert.equal(initial.activeConversationId, 'conversation-2');
  assert.equal(initial.automationEnabled, false);
  assert.equal(initial.stateRevision, 0);

  const enabled = await monitor.message({
    type: 'SET_BUILD_AUTOMATION_STATE_FOR_SENDER',
    enabled: true,
    resumeExistingRun: false,
    tabId: 2,
    conversationId: 'conversation-2',
    expectedRevision: 0,
    requestId: 'indicator-monitor'
  }, sender);
  assert.equal(enabled.ok, true);
  assert.equal(enabled.requestId, 'indicator-monitor');
  assert.equal(enabled.activeTabId, 2);
  assert.equal(enabled.automationEnabled, true);
  assert.equal(enabled.monitoring, true);
  assert.equal(enabled.recoveryEnabled, true);
  assert.equal(enabled.pausedByUser, false);
  assert.equal(enabled.stateRevision, 1);
  const paused = await monitor.message({
    type: 'SET_BUILD_AUTOMATION_STATE_FOR_SENDER',
    enabled: false,
    resumeExistingRun: false,
    tabId: 2,
    conversationId: 'conversation-2',
    expectedRevision: 1,
    requestId: 'indicator-pause'
  }, sender);
  assert.equal(paused.ok, true);
  assert.equal(paused.automationEnabled, false);
  assert.equal(paused.pausedByUser, true);
  assert.equal(paused.stateRevision, 2);

  const resumed = await monitor.message({
    type: 'SET_BUILD_AUTOMATION_STATE_FOR_SENDER',
    enabled: true,
    resumeExistingRun: true,
    tabId: 2,
    conversationId: 'conversation-2',
    expectedRevision: 2,
    requestId: 'indicator-resume'
  }, sender);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.automationEnabled, true);
  assert.equal(resumed.monitoring, true);
  assert.equal(resumed.recoveryEnabled, true);
  assert.equal(resumed.pausedByUser, false);
  assert.equal(resumed.stateRevision, 3);
});

test('manual Monitor activation starts a fresh watchdog countdown even without request-start evidence', async () => {
  const idleSnapshot = baseSnapshot({
    requestPhase: 'unknown',
    requestId: '',
    requestStartedAt: 0,
    requestSettledAt: 0
  });
  const monitor = loadMonitor({
    sendMessage: async (_tabId, message) => {
      if (message?.type === 'CHATGPT_MONITOR_QUERY') return { ok: true, snapshot: idleSnapshot };
      return { ok: true };
    }
  });
  await tick();

  const before = Date.now();
  const enabled = await monitor.message({
    type: 'SET_BUILD_AUTOMATION_STATE',
    enabled: true,
    tabId: 1,
    conversationId: 'conversation-1',
    expectedRevision: 0,
    requestId: 'manual-idle-monitor'
  });
  const after = Date.now();

  assert.equal(enabled.ok, true);
  assert.equal(enabled.automationEnabled, true);
  assert.equal(enabled.codeWatchdog.stopped, false);
  assert.equal(enabled.codeWatchdog.sendCount, 0);
  assert.equal(enabled.codeWatchdog.lastPromptKey, 'conversation-1|user-1');
  assert.ok(Number(enabled.codeWatchdog.manualActivatedAt) >= before);
  assert.ok(Number(enabled.codeWatchdog.manualActivatedAt) <= after);
  assert.ok(Number(enabled.codeWatchdog.deadlineAt) >= before + 30 * 60_000);
  assert.ok(Number(enabled.codeWatchdog.deadlineAt) <= after + 30 * 60_000);

  const terminalSnapshot = baseSnapshot({
    statusCode: 'BLOCKED_HUMAN',
    requestPhase: 'unknown',
    requestId: '',
    requestStartedAt: 0,
    requestSettledAt: 0
  });
  const terminalMonitor = loadMonitor({
    sendMessage: async (_tabId, message) => {
      if (message?.type === 'CHATGPT_MONITOR_QUERY') return { ok: true, snapshot: terminalSnapshot };
      return { ok: true };
    }
  });
  await tick();

  const terminalEnabled = await terminalMonitor.message({
    type: 'SET_BUILD_AUTOMATION_STATE',
    enabled: true,
    tabId: 1,
    conversationId: 'conversation-1',
    expectedRevision: 0,
    requestId: 'manual-terminal-monitor'
  });
  assert.equal(terminalEnabled.ok, true);
  assert.equal(terminalEnabled.codeWatchdog.stopped, true);
  assert.equal(terminalEnabled.codeWatchdog.stopReason, 'status:BLOCKED_HUMAN');
  assert.equal(terminalEnabled.codeWatchdog.deadlineAt, 0);
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

test('fresh canonical project-start evidence auto-enrolls unless the operator explicitly paused', async () => {
  const monitor = loadMonitor();
  await tick();

  const projectStarted = await monitor.message({
    type: 'CHATGPT_MONITOR_STATE',
    snapshot: baseSnapshot({ projectStartSignal: true })
  }, { tab: { id: 1, url: 'https://chatgpt.com/c/conversation-1', title: 'Project build' }, documentId: 'document-1' });
  assert.equal(projectStarted.monitored, true);
  const enrolled = await monitor.api.getEnrollment('conversation-1');
  assert.equal(enrolled.enabled, true);
  assert.equal(enrolled.recoveryEnabled, true);
  assert.equal(enrolled.userPaused, false);
  assert.equal(enrolled.source, 'project-start-signal');

  const paused = await monitor.message({
    type: 'SET_BUILD_AUTOMATION_STATE',
    enabled: false,
    tabId: 1,
    conversationId: 'conversation-1',
    expectedRevision: enrolled.revision,
    requestId: 'pause-project'
  });
  assert.equal(paused.ok, true);
  assert.equal(paused.pausedByUser, true);

  const repeatedProject = await monitor.message({
    type: 'CHATGPT_MONITOR_STATE',
    snapshot: baseSnapshot({ projectStartSignal: true, requestId: 'request-2', requestStartedAt: 2_000 })
  }, { tab: { id: 1, url: 'https://chatgpt.com/c/conversation-1', title: 'Project build' }, documentId: 'document-1' });
  assert.equal(repeatedProject.monitored, false);
  const stillPaused = await monitor.api.getEnrollment('conversation-1');
  assert.equal(stillPaused.enabled, false);
  assert.equal(stillPaused.userPaused, true);
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

test('terminal status parks the watchdog for the request and later no-code snapshots cannot reopen it', async () => {
  const monitor = loadMonitor();
  await tick();

  await monitor.message({
    type: 'SET_BUILD_AUTOMATION_STATE',
    enabled: true,
    tabId: 1,
    conversationId: 'conversation-1',
    expectedRevision: 0,
    requestId: 'enable-terminal-test'
  });

  const sender = { tab: { id: 1, url: 'https://chatgpt.com/c/conversation-1', title: 'Build chat' }, documentId: 'document-1' };
  await monitor.message({ type: 'CHATGPT_MONITOR_STATE', snapshot: baseSnapshot() }, sender);
  const active = await monitor.api.readCodeWatchdog('conversation-1');
  assert.equal(active.stopped, false);
  assert.ok(Number(active.deadlineAt) > 0);

  await monitor.message({
    type: 'CHATGPT_MONITOR_STATE',
    snapshot: baseSnapshot({ statusCode: 'BLOCKED_HUMAN' })
  }, sender);
  const terminal = await monitor.api.readCodeWatchdog('conversation-1');
  assert.equal(terminal.stopped, true);
  assert.equal(terminal.stopReason, 'status:BLOCKED_HUMAN');
  assert.equal(terminal.lastStatusCode, 'BLOCKED_HUMAN');
  assert.equal(terminal.deadlineAt, 0);

  await monitor.message({
    type: 'CHATGPT_MONITOR_STATE',
    snapshot: baseSnapshot({
      statusCode: '',
      requestId: 'duplicate-phase-for-same-prompt',
      requestStartedAt: 1_500
    })
  }, sender);
  const staleNoCode = await monitor.api.readCodeWatchdog('conversation-1');
  assert.equal(staleNoCode.stopped, true);
  assert.equal(staleNoCode.stopReason, 'status:BLOCKED_HUMAN');
  assert.equal(staleNoCode.lastPromptKey, 'conversation-1|user-1');
  assert.equal(staleNoCode.lastRequestStartedAt, 1_500);
  assert.equal(staleNoCode.deadlineAt, 0);

  await monitor.message({
    type: 'CHATGPT_MONITOR_STATE',
    snapshot: baseSnapshot({
      promptKey: 'conversation-1|user-2',
      promptRevision: '2:c',
      requestId: 'request-2',
      requestStartedAt: 1_500,
      statusCode: ''
    })
  }, sender);
  const nextRequest = await monitor.api.readCodeWatchdog('conversation-1');
  assert.equal(nextRequest.stopped, false);
  assert.equal(nextRequest.lastRequestStartedAt, 1_500);
  assert.ok(Number(nextRequest.deadlineAt) > 0);

  await monitor.message({
    type: 'CHATGPT_MONITOR_STATE',
    snapshot: baseSnapshot({
      promptKey: 'conversation-1|user-1',
      promptRevision: '1:stale-terminal',
      requestId: 'request-2',
      requestStartedAt: 1_500,
      statusCode: 'BLOCKED_HUMAN'
    })
  }, sender);
  const staleOldPromptTerminal = await monitor.api.readCodeWatchdog('conversation-1');
  assert.equal(staleOldPromptTerminal.stopped, false);
  assert.equal(staleOldPromptTerminal.lastPromptKey, 'conversation-1|user-2');
  assert.equal(staleOldPromptTerminal.lastRequestStartedAt, 1_500);
});

test('late BLOCKED_HUMAN detected after an accidental watchdog send keeps the automatic follow-up stopped', async () => {
  const monitor = loadMonitor();
  await tick();

  await monitor.message({
    type: 'SET_BUILD_AUTOMATION_STATE',
    enabled: true,
    tabId: 1,
    conversationId: 'conversation-1',
    expectedRevision: 0,
    requestId: 'enable-raced-terminal-test'
  });

  const sender = { tab: { id: 1, url: 'https://chatgpt.com/c/conversation-1', title: 'Build chat' }, documentId: 'document-1' };
  await monitor.message({ type: 'CHATGPT_MONITOR_STATE', snapshot: baseSnapshot() }, sender);
  const active = await monitor.api.readCodeWatchdog('conversation-1');

  const terminal = await monitor.api.parkCodeWatchdogForTerminalStatus(
    baseSnapshot({ statusCode: 'BLOCKED_HUMAN' }),
    sender,
    active,
    20_000,
    'conversation-1|auto-user-2'
  );
  assert.equal(terminal.stopped, true);
  assert.equal(terminal.stopReason, 'status:BLOCKED_HUMAN');
  assert.equal(terminal.lastAutomaticSentAt, 20_000);
  assert.equal(terminal.lastAutomaticPromptKey, 'conversation-1|auto-user-2');

  await monitor.message({
    type: 'CHATGPT_MONITOR_STATE',
    snapshot: baseSnapshot({
      promptKey: 'conversation-1|auto-user-2',
      promptRevision: '2:auto',
      requestId: 'automatic-request-2',
      requestStartedAt: 20_001,
      statusCode: ''
    })
  }, sender);
  const accidentalFollowup = await monitor.api.readCodeWatchdog('conversation-1');
  assert.equal(accidentalFollowup.stopped, true);
  assert.equal(accidentalFollowup.stopReason, 'status:BLOCKED_HUMAN');
  assert.equal(accidentalFollowup.lastPromptKey, 'conversation-1|auto-user-2');
  assert.equal(accidentalFollowup.deadlineAt, 0);

  await monitor.message({
    type: 'CHATGPT_MONITOR_STATE',
    snapshot: baseSnapshot({
      promptKey: 'conversation-1|user-3',
      promptRevision: '3:human',
      requestId: 'human-request-3',
      requestStartedAt: 40_000,
      statusCode: ''
    })
  }, sender);
  const laterHumanRequest = await monitor.api.readCodeWatchdog('conversation-1');
  assert.equal(laterHumanRequest.stopped, false);
  assert.equal(laterHumanRequest.lastRequestStartedAt, 40_000);
  assert.ok(Number(laterHumanRequest.deadlineAt) > 0);
});

test('exact-prompt COMPLETE_APPLIED recheck stops an armed watchdog even when monitor snapshot missed it', async () => {
  let continueCommands = 0;
  const liveSnapshot = baseSnapshot({ statusCode: '' });
  const monitor = loadMonitor({
    sendMessage: async (_tabId, message) => {
      if (message?.type === 'CHATGPT_MONITOR_QUERY') return { ok: true, snapshot: liveSnapshot };
      if (message?.type === 'CHATGPT_STATUS_FOR_PROMPT_QUERY') {
        return {
          ok: true,
          conversationId: 'conversation-1',
          promptKey: 'conversation-1|user-1',
          statusCode: 'COMPLETE_APPLIED'
        };
      }
      if (message?.type === 'CHATGPT_WATCHDOG_CONTINUE_COMMAND') {
        continueCommands += 1;
        return { ok: true, clicked: true, continuationUserKey: 'conversation-1|auto-user-2' };
      }
      return { ok: true };
    }
  });
  await tick();

  await monitor.message({
    type: 'SET_BUILD_AUTOMATION_STATE',
    enabled: true,
    tabId: 1,
    conversationId: 'conversation-1',
    expectedRevision: 0,
    requestId: 'enable-exact-terminal-recheck'
  });

  const sender = { tab: { id: 1, url: 'https://chatgpt.com/c/conversation-1', title: 'Build chat' }, documentId: 'document-1' };
  await monitor.message({ type: 'CHATGPT_MONITOR_STATE', snapshot: liveSnapshot }, sender);
  await monitor.api.handleCodeWatchdogAlarm('conversation-1');

  const terminal = await monitor.api.readCodeWatchdog('conversation-1');
  assert.equal(continueCommands, 0);
  assert.equal(terminal.stopped, true);
  assert.equal(terminal.stopReason, 'status:COMPLETE_APPLIED');
  assert.equal(terminal.lastStatusCode, 'COMPLETE_APPLIED');
  assert.equal(terminal.deadlineAt, 0);
});

test('BLOCKED_HUMAN that appears after the automatic follow-up is queued still stops that follow-up', async () => {
  let liveSnapshot = baseSnapshot();
  const monitor = loadMonitor({
    sendMessage: async (_tabId, message) => {
      if (message?.type === 'CHATGPT_MONITOR_QUERY') return { ok: true, snapshot: liveSnapshot };
      if (message?.type === 'CHATGPT_WATCHDOG_CONTINUE_COMMAND') {
        return {
          ok: true,
          clicked: true,
          statusCode: '',
          continuationUserKey: 'conversation-1|auto-user-2'
        };
      }
      return { ok: true };
    }
  });
  await tick();

  await monitor.message({
    type: 'SET_BUILD_AUTOMATION_STATE',
    enabled: true,
    tabId: 1,
    conversationId: 'conversation-1',
    expectedRevision: 0,
    requestId: 'enable-delayed-terminal-test'
  });

  const sender = { tab: { id: 1, url: 'https://chatgpt.com/c/conversation-1', title: 'Build chat' }, documentId: 'document-1' };
  await monitor.message({ type: 'CHATGPT_MONITOR_STATE', snapshot: liveSnapshot }, sender);
  await monitor.api.handleCodeWatchdogAlarm('conversation-1');

  const automatic = await monitor.api.readCodeWatchdog('conversation-1');
  assert.equal(automatic.stopped, false);
  assert.equal(automatic.lastAutomaticPromptKey, 'conversation-1|auto-user-2');
  assert.equal(automatic.lastAutomaticParentPromptKey, 'conversation-1|user-1');

  const automaticRequestStartedAt = Date.now() + 1;
  liveSnapshot = baseSnapshot({
    promptKey: 'conversation-1|auto-user-2',
    promptRevision: '2:auto',
    requestId: 'automatic-request-2',
    requestStartedAt: automaticRequestStartedAt,
    previousPromptKey: 'conversation-1|user-1',
    previousStatusCode: 'BLOCKED_HUMAN',
    statusCode: ''
  });
  await monitor.message({ type: 'CHATGPT_MONITOR_STATE', snapshot: liveSnapshot }, sender);

  const terminal = await monitor.api.readCodeWatchdog('conversation-1');
  assert.equal(terminal.stopped, true);
  assert.equal(terminal.stopReason, 'status:BLOCKED_HUMAN');
  assert.equal(terminal.lastStatusCode, 'BLOCKED_HUMAN');
  assert.equal(terminal.lastAutomaticPromptKey, 'conversation-1|auto-user-2');
  assert.equal(terminal.lastAutomaticParentPromptKey, 'conversation-1|user-1');
  assert.equal(terminal.deadlineAt, 0);
});

test('timer allowance reset restores three sends without moving an active deadline and only reopens cap exhaustion', async () => {
  const monitor = loadMonitor();
  await tick();

  const active = monitor.api.codeWatchdogBudgetReset({
    conversationId: 'conversation-1',
    sendCount: 2,
    stopped: false,
    stopReason: '',
    deadlineAt: 50_000,
    retryAt: 0,
    retryReason: ''
  }, 10_000);
  assert.equal(active.sendCount, 0);
  assert.equal(active.deadlineAt, 50_000);
  assert.equal(active.stopped, false);
  assert.equal(active.budgetResetAt, 10_000);

  const exhausted = monitor.api.codeWatchdogBudgetReset({
    conversationId: 'conversation-1',
    sendCount: 3,
    stopped: true,
    stopReason: 'retry-cap-reached',
    deadlineAt: 0,
    retryAt: 0,
    retryReason: ''
  }, 20_000);
  assert.equal(exhausted.sendCount, 0);
  assert.equal(exhausted.stopped, false);
  assert.equal(exhausted.stopReason, '');
  assert.equal(exhausted.deadlineAt, 20_000 + 30 * 60_000);

  const terminal = monitor.api.codeWatchdogBudgetReset({
    conversationId: 'conversation-1',
    sendCount: 2,
    stopped: true,
    stopReason: 'status:BLOCKED_HUMAN',
    deadlineAt: 0,
    retryAt: 0,    retryReason: ''
  }, 30_000);
  assert.equal(terminal.sendCount, 0);
  assert.equal(terminal.stopped, true);
  assert.equal(terminal.stopReason, 'status:BLOCKED_HUMAN');
  assert.equal(terminal.deadlineAt, 0);

  await monitor.message({
    type: 'SET_BUILD_AUTOMATION_STATE',
    enabled: true,
    tabId: 1,
    conversationId: 'conversation-1',
    expectedRevision: 0,
    requestId: 'enable-reset-test'
  });
  const sender = { tab: { id: 1, url: 'https://chatgpt.com/c/conversation-1', title: 'Build chat' }, documentId: 'document-1' };
  await monitor.message({ type: 'CHATGPT_MONITOR_STATE', snapshot: baseSnapshot() }, sender);
  const before = await monitor.api.readCodeWatchdog('conversation-1');

  const reset = await monitor.message({
    type: 'RESET_CODE_WATCHDOG_BUDGET_FOR_SENDER',
    conversationId: 'conversation-1',
    requestId: 'reset-budget'
  }, sender);
  assert.equal(reset.ok, true);
  assert.equal(reset.requestId, 'reset-budget');
  assert.equal(reset.codeWatchdog.sendCount, 0);
  assert.equal(reset.codeWatchdog.deadlineAt, before.deadlineAt);
  assert.ok(Number(reset.codeWatchdog.budgetResetAt) > 0);
});


test('web request completion carries the original start time to a replacement page runtime', async () => {
  const sent = [];
  const monitor = loadMonitor({
    sendMessage: async (tabId, message) => {
      sent.push({ tabId, message: clone(message) });
      return { ok: true };
    }
  });
  await tick();
  sent.length = 0;

  const request = {
    tabId: 1,
    method: 'POST',
    url: 'https://chatgpt.com/backend-api/f/conversation',
    requestId: 'network-runtime-replacement'
  };
  await monitor.emit(monitor.events.webBefore, request);
  const started = sent.find((entry) =>
    entry.message?.type === 'CHATGPT_MONITOR_REQUEST_PHASE'
    && entry.message?.phase === 'started'
    && entry.message?.requestId === request.requestId
  );
  assert.ok(started, 'started phase should be sent');
  assert.ok(Number(started.message.requestStartedAt) > 0);

  await monitor.emit(monitor.events.webCompleted, { ...request, timeStamp: Number(started.message.requestStartedAt) + 250 });
  const completed = sent.find((entry) =>
    entry.message?.type === 'CHATGPT_MONITOR_REQUEST_PHASE'
    && entry.message?.phase === 'completed'
    && entry.message?.requestId === request.requestId
  );
  assert.ok(completed, 'completed phase should be sent');
  assert.equal(completed.message.requestStartedAt, started.message.requestStartedAt);
});

test('manual Monitor on a new-chat page survives URL assignment before request arming and binds on that request', async () => {
  const monitor = loadMonitor({ initialTabs: [{ id: 7, url: 'https://chatgpt.com/', title: 'New chat', discarded: false, frozen: false, active: true }] });
  await tick();

  const enabled = await monitor.message({
    type: 'SET_BUILD_AUTOMATION_STATE',
    enabled: true,
    tabId: 7,
    conversationId: '',
    expectedRevision: 0,
    requestId: 'provisional'
  });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.provisional, true);
  assert.equal(enabled.automationEnabled, true);

  // Reproduce the live race: ChatGPT assigns /c/... before the asynchronous
  // webRequest arm finishes. URL assignment alone must not bind or discard
  // the provisional operator choice.
  monitor.setTabs([{ id: 7, url: 'https://chatgpt.com/c/conversation-7', title: 'Build chat', discarded: false, frozen: false, active: true }]);
  await monitor.emit(monitor.events.tabsOnUpdated, 7, { url: 'https://chatgpt.com/c/conversation-7' }, monitor.getTabs()[0]);
  assert.equal(await monitor.api.getEnrollment('conversation-7'), null, 'navigation alone cannot transfer provisional authorization');

  await monitor.emit(monitor.events.webBefore, {
    tabId: 7,
    method: 'POST',
    url: 'https://chatgpt.com/backend-api/f/conversation',
    requestId: 'network-7'
  });

  const observed = await monitor.message({
    type: 'CHATGPT_MONITOR_STATE',
    snapshot: baseSnapshot({
      conversationId: 'conversation-7',
      conversationUrl: 'https://chatgpt.com/c/conversation-7',
      promptKey: 'conversation-7|user-1',
      requestId: 'network-7'
    })
  }, { tab: { id: 7, url: 'https://chatgpt.com/c/conversation-7', title: 'Build chat' }, documentId: 'document-7' });

  assert.equal(observed.monitored, true);
  const enrollment = await monitor.api.getEnrollment('conversation-7');
  assert.equal(enrollment.enabled, true);
  assert.equal(enrollment.recoveryEnabled, true);
  assert.equal(enrollment.userPaused, false);
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