import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const statusSource = readFileSync(new URL('extension/status-script.js', root), 'utf8');
const monitorSource = readFileSync(new URL('extension/monitor-script.js', root), 'utf8');

class FakeNode {
  constructor(attributes = {}, text = '', children = []) {
    this.attributes = { ...attributes };
    this.innerText = text;
    this.textContent = text;
    this.children = children;
    this.id = attributes.id || '';
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  matches(selector) {
    return String(selector || '').split(',').some((part) => this.#matchesOne(part.trim()));
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  querySelectorAll(selector) {
    if (selector === '.markdown' || selector === '[class*="prose"]') return [];
    const matches = [];
    for (const child of this.children) {
      if (child.matches(selector)) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  #matchesOne(selector) {
    const match = selector.match(/^\[([^=]+)="([^"]+)"\]$/);
    return Boolean(match && String(this.getAttribute(match[1]) || '') === match[2]);
  }
}

function loadTurnHelpers(source, endMarker, normalizerName) {
  const start = source.indexOf('function roleOf');
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'turn helper block must exist');

  const context = vm.createContext({ Array, Set, String, globalThis: null });
  context.globalThis = context;
  const normalizer = normalizerName === 'inline'
    ? "const inline = (value) => String(value || '').replace(/\\s+/g, ' ').trim();"
    : "const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();";
  vm.runInContext(
    `${normalizer}\n${source.slice(start, end)}\nglobalThis.__helpers = { roleOf, turnId, roleRoot, turnText };`,
    context
  );
  return context.__helpers;
}

for (const [name, source, endMarker, normalizerName, expectedVersion] of [
  ['status', statusSource, 'function terminalStatusCodeFromRenderedText', 'inline', 17],
  ['monitor', monitorSource, 'function assistantHasStatusEvidence', 'normalize', 13]
]) {
  test(`${name} runtime reads current data-turn semantic nodes as real conversation turns`, () => {
    const helpers = loadTurnHelpers(source, endMarker, normalizerName);
    const assistant = new FakeNode(
      { 'data-turn': 'assistant', 'data-message-id': 'assistant-semantic-1' },
      'Finished.\n[GITHUB_STATUS: COMPLETE_APPLIED]'
    );
    const user = new FakeNode(
      { 'data-turn': 'user', 'data-turn-id': 'user-semantic-1' },
      'Please continue.'
    );

    assert.equal(helpers.roleOf(assistant), 'assistant');
    assert.equal(helpers.roleRoot(assistant, 'assistant'), assistant);
    assert.equal(helpers.turnId(assistant, 'assistant', 4), 'assistant-semantic-1');
    assert.equal(helpers.turnText(assistant, 'assistant'), 'Finished.\n[GITHUB_STATUS: COMPLETE_APPLIED]');

    assert.equal(helpers.roleOf(user), 'user');
    assert.equal(helpers.roleRoot(user, 'user'), user);
    assert.equal(helpers.turnId(user, 'user', 3), 'user-semantic-1');
    assert.equal(helpers.turnText(user, 'user'), 'Please continue.');

    assert.match(source, new RegExp(`const RUNTIME_VERSION = ${expectedVersion}`));
  });

  test(`${name} runtime keeps legacy role nodes and nested semantic role nodes compatible`, () => {
    const helpers = loadTurnHelpers(source, endMarker, normalizerName);
    const legacy = new FakeNode(
      { 'data-message-author-role': 'assistant', 'data-testid': 'conversation-turn-legacy' },
      'Legacy response.'
    );
    const semanticChild = new FakeNode(
      { 'data-turn': 'assistant', 'data-message-id': 'assistant-nested' },
      'Nested semantic response.'
    );
    const wrapper = new FakeNode({ 'data-testid': 'conversation-turn-wrapper' }, '', [semanticChild]);

    assert.equal(helpers.roleRoot(legacy, 'assistant'), legacy);
    assert.equal(helpers.turnText(legacy, 'assistant'), 'Legacy response.');
    assert.equal(helpers.roleOf(wrapper), 'assistant');
    assert.equal(helpers.roleRoot(wrapper, 'assistant'), semanticChild);
    assert.equal(helpers.turnText(wrapper, 'assistant'), 'Nested semantic response.');
  });
}
