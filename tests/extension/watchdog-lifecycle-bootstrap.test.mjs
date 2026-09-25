import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const bootstrap = readFileSync(new URL('extension/diagnostics-bootstrap.js', root), 'utf8');

test('watchdog request lifecycle fix is loaded immediately after the canonical background', () => {
  const backgroundAt = bootstrap.indexOf("importScripts('background.js')");
  const fixAt = bootstrap.indexOf("importScripts('watchdog-request-lifecycle-fix-background.js')");
  assert.ok(backgroundAt >= 0 && fixAt > backgroundAt);
});
