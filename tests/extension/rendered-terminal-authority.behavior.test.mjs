import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root), 'utf8');
const helperSource = read('extension/rendered-terminal-status.js');

class FakeNode {
  constructor(tag = 'div', text = '', children = [], attributes = {}) {
    this.tagName = String(tag).toUpperCase();
    this._text = String(text || '');
    this.children = children;
    this.attributes = { ...attributes };
    this.parentElement = null;
    this.innerText = this._text;
    for (const child of children) child.parentElement = this;
  }

  get textContent() {
    return `${this._text}${this.children.map((child) => child.textContent).join('')}`;
  }

  set textContent(value) {
    this._text = String(value || '');
    this.children = [];
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  matches(selector) {
    return String(selector || '').split(',').some((part) => this.#matchesOne(part.trim()));
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  contains(candidate) {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  compareDocumentPosition(candidate) {
    let root = this;
    while (root.parentElement) root = root.parentElement;
    const ordered = [];
    const visit = (node) => {
      ordered.push(node);
      for (const child of node.children) visit(child);
    };
    visit(root);
    const left = ordered.indexOf(this);
    const right = ordered.indexOf(candidate);
    if (left < 0 || right < 0 || left === right) return 0;
    return right > left ? 4 : 2;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }

  cloneNode(deep = false) {
    return new FakeNode(
      this.tagName.toLowerCase(),
      this._text,
      deep ? this.children.map((child) => child.cloneNode(true)) : [],
      this.attributes
    );
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  #matchesOne(selector) {
    if (!selector) return false;
    if (/^[a-z]+$/i.test(selector)) return this.tagName === selector.toUpperCase();
    const exactAttr = selector.match(/^\[([^=]+)="([^"]+)"\]$/);
    if (exactAttr) return String(this.getAttribute(exactAttr[1]) || '') === exactAttr[2];
    if (selector === '[hidden]') return this.getAttribute('hidden') !== null;
    if (selector === '[inert]') return this.getAttribute('inert') !== null;
    if (selector === '[data-tool]') return this.getAttribute('data-tool') !== null;
    return false;
  }
}

function loadDetector() {
  const context = vm.createContext({
    globalThis: null,
    document: {},
    String,
    Array,
    Set,
    Math
  });
  context.globalThis = context;
  context.ChatGPTNotifierStatusCode = {
    isStatusCode(value) {
      return ['PLANNING_ACTIVE', 'COMPLETE_APPLIED', 'COMPLETE_NO_CHANGES', 'BLOCKED_HUMAN', 'INCOMPLETE_LIMIT', 'INCOMPLETE_TOOL_FAILURE', 'INCOMPLETE_HANDOFF'].includes(String(value || ''));
    }
  };
  vm.runInContext(helperSource, context);
  return context.ChatGPTNotifierRenderedTerminalStatus;
}

test('live terminal parser recovers a segmented footer even when parent innerText loses the line break', () => {
  const detector = loadDetector();
  const body = new FakeNode('p', 'Finished successfully.');
  const footer = new FakeNode('div', '', [
    new FakeNode('span', '[GITHUB_STATUS: '),
    new FakeNode('span', 'COMPLETE_APPLIED]')
  ]);
  const assistant = new FakeNode('div', '', [body, footer], { 'data-turn': 'assistant' });
  assistant.innerText = 'Finished successfully.[GITHUB_STATUS: COMPLETE_APPLIED]';

  assert.equal(detector.detect(assistant), 'COMPLETE_APPLIED');
});

test('terminal parser follows a semantic assistant marker to its same-turn wrapper footer', () => {
  const detector = loadDetector();
  assert.equal(detector.version, 4);

  const semanticAssistant = new FakeNode('div', 'Finished successfully.', [], { 'data-turn': 'assistant' });
  const footer = new FakeNode('p', '[GITHUB_STATUS: COMPLETE_APPLIED]');
  const action = new FakeNode('button', 'Copy');
  const wrapper = new FakeNode('article', '', [semanticAssistant, footer, action]);
  wrapper.innerText = 'Finished successfully.\n[GITHUB_STATUS: COMPLETE_APPLIED]\nCopy';

  assert.equal(detector.detect(semanticAssistant), 'COMPLETE_APPLIED');

  const neighboringUser = new FakeNode('div', 'New request', [], { 'data-turn': 'user' });
  const outer = new FakeNode('section', '', [wrapper, neighboringUser]);
  outer.innerText = 'Finished successfully.\n[GITHUB_STATUS: COMPLETE_APPLIED]\nCopy\nNew request';
  assert.equal(detector.detect(semanticAssistant), 'COMPLETE_APPLIED');
});

test('terminal parser crosses deep same-turn wrapper nesting until the first foreign turn boundary', () => {
  const detector = loadDetector();
  const semanticAssistant = new FakeNode('div', 'Finished successfully.', [], { 'data-turn': 'assistant' });
  let nested = new FakeNode('article', '', [semanticAssistant]);
  for (let depth = 0; depth < 6; depth += 1) nested = new FakeNode('div', '', [nested]);

  const footer = new FakeNode('p', '[GITHUB_STATUS: COMPLETE_APPLIED]');
  const sameTurnOuter = new FakeNode('section', '', [nested, footer]);
  sameTurnOuter.innerText = 'Finished successfully.\n[GITHUB_STATUS: COMPLETE_APPLIED]';

  assert.equal(detector.detect(semanticAssistant), 'COMPLETE_APPLIED');

  const neighboringUser = new FakeNode('div', 'New request', [], { 'data-turn': 'user' });
  const conversationRoot = new FakeNode('main', '', [sameTurnOuter, neighboringUser]);
  conversationRoot.innerText = 'Finished successfully.\n[GITHUB_STATUS: COMPLETE_APPLIED]\nNew request';
  assert.equal(detector.detect(semanticAssistant), 'COMPLETE_APPLIED');
});

test('terminal parser allows the preceding prompt inside the same response group but stops before a following prompt', () => {
  const detector = loadDetector();
  const prompt = new FakeNode('div', 'Please finish the task.', [], { 'data-turn': 'user' });
  const semanticAssistant = new FakeNode('div', 'Finished successfully.', [], { 'data-turn': 'assistant' });
  let nestedAssistant = new FakeNode('article', '', [semanticAssistant]);
  for (let depth = 0; depth < 4; depth += 1) nestedAssistant = new FakeNode('div', '', [nestedAssistant]);
  const footer = new FakeNode('p', '[GITHUB_STATUS: BLOCKED_HUMAN]');
  const action = new FakeNode('button', 'Copy');
  const responseGroup = new FakeNode('section', '', [prompt, nestedAssistant, footer, action]);
  responseGroup.innerText = 'Please finish the task.\nFinished successfully.\n[GITHUB_STATUS: BLOCKED_HUMAN]\nCopy';

  const nextPrompt = new FakeNode('div', 'Continue', [], { 'data-turn': 'user' });
  const conversationRoot = new FakeNode('main', '', [responseGroup, nextPrompt]);
  conversationRoot.innerText = `${responseGroup.innerText}\nContinue`;

  assert.equal(detector.detect(semanticAssistant), 'BLOCKED_HUMAN');
  const shape = detector.inspect(semanticAssistant);
  assert.ok(shape.rootCount >= 2);
  assert.ok(shape.precedingUserCount >= 1);
  assert.ok(shape.followingUserCount >= 1);
  assert.equal(shape.boundaryReason, 'following-user');
});

test('live terminal parser rejects quoted/code examples and non-terminal standalone status paragraphs', () => {
  const detector = loadDetector();
  const codeExample = new FakeNode('pre', '', [new FakeNode('code', '[GITHUB_STATUS: COMPLETE_APPLIED]')]);
  const finalText = new FakeNode('p', 'That is only an example.');
  const assistantWithCode = new FakeNode('div', '', [codeExample, finalText], { 'data-turn': 'assistant' });
  assistantWithCode.innerText = '[GITHUB_STATUS: COMPLETE_APPLIED]\nThat is only an example.';
  assert.equal(detector.detect(assistantWithCode), '');

  const status = new FakeNode('p', '[GITHUB_STATUS: COMPLETE_APPLIED]');
  const after = new FakeNode('p', 'More response text after the marker.');
  const nonTerminal = new FakeNode('div', '', [status, after], { 'data-turn': 'assistant' });
  nonTerminal.innerText = '[GITHUB_STATUS: COMPLETE_APPLIED]\nMore response text after the marker.';
  assert.equal(detector.detect(nonTerminal), '');
});

test('rendered terminal authority is hot-bound and feeds both watchdog parking and the Simple status bridge', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  const version = read('VERSION.txt').trim();
  const observer = read('extension/terminal-status-live-observer.js');
  const authority = read('extension/terminal-watchdog-authority-background.js');
  const hotRecovery = read('extension/terminal-stop-post-update-recovery-background.js');
  const rebind = read('extension/page-runtime-rebind.js');
  const streamBridge = read('extension/response-stream-status-bridge.js');

  assert.equal(manifest.version, version);
  assert.ok(manifest.content_scripts[0].js.includes('rendered-terminal-status.js'));
  assert.ok(manifest.content_scripts[0].js.includes('terminal-status-live-observer.js'));
  assert.ok(manifest.content_scripts[0].js.indexOf('rendered-terminal-status.js') < manifest.content_scripts[0].js.indexOf('terminal-status-live-observer.js'));

  assert.match(observer, /RUNTIME_VERSION = 5/);
  assert.match(observer, /CHATGPT_RENDERED_TERMINAL_STATUS/);
  assert.match(observer, /CHATGPT_RENDERED_TERMINAL_IDENTITY_QUERY/);
  assert.match(observer, /CHATGPT_RENDERED_TERMINAL_SCAN_DIAGNOSTIC/);
  assert.match(observer, /chatgpt-notifier-terminal-status-v1/);
  assert.match(observer, /chatgpt-notifier-terminal-status-query-v1/);
  assert.match(observer, /chatgpt-notifier-terminal-status-response-v1/);
  assert.match(observer, /terminalStatusClass/);
  assert.match(observer, /getWatchdogSettings/);
  assert.match(observer, /window\.postMessage/);
  assert.match(observer, /MutationObserver/);
  assert.match(observer, /RETRY_DELAYS_MS = Object\.freeze\(\[0, 250, 1000, 3000\]\)/);
  assert.match(observer, /result\?\.ok === true && result\?\.stopped === true/);
  assert.doesNotMatch(observer, /\bfetch\s*\(|XMLHttpRequest|WebSocket/);

  assert.match(authority, /RUNTIME_VERSION = 3/);
  assert.match(authority, /handleRenderedTerminal/);
  assert.match(authority, /parkDefinitiveStatus/);
  assert.match(authority, /queueRenderedNotification/);
  assert.match(authority, /state\.claimTurn\(snapshot, owner\)/);
  assert.match(authority, /queueDurableNotification\(deliveryRecord/);
  assert.match(authority, /rendered-terminal-authority/);
  assert.match(authority, /return \{ ok: stopped, stopped, notified, statusCode \}/);
  assert.match(authority, /result\?\.reason === 'terminal-prompt-superseded'/);
  assert.match(authority, /currentWatchdogPromptForSettledRenderedStatus/);
  assert.match(authority, /String\(snapshot\.requestPhase \|\| ''\) !== 'completed'/);
  assert.match(authority, /renderedIdentityMatches\(snapshot, pageIdentity, target\.id\)/);
  assert.match(authority, /watchdog\.lastRequestStartedAt/);

  assert.match(hotRecovery, /RUNTIME_VERSION = 3/);
  assert.match(hotRecovery, /'rendered-terminal-status\.js'/);
  assert.match(hotRecovery, /'terminal-status-live-observer\.js'/);
  assert.match(hotRecovery, /CHATGPT_RENDERED_TERMINAL_OBSERVER_PING/);
  assert.match(rebind, /__chatgptNotifierRenderedTerminalObserver/);
  assert.match(rebind, /__chatgptNotifierStreamStatusBridge/);
  assert.match(streamBridge, /RUNTIME_VERSION = 2/);
  assert.match(streamBridge, /removeEventListener\('message', onMessage\)/);
});
