import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('extension/manifest.json', root), 'utf8'));
const stabilizer = readFileSync(new URL('extension/quick-continue-status-stabilizer.js', root), 'utf8');

test('status stabilizer runs in its own document-start content script', () => {
  const entry = manifest.content_scripts.find((candidate) => Array.isArray(candidate.js) && candidate.js.includes('quick-continue-status-stabilizer.js'));
  assert.ok(entry);
  assert.equal(entry.run_at, 'document_start');
  assert.deepEqual(entry.js, ['quick-continue-status-stabilizer.js']);
  assert.match(stabilizer, /chatgpt-notifier-countdown-v/);
  assert.match(stabilizer, /data-chatgpt-notifier-last-status/);
  assert.match(stabilizer, /display:\s*none !important/);
});
