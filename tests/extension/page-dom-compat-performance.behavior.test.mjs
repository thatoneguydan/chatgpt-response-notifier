import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('extension/page-dom-compat.js', root), 'utf8');

test('page DOM compatibility keeps screen-reader turn recovery off the normal hot path', () => {
  assert.match(source, /const RUNTIME_VERSION = 3;/);
  assert.match(source, /const SPEAKER_CACHE_MS = 500;/);
  assert.match(source, /const speakerTurnCache = new WeakMap\(\);/);
  assert.match(
    source,
    /if \(legacy\.length \|\| roles\.length\) return semanticTurns\(legacy, roles\);\s*return speakerLabelTurns\(root\);/s
  );
});

test('speaker-label fallback caches scans and never recursively rescans from identity shims', () => {
  assert.match(source, /now - cached\.observedAt < SPEAKER_CACHE_MS/);
  assert.match(source, /speakerTurnCache\.set\(root, \{ observedAt: now, turns: ordered \}\);/);
  assert.match(source, /const syntheticTurnIds = new WeakMap\(\);/);
  assert.match(source, /return syntheticTurnId\(this, role\);/);
  assert.doesNotMatch(source, /speakerLabelTurns\(document\)/);
  assert.doesNotMatch(source, /compatibleTurns\(document\)/);
});
