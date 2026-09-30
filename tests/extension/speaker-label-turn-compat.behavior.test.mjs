import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('extension/page-dom-compat.js', root), 'utf8');
const LEGACY_TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
const ROLE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"], [data-turn="user"], [data-turn="assistant"]';

class FakeElement {
  constructor(tag = 'div', attributes = {}, text = '', children = []) {
    this.tagName = String(tag).toUpperCase();
    this.attributes = { ...attributes };
    this._text = String(text || '');
    this.children = children;
    this.parentElement = null;
    this.isConnected = true;
    this.hidden = false;
    this.disabled = false;
    this.isContentEditable = false;
    for (const child of children) child.parentElement = this;
  }

  get textContent() {
    return `${this._text}${this.children.map((child) => child.textContent).join('')}`;
  }

  get innerText() {
    return this.textContent;
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

  compareDocumentPosition() {
    return 0;
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

  #matchesOne(selector) {
    if (!selector) return false;
    const classMatch = selector.match(/^([a-z0-9]+)\.([A-Za-z0-9_-]+)$/i);
    if (classMatch) {
      const classes = String(this.attributes.class || '').split(/\s+/).filter(Boolean);
      return this.tagName === classMatch[1].toUpperCase() && classes.includes(classMatch[2]);
    }
    const prefixAttr = selector.match(/^\[([^\]^=]+)\^="([^"]+)"\]$/);
    if (prefixAttr) return String(this.attributes[prefixAttr[1]] || '').startsWith(prefixAttr[2]);
    const exactAttr = selector.match(/^\[([^=\]]+)="([^"]+)"\]$/);
    if (exactAttr) return String(this.attributes[exactAttr[1]] || '') === exactAttr[2];
    const presentAttr = selector.match(/^\[([^\]]+)\]$/);
    if (presentAttr) return Object.hasOwn(this.attributes, presentAttr[1]);
    return /^[a-z0-9]+$/i.test(selector) && this.tagName === selector.toUpperCase();
  }
}

class FakeDocument {
  constructor(children = []) {
    this.children = children;
    for (const child of children) child.parentElement = null;
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
}

test('turn compatibility hydrates unlabeled legacy wrappers from exact hidden speaker labels', () => {
  const userTurn = new FakeElement('div', { 'data-testid': 'conversation-turn-user-live' }, '', [
    new FakeElement('h5', { class: 'sr-only' }, 'You said:'),
    new FakeElement('p', {}, 'Please continue.')
  ]);
  const assistantTurn = new FakeElement('div', { 'data-testid': 'conversation-turn-assistant-live' }, '', [
    new FakeElement('h6', { class: 'sr-only' }, 'ChatGPT said:'),
    new FakeElement('p', {}, 'Finished.')
  ]);
  const document = new FakeDocument([userTurn, assistantTurn]);
  const context = vm.createContext({
    globalThis: null,
    document,
    Document: FakeDocument,
    Element: FakeElement,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
    Date,
    Array,
    Set,
    WeakMap,
    String,
    Object
  });
  context.globalThis = context;
  vm.runInContext(source, context);

  const turns = document.querySelectorAll(LEGACY_TURN_SELECTOR);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].getAttribute('data-turn'), 'user');
  assert.equal(turns[1].getAttribute('data-turn'), 'assistant');
  assert.equal(turns[0].getAttribute('data-testid'), 'conversation-turn-user-live');
  assert.equal(turns[1].getAttribute('data-testid'), 'conversation-turn-assistant-live');

  const semanticRoles = document.querySelectorAll(ROLE_SELECTOR);
  assert.equal(semanticRoles.length, 2);
  assert.equal(semanticRoles[0].getAttribute('data-message-author-role'), 'user');
  assert.equal(semanticRoles[1].getAttribute('data-message-author-role'), 'assistant');
});

test('turn compatibility uses only exact hidden speaker labels for attribute-free role recovery', () => {
  assert.match(source, /const RUNTIME_VERSION = 6/);
  assert.match(source, /'h4\.sr-only'/);
  assert.match(source, /text === 'you said:'/);
  assert.match(source, /text === 'chatgpt said:'/);
  assert.match(source, /const speakerRoles = new WeakMap\(\)/);
  assert.match(source, /speakerRoles\.set\(turn, role\)/);
  assert.match(source, /function hydrateLegacyTurnRoles/);
  assert.match(source, /legacy\.some\(\(turn\) => !semanticRole\(turn\)\)/);
  assert.match(source, /speakerLabelTurns\(root\)/);
  assert.match(source, /function compatibleRoleNodes/);
  assert.match(source, /isSemanticRoleSelector\(value\)/);
  assert.match(source, /\[data-testid\^="conversation-turn-"\]/);

  // Do not broaden this recovery path into arbitrary visible-text scanning.
  assert.doesNotMatch(source, /querySelectorAll\(['"]\*['"]\)/);
  assert.doesNotMatch(source, /document\.body\.innerText/);
  assert.doesNotMatch(source, /TreeWalker/);
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|new WebSocket/);
});

test('speaker-label turns expose stable legacy-compatible role and turn identity to existing readers', () => {
  assert.match(source, /normalizedName === 'data-turn'/);
  assert.match(source, /normalizedName === 'data-message-author-role'/);
  assert.match(source, /const syntheticTurnIds = new WeakMap\(\)/);
  assert.match(source, /return syntheticTurnId\(this, role\)/);
  assert.match(source, /if \(value === LEGACY_TURN_SELECTOR\) return compatibleTurns\(this\)/);
});

test('speaker-label recovery is cached and does not rescan the document from identity shims', () => {
  assert.match(source, /const SPEAKER_CACHE_MS = 500/);
  assert.match(source, /const speakerTurnCache = new WeakMap\(\)/);
  assert.match(source, /now - cached\.observedAt < SPEAKER_CACHE_MS/);
  assert.doesNotMatch(source, /speakerLabelTurns\(document\)/);
  assert.doesNotMatch(source, /compatibleTurns\(document\)/);
});
