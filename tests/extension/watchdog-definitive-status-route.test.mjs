import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const bridge = readFileSync(new URL('extension/quick-continue-monitor-bridge.js', root), 'utf8');
const lifecycle = readFileSync(new URL('extension/watchdog-request-lifecycle-fix-background.js', root), 'utf8');

test('rendered definitive status has an explicit page-to-worker watchdog stop route', () => {
  assert.match(bridge, /PARK_CODE_WATCHDOG_FOR_TERMINAL_STATUS_FOR_SENDER/);
  assert.match(lifecycle, /PARK_CODE_WATCHDOG_FOR_TERMINAL_STATUS_FOR_SENDER/);
  assert.match(lifecycle, /isDefinitiveStopStatusCode/);
  assert.match(lifecycle, /parkCodeWatchdogForTerminalStatus/);
});
