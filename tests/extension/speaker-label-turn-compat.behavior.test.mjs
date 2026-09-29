import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('extension/page-dom-compat.js', root), 'utf8');

test('turn compatibility uses only exact hidden speaker labels as the attribute-free fallback', () => {
  assert.match(source, /const RUNTIME_VERSION = 3/);
  assert.match(source, /'h4\.sr-only'/);
  assert.match(source, /text === 'you said:'/);
  assert.match(source, /text === 'chatgpt said:'/);
  assert.match(source, /const speakerRoles = new WeakMap\(\)/);
  assert.match(source, /speakerRoles\.set\(turn, role\)/);
  assert.match(source, /if \(legacy\.length \|\| roles\.length\) return semanticTurns\(legacy, roles\)/);
  assert.match(source, /return speakerLabelTurns\(root\)/);
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
