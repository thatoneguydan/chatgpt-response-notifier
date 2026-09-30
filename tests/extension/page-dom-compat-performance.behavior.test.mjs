import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('extension/page-dom-compat.js', root), 'utf8');

test('page DOM compatibility keeps speaker-label recovery conditional and cached', () => {
  assert.match(source, /const RUNTIME_VERSION = 4;/);
  assert.match(source, /const SPEAKER_CACHE_MS = 500;/);
  assert.match(source, /const speakerTurnCache = new WeakMap\(\);/);
  assert.match(source, /function hydrateLegacyTurnRoles\(root, legacy\)/);
  assert.match(source, /if \(!legacy\.some\(\(turn\) => !semanticRole\(turn\)\)\) return;/);
  assert.match(source, /speakerLabelTurns\(root\);/);
  assert.match(source, /hydrateLegacyTurnRoles\(root, legacy\);/);
});

test('speaker-label fallback caches scans and never recursively rescans from identity shims', () => {
  assert.match(source, /now - cached\.observedAt < SPEAKER_CACHE_MS/);
  assert.match(source, /speakerTurnCache\.set\(root, \{ observedAt: now, turns: ordered \}\);/);
  assert.match(source, /const syntheticTurnIds = new WeakMap\(\);/);
  assert.match(source, /return syntheticTurnId\(this, role\);/);
  assert.doesNotMatch(source, /speakerLabelTurns\(document\)/);
  assert.doesNotMatch(source, /compatibleTurns\(document\)/);
});

test('semantic boundary compatibility reuses hydrated legacy turns without broad text scans', () => {
  assert.match(source, /function compatibleRoleNodes\(root\)/);
  assert.match(source, /return semanticTurns\(legacy, roles\)\.filter\(\(node\) => semanticRole\(node\)\)/);
  assert.match(source, /if \(isSemanticRoleSelector\(value\)\) return compatibleRoleNodes\(this\)/);
  assert.doesNotMatch(source, /document\.body\.innerText|querySelectorAll\(['"]\*['"]\)|TreeWalker/);
});
