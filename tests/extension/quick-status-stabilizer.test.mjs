import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('extension/manifest.json', root), 'utf8'));
const owner = readFileSync(new URL('extension/quick-continue-status-owner-v6.js', root), 'utf8');

test('one document-start runtime owns the timer surface without a hiding stabilizer', () => {
  const entry = manifest.content_scripts.find((candidate) => candidate.js?.includes('quick-continue-status-owner-v6.js'));
  assert.equal(entry?.run_at, 'document_start');
  assert.deepEqual(entry.js, ['quick-continue-status-owner-v6.js']);
  assert.ok(!manifest.content_scripts.some((candidate) => candidate.js?.includes('quick-continue-status-stabilizer.js')));
  assert.match(owner, /removeLegacyStatusNodes/);
  assert.doesNotMatch(owner, /MutationObserver/);
});
