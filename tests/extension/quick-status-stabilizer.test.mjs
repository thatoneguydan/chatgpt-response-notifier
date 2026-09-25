import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('extension/manifest.json', root), 'utf8'));
const stabilizer = readFileSync(new URL('extension/quick-continue-status-stabilizer.js', root), 'utf8');

test('status stabilizer runs at document start before notifier UI mounts', () => {
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.ok(manifest.content_scripts[0].js.includes('quick-continue-status-stabilizer.js'));
  assert.match(stabilizer, /chatgpt-notifier-countdown-v/);
  assert.match(stabilizer, /data-chatgpt-notifier-last-status/);
  assert.match(stabilizer, /display:\s*none !important/);
});
