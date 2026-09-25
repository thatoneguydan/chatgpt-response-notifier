import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const fallback = readFileSync(new URL('extension/quick-continue-status-fallback.js', root), 'utf8');

test('terminal-status watchdogs disappear from the timer surface', () => {
  assert.match(fallback, /stopReason\.startsWith\('status:'\)/);
  assert.match(fallback, /if \(!watchdog\) return ''/);
  assert.match(fallback, /if \(stopReason\.startsWith\('status:'\)\) return ''/);
});
