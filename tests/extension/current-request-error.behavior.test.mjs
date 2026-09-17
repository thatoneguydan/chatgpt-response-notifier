import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const readText = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';

class FakeNode {
  constructor({ role = '', id = '', text = '', parent = null, hidden = false, connected = true, excluded = false, onRead = null } = {}) {
    this.role = role;
    this.id = id;
    this.parent = parent;
    this.hidden = hidden;
    this.isConnected = connected;
    this.excluded = excluded;
    this.onRead = onRead;
    this._text = text;
    this.styleState = { display: 'block', visibility: 'visible' };
  }
  get innerText() { this.onRead?.(); return this._text; }
  get textContent() { this.onRead?.(); return this._text; }
  set textContent(value) { this._text = String(value || ''); }
  getAttribute(name) {
    if (name === 'data-turn' || name === 'data-message-author-role') return this.role;
    if (name === 'data-testid') return this.id;
    if (name === 'aria-hidden') return this.hidden ? 'true' : null;
    return null;
  }
  matches(selector) { return selector === `[data-message-author-role="${this.role}"]`; }
  querySelector(selector) {
    if (selector === `[data-message-author-role="${this.role}"]`) return this;
    return null;
  }
  querySelectorAll() { return []; }
  closest(selector) {
    if (selector === TURN_SELECTOR) {
      let current = this;
      while (current) {
        if (current.id?.startsWith('conversation-turn-')) return current;
        current = current.parent;
      }
      return null;
    }
    if (selector.includes('[hidden]') || selector.includes('[aria-hidden="true"]')) return this.hidden ? this : null;
    if (selector.includes('pre') || selector.includes('.markdown') || selector.includes('[data-tool]')) return this.excluded ? this : null;
    return null;
  }
  cloneNode() { return new FakeNode({ role: this.role, id: this.id, text: this._text }); }
}

function harness({ turns, semanticNodes, href = 'https://chatgpt.com/c/conversation-1', focused = false, visibilityState = 'hidden' }) {
  const runtimeListeners = [];
  const location = { href, pathname: new URL(href).pathname };
  const documentElement = new FakeNode({ id: 'root' });
  const document = {
    documentElement,
    body: documentElement,
    visibilityState,
    hasFocus: () => focused,
    querySelectorAll(selector) {
      if (selector === TURN_SELECTOR) return turns;
      if (selector.includes('[role="alert"]') || selector.includes('[aria-live="assertive"]')) return semanticNodes;
      if (selector === 'input[type="file"]') return [];
      return [];
    },
    querySelector(selector) {
      if (selector === 'main') return null;
      return null;
    },
    addEventListener() {},
    removeEventListener() {}
  };

  const context = vm.createContext({
    console,
    URL,
    Date,
    Number,
    String,
    Set,
    Map,
    Object,
    Math,
    crypto: webcrypto,
    AbortController,
    Element: FakeNode,
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: class {},
    Event: class {},
    location,
    document,
    navigator: { onLine: true },
    getComputedStyle: (node) => node.styleState,
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 1,
    clearTimeout: () => {},
    window: { addEventListener() {} },
    chrome: {
      runtime: {
        sendMessage: async () => ({}),
        onMessage: {
          addListener(listener) { runtimeListeners.push(listener); },
          removeListener() {}
        }
      }
    }
  });
  vm.runInContext(readText('extension/status-code.js'), context);
  vm.runInContext(readText('extension/status-policy.js'), context);
  vm.runInContext(readText('extension/monitor-script.js'), context);

  const runtime = context.__chatgptNotifierMonitorRuntime;
  const snapshot = () => runtime.snapshot();
  const inspect = (expected = {}) => runtime.inspectCurrentRequestUi(expected);
  const requestPhase = (phase, requestId = 'request-1') => {
    const listener = runtimeListeners.at(-1);
    listener({ type: 'CHATGPT_MONITOR_REQUEST_PHASE', phase, requestId, observedAt: Date.now() }, {}, () => {});
  };
  return { context, runtime, snapshot, inspect, requestPhase, location };
}

function turn(role, n, text = '') {
  return new FakeNode({ role, id: `conversation-turn-${n}`, text });
}

function alertFor(owner, text, overrides = {}) {
  return new FakeNode({ parent: owner, text, ...overrides });
}

function expectedFrom(snapshot) {
  return { conversationId: snapshot.conversationId, documentId: snapshot.documentId, promptKey: snapshot.promptKey };
}

test('historical, hidden, detached and quoted interruption text is ignored', () => {
  const oldUser = turn('user', 1, 'old');
  const oldAssistant = turn('assistant', 2, 'old reply');
  const currentUser = turn('user', 3, 'new');
  const currentAssistant = turn('assistant', 4, 'new reply');
  const historical = alertFor(oldAssistant, 'Message delivery timed out');
  const hidden = alertFor(currentAssistant, 'Message delivery timed out', { hidden: true });
  const detached = alertFor(currentAssistant, 'Connection interrupted', { connected: false });
  const quoted = alertFor(currentAssistant, 'Connection interrupted', { excluded: true });
  const h = harness({ turns: [oldUser, oldAssistant, currentUser, currentAssistant], semanticNodes: [historical, hidden, detached, quoted] });
  const s = h.snapshot();
  const result = h.inspect(expectedFrom(s));
  assert.equal(result.explicitInterruption, false);
  assert.equal(result.rateLimited, false);
});

test('visible current-turn timeout is attributable even when the tab is inactive', () => {
  const user = turn('user', 1, 'prompt');
  const assistant = turn('assistant', 2, 'reply');
  const h = harness({ turns: [user, assistant], semanticNodes: [alertFor(assistant, 'Message delivery timed out')], focused: false, visibilityState: 'hidden' });
  const s = h.snapshot();
  const result = h.inspect(expectedFrom(s));
  assert.equal(result.explicitInterruption, true);
  assert.equal(result.interruptionKind, 'timed-out');
  assert.equal(result.interruptionAttribution, 'current-turn');
});

test('current-turn auth approval and rate-limit blockers are surfaced as vetoes', () => {
  const user = turn('user', 1, 'prompt');
  const assistant = turn('assistant', 2, 'reply');
  const h = harness({
    turns: [user, assistant],
    semanticNodes: [
      alertFor(assistant, 'Please sign in'),
      alertFor(assistant, 'Approval required'),
      alertFor(assistant, 'Too many requests. Try again later.')
    ]
  });
  const s = h.snapshot();
  const result = h.inspect(expectedFrom(s));
  assert.equal(result.authRequired, true);
  assert.equal(result.approvalRequired, true);
  assert.equal(result.rateLimited, true);
});

test('page-global interruption is ignored unless a fresh current request actually errored', () => {
  const user = turn('user', 1, 'prompt');
  const assistant = turn('assistant', 2, 'reply');
  const globalAlert = new FakeNode({ text: 'Connection interrupted' });
  const h = harness({ turns: [user, assistant], semanticNodes: [globalAlert] });
  let s = h.snapshot();
  assert.equal(h.inspect(expectedFrom(s)).explicitInterruption, false);
  h.requestPhase('started');
  h.requestPhase('error');
  s = h.snapshot();
  const result = h.inspect(expectedFrom(s));
  assert.equal(result.explicitInterruption, true);
  assert.equal(result.interruptionAttribution, 'current-request-global');
});

test('document or prompt identity mismatch fails closed and SPA navigation during inspection is rejected', () => {
  const user = turn('user', 1, 'prompt');
  const assistant = turn('assistant', 2, 'reply');
  let h;
  const racing = alertFor(assistant, 'Connection interrupted', { onRead: () => {
    h.location.href = 'https://chatgpt.com/c/conversation-2';
    h.location.pathname = '/c/conversation-2';
  } });
  h = harness({ turns: [user, assistant], semanticNodes: [racing] });
  const s = h.snapshot();
  assert.equal(h.inspect({ ...expectedFrom(s), documentId: 'wrong-document' }).applicationStateIdentityMatched, false);
  const raced = h.inspect(expectedFrom(s));
  assert.equal(raced.applicationStateIdentityMatched, false);
  assert.equal(raced.explicitInterruption, false);
});

test('shared classifier covers current-turn disconnected interrupted and failed variants', () => {
  const cases = [
    ['Disconnected', 'connection-interrupted'],
    ['Response interrupted', 'connection-interrupted'],
    ['Response failed', 'generation-error']
  ];
  for (const [text, expectedKind] of cases) {
    const user = turn('user', 1, 'prompt');
    const assistant = turn('assistant', 2, 'reply');
    const h = harness({ turns: [user, assistant], semanticNodes: [alertFor(assistant, text)] });
    const s = h.snapshot();
    const result = h.inspect(expectedFrom(s));
    assert.equal(result.explicitInterruption, true, text);
    assert.equal(result.interruptionKind, expectedKind, text);
    assert.equal(result.interruptionAttribution, 'current-turn', text);
  }
});

test('healthy Thinking longer text is not classified as an interruption', () => {
  const user = turn('user', 1, 'prompt');
  const assistant = turn('assistant', 2, 'reply');
  const h = harness({ turns: [user, assistant], semanticNodes: [alertFor(assistant, 'Thinking longer')] });
  const s = h.snapshot();
  const result = h.inspect(expectedFrom(s));
  assert.equal(result.explicitInterruption, false);
  assert.equal(result.interruptionKind, '');
});

test('global canonical error variants require fresh request-error attribution', () => {
  const cases = [
    ['Disconnected', 'connection-interrupted'],
    ['Response interrupted', 'connection-interrupted'],
    ['Response failed', 'generation-error']
  ];
  for (const [text, expectedKind] of cases) {
    const user = turn('user', 1, 'prompt');
    const assistant = turn('assistant', 2, 'reply');
    const h = harness({ turns: [user, assistant], semanticNodes: [new FakeNode({ text })] });
    let s = h.snapshot();
    assert.equal(h.inspect(expectedFrom(s)).explicitInterruption, false, `${text} before request error`);
    h.requestPhase('started');
    h.requestPhase('error');
    s = h.snapshot();
    const result = h.inspect(expectedFrom(s));
    assert.equal(result.explicitInterruption, true, `${text} after request error`);
    assert.equal(result.interruptionKind, expectedKind, text);
    assert.equal(result.interruptionAttribution, 'current-request-global', text);
  }
});

test('safety vetoes are retained regardless of mixed error node order', () => {
  for (const semanticNodes of [
    [new FakeNode({ text: 'Response failed' }), new FakeNode({ text: 'Too many requests. Try again later.' })],
    [new FakeNode({ text: 'Too many requests. Try again later.' }), new FakeNode({ text: 'Response failed' })]
  ]) {
    const user = turn('user', 1, 'prompt');
    const assistant = turn('assistant', 2, 'reply');
    const h = harness({ turns: [user, assistant], semanticNodes });
    h.requestPhase('started');
    h.requestPhase('error');
    const s = h.snapshot();
    assert.equal(s.explicitInterruption, true);
    assert.equal(s.rateLimited, true);
    assert.equal(h.context.ChatGPTNotifierContinuationPolicy.classifyObservation(s).reason, 'rate-limited');
  }
});
