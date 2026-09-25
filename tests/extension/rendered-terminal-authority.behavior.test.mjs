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
    Set
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

test('rendered terminal authority is hot-bound and feeds both watchdog parking and durable notification delivery', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  const observer = read('extension/terminal-status-live-observer.js');
  const authority = read('extension/terminal-watchdog-authority-background.js');
  const hotRecovery = read('extension/terminal-stop-post-update-recovery-background.js');
  const rebind = read('extension/page-runtime-rebind.js');
  const streamBridge = read('extension/response-stream-status-bridge.js');

  assert.equal(manifest.version, '0.9.87');
  assert.ok(manifest.content_scripts[0].js.includes('rendered-terminal-status.js'));
  assert.ok(manifest.content_scripts[0].js.includes('terminal-status-live-observer.js'));
  assert.ok(manifest.content_scripts[0].js.indexOf('rendered-terminal-status.js') < manifest.content_scripts[0].js.indexOf('terminal-status-live-observer.js'));

  assert.match(observer, /CHATGPT_RENDERED_TERMINAL_STATUS/);
  assert.match(observer, /CHATGPT_RENDERED_TERMINAL_IDENTITY_QUERY/);
  assert.match(observer, /MutationObserver/);
  assert.match(observer, /RETRY_DELAYS_MS = Object\.freeze\(\[0, 250, 1000, 3000\]\)/);
  assert.doesNotMatch(observer, /\bfetch\s*\(|XMLHttpRequest|WebSocket/);

  assert.match(authority, /RUNTIME_VERSION = 2/);
  assert.match(authority, /handleRenderedTerminal/);
  assert.match(authority, /parkDefinitiveStatus/);
  assert.match(authority, /queueRenderedNotification/);
  assert.match(authority, /state\.claimTurn\(snapshot, owner\)/);
  assert.match(authority, /queueDurableNotification\(deliveryRecord/);
  assert.match(authority, /rendered-terminal-authority/);

  assert.match(hotRecovery, /RUNTIME_VERSION = 3/);
  assert.match(hotRecovery, /'rendered-terminal-status\.js'/);
  assert.match(hotRecovery, /'terminal-status-live-observer\.js'/);
  assert.match(hotRecovery, /CHATGPT_RENDERED_TERMINAL_OBSERVER_PING/);
  assert.match(rebind, /__chatgptNotifierRenderedTerminalObserver/);
  assert.match(rebind, /__chatgptNotifierStreamStatusBridge/);
  assert.match(streamBridge, /RUNTIME_VERSION = 2/);
  assert.match(streamBridge, /removeEventListener\('message', onMessage\)/);
});
