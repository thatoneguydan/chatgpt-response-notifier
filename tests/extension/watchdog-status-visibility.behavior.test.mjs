import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const owner = readFileSync(new URL('extension/quick-continue-status-owner-v6.js', root), 'utf8');

test('retired notifier watchdog timer surfaces are removed instead of rendered', () => {
  assert.match(owner, /removeLegacyWatchdogUi/);
  assert.match(owner, /data-chatgpt-notifier-watchdog-status-owner/);
  assert.match(owner, /chatgpt-notifier-countdown-v/);
  assert.match(owner, /chatgpt-notifier-countdown-fallback-v/);
  assert.match(owner, /node\.remove\(\)/);
  assert.doesNotMatch(owner, /Next auto-continue|Sending auto-continue|Auto-continue blocked/);
});
