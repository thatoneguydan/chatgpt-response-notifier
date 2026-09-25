import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const lifecycle = readFileSync(new URL('extension/watchdog-request-lifecycle-fix-background.js', root), 'utf8');

test('manual Monitor enable is converted to waiting-for-request state', () => {
  assert.match(lifecycle, /SET_BUILD_AUTOMATION_STATE_FOR_SENDER/);
  assert.match(lifecycle, /manualActivatedAt/);
  assert.match(lifecycle, /waitingForRequestStart:\s*true/);
  assert.match(lifecycle, /deadlineAt:\s*0/);
  assert.match(lifecycle, /chrome\.webRequest\.onBeforeRequest\.addListener/);
});
