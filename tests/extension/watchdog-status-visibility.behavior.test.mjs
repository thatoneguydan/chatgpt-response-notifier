import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const owner = readFileSync(new URL('extension/quick-continue-status-owner-v6.js', root), 'utf8');

test('terminal-status watchdogs disappear from the timer surface', () => {
  assert.match(owner, /stopReason\.startsWith\('status:'\)/);
  assert.match(owner, /if \(!watchdog\) return \{ text: ''/);
  assert.match(owner, /if \(stopReason\.startsWith\('status:'\)\) return \{ text: ''/);
});
