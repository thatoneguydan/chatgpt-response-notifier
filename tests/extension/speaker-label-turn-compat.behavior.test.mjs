import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('extension/page-dom-compat.js', root), 'utf8');

test('turn compatibility uses only exact hidden speaker labels as the attribute-free fallback', () => {
  assert.match(source, /const RUNTIME_VERSION = 2/);
  assert.match(source, /'h4\.sr-only'/);
  assert.match(source, /text === 'you said:'/);
  assert.match(source, /text === 'chatgpt said:'/);
  assert.match(source, /const speakerRoles = new WeakMap\(\)/);
  assert.match(source, /const speakerTurns = speakerLabelTurns\(root\)/);
  assert.match(source, /speakerRoles\.set\(turn, role\)/);
  assert.match(source, /\[data-testid\^="conversation-turn-"\]/);

  // Do not broaden this recovery path into arbitrary visible-text scanning.
  assert.doesNotMatch(source, /querySelectorAll\(['"]\*['"]\)/);
  assert.doesNotMatch(source, /document\.body\.innerText/);
  assert.doesNotMatch(source, /TreeWalker/);
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|new WebSocket/);
});

test('speaker-label turns expose legacy-compatible role and turn identity to existing readers', () => {
  assert.match(source, /normalizedName === 'data-turn'/);
  assert.match(source, /normalizedName === 'data-message-author-role'/);
  assert.match(source, /return `conversation-turn-compat-\$\{role\}-\$\{index\}`/);
  assert.match(source, /if \(value === LEGACY_TURN_SELECTOR\) return compatibleTurns\(this\)/);
});
