import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');

function makeTurn(role, id, text) {
  const roleNode = {
    innerText: text,
    textContent: text,
    querySelector: () => null
  };
  return {
    id,
    innerText: text,
    textContent: text,
    getAttribute(name) {
      if (name === 'data-turn') return role;
      if (name === 'data-testid') return id;
      return '';
    },
    matches: () => false,
    querySelector(selector) {
      if (selector === `[data-message-author-role="${role}"]`) return roleNode;
      return null;
    }
  };
}

function createBoundedRecoveryHarness({ recoveryClass = 'explicit-interruption', explicit = true, assistantKey = 'assistant-1', silentIdleConfirmations = 0 } = {}) {
  const runtimeListeners = [];
  const originalUser = makeTurn('user', 'conversation-turn-user-1', 'original request');
  const assistant = makeTurn('assistant', 'conversation-turn-assistant-1', 'partial response');
  const turns = [originalUser, assistant];
  let sentText = '';

  class FakeTextAreaElement {
    constructor() { this.value = ''; this.disabled = false; this.isContentEditable = false; }
    getAttribute() { return null; }
    focus() {}
    dispatchEvent() { return true; }
    closest(selector) { return selector === 'form' ? form : null; }
  }
  class FakeInputElement extends FakeTextAreaElement {}
  class FakeInputEvent { constructor(type, init) { this.type = type; this.init = init; } }
  class FakeEvent { constructor(type, init) { this.type = type; this.init = init; } }

  const composer = new FakeTextAreaElement();
  const sendButton = {
    disabled: false,
    getAttribute: () => null,
    click() {
      sentText = composer.value;
      turns.push(makeTurn('user', `conversation-turn-user-${turns.length + 1}`, sentText));
      composer.value = '';
    }
  };
  const form = {
    querySelector(selector) {
      if (/send-button|Send prompt|Send message|Send/.test(selector)) return sendButton;
      return null;
    }
  };
  const rootNode = { querySelector: () => null };
  const snapshot = {
    conversationId: 'conversation-1',
    documentId: 'document-2',
    promptKey: 'conversation-1|conversation-turn-user-1',
    promptRevision: 'prompt-rev-1',
    assistantKey,
    assistantRevision: 'assistant-rev-1',
    silentIdleConfirmations,
    hasUpload: false,
    manualStopped: false,
    authRequired: false,
    approvalRequired: false,
    rateLimited: false,
    online: true
  };

  const document = {
    body: rootNode,
    documentElement: rootNode,
    visibilityState: 'hidden',
    addEventListener() {},
    hasFocus: () => false,
    querySelector(selector) {
      if (selector === '#prompt-textarea' || selector.includes('prompt-textarea')) return composer;
      if (selector.includes('stop-button') || selector.includes('Stop generating')) return null;
      if (selector === 'main') return rootNode;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-testid^="conversation-turn-"]') return turns;
      return [];
    }
  };

  const context = vm.createContext({
    console,
    AbortController,
    Date,
    Intl,
    Math,
    String,
    Number,
    Object,
    Array,
    Set,
    Promise,
    document,
    location: { pathname: '/c/conversation-1' },
    HTMLTextAreaElement: FakeTextAreaElement,
    HTMLInputElement: FakeInputElement,
    InputEvent: FakeInputEvent,
    Event: FakeEvent,
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: {
        onMessage: {
          addListener: (listener) => runtimeListeners.push(listener),
          removeListener() {}
        }
      }
    },
    ChatGPTNotifierContinuationPolicy: {
      userInteractionBlockReason: () => '',
      isCurrentExplicitInterruption: (observation) => observation?.explicitInterruption === true
    },
    __chatgptNotifierMonitorRuntime: { snapshot: () => ({ ...snapshot }) },
    __chatgptNotifierRecoveryLiveContent: {
      detectExplicitInterruption: () => ({
        explicitInterruption: explicit,
        interruptionKind: explicit ? 'timed-out' : '',
        interruptionAttribution: explicit ? 'current-request-global' : '',
        applicationStateIdentityMatched: true
      })
    }
  });

  vm.runInContext(readText('extension/bounded-recovery-script.js'), context);
  const listener = runtimeListeners.at(-1);
  assert.equal(typeof listener, 'function');

  async function command() {
    return await new Promise((resolve) => {
      const keptOpen = listener({
        type: 'CHATGPT_BOUNDED_RECOVERY_COMMAND',
        kind: 'continue',
        expected: {
          conversationId: snapshot.conversationId,
          documentId: snapshot.documentId,
          promptKey: snapshot.promptKey,
          promptRevision: snapshot.promptRevision,
          recoveryClass,
          recoveryReason: recoveryClass === 'explicit-interruption' ? 'post-reload-explicit-interruption' : 'post-reload-silent-stop'
        }
      }, {}, resolve);
      assert.equal(keptOpen, true);
    });
  }

  return { command, sentText: () => sentText };
}

test('explicit post-refresh recovery sends one timestamped Continue even when an assistant/error turn remains', async () => {
  const harness = createBoundedRecoveryHarness({
    recoveryClass: 'explicit-interruption',
    explicit: true,
    assistantKey: 'assistant-1',
    silentIdleConfirmations: 0
  });
  const result = await harness.command();
  assert.equal(result.ok, true);
  assert.equal(result.clicked, true);
  assert.equal(result.reason, 'continue-user-turn-confirmed');
  assert.match(harness.sentText(), /^\[[^\]]+\] Continue until you finish or need something from me\.$/);
  assert.notEqual(harness.sentText(), 'continue until you finish or need something from me');
});

test('silent-stop recovery still refuses Continue while an assistant turn remains', async () => {
  const harness = createBoundedRecoveryHarness({
    recoveryClass: 'silent-stop',
    explicit: false,
    assistantKey: 'assistant-1',
    silentIdleConfirmations: 2
  });
  const result = await harness.command();
  assert.equal(result.ok, false);
  assert.equal(result.clicked, false);
  assert.equal(result.reason, 'recovery-identity-changed');
  assert.equal(harness.sentText(), '');
});

function sharedSessionStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

function createRecoveryLiveContext({ sessionStorage, documentId, timeoutVisible }) {
  const timeoutNode = {
    isConnected: true,
    hidden: false,
    innerText: 'Response timed out',
    textContent: 'Response timed out',
    closest: () => null,
    getBoundingClientRect: () => ({ width: 200, height: 40 })
  };
  const snapshot = {
    conversationId: 'conversation-1',
    documentId,
    promptKey: 'conversation-1|user-1',
    assistantKey: 'assistant-1',
    assistantRevision: 'assistant-rev-1',
    statusCode: '',
    stopGenerating: false,
    toolActivity: false,
    requestPhase: timeoutVisible ? 'error' : 'unknown',
    requestSettledAt: timeoutVisible ? Date.now() : 0
  };
  const document = {
    documentElement: {},
    body: {},
    querySelectorAll: () => timeoutVisible ? [timeoutNode] : []
  };
  const runtimeListeners = [];
  const context = vm.createContext({
    console,
    Date,
    JSON,
    String,
    Number,
    Array,
    Object,
    RegExp,
    Map,
    Set,
    Math,
    sessionStorage,
    document,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    chrome: {
      runtime: {
        onMessage: {
          addListener: (listener) => runtimeListeners.push(listener),
          removeListener() {}
        },
        sendMessage: async () => ({ ok: true })
      }
    },
    __chatgptNotifierMonitorRuntime: {
      snapshot: () => ({ ...snapshot }),
      inspectCurrentRequestUi: () => ({
        explicitInterruption: false,
        interruptionKind: '',
        interruptionAttribution: '',
        rateLimited: false,
        authRequired: false,
        approvalRequired: false,
        conversationId: snapshot.conversationId,
        documentId: snapshot.documentId,
        promptKey: snapshot.promptKey,
        applicationStateIdentityMatched: true,
        applicationStateReason: 'primary-no-match'
      })
    }
  });
  vm.runInContext(readText('extension/status-policy.js'), context);
  vm.runInContext(readText('extension/recovery-live-fix-content.js'), context);
  return context.__chatgptNotifierRecoveryLiveContent;
}

test('unchanged interrupted response remains recoverable after banner disappears on reload', () => {
  const storage = sharedSessionStorage();
  const beforeReload = createRecoveryLiveContext({ sessionStorage: storage, documentId: 'document-1', timeoutVisible: true });
  const first = beforeReload.detectExplicitInterruption({ conversationId: 'conversation-1', documentId: 'document-1', promptKey: 'conversation-1|user-1' });
  assert.equal(first.explicitInterruption, true);
  assert.equal(first.interruptionKind, 'timed-out');

  const afterReload = createRecoveryLiveContext({ sessionStorage: storage, documentId: 'document-2', timeoutVisible: false });
  const second = afterReload.detectExplicitInterruption({ conversationId: 'conversation-1', documentId: 'document-2', promptKey: 'conversation-1|user-1' });
  assert.equal(second.explicitInterruption, true);
  assert.equal(second.interruptionKind, 'timed-out');
  assert.equal(second.applicationStateReason, 'post-reload-response-unchanged');
  assert.equal(second.documentId, 'document-2');
});
