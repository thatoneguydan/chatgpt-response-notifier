import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('extension/terminal-status-live-observer.js', root), 'utf8');

test('rendered terminal observer attaches to Document at document_start instead of requiring documentElement', () => {
  assert.match(
    source,
    /observer\.observe\(document, \{ childList: true, subtree: true, characterData: true \}\)/
  );
  assert.doesNotMatch(source, /observer\.observe\(document\.documentElement/);
});

test('rendered terminal observer reports bounded identity-missing diagnostics instead of failing silently', () => {
  assert.match(source, /boundaryReason: 'identity-missing'/);
  assert.match(source, /if \(!currentIdentity\) \{\s*scheduleNoStatusDiagnostic\(\);\s*return;\s*\}/s);
  assert.match(source, /CHATGPT_RENDERED_TERMINAL_SCAN_DIAGNOSTIC/);
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|new WebSocket/);
});

test('rendered terminal observer coalesces mutation storms instead of rescanning every 40ms', () => {
  assert.match(source, /const RUNTIME_VERSION = 4;/);
  assert.match(source, /const SCAN_DEBOUNCE_MS = 250;/);
  assert.match(source, /const MAX_SCAN_INTERVAL_MS = 1500;/);
  assert.match(source, /let maxScanTimer = null;/);
  assert.match(source, /scanTimer = setTimeout\(runScheduledScan, SCAN_DEBOUNCE_MS\);/);
  assert.match(source, /maxScanTimer = setTimeout\(runScheduledScan, MAX_SCAN_INTERVAL_MS\);/);
  assert.match(source, /function clearScanTimers\(\)/);
  assert.match(source, /clearScanTimers\(\);\s*clearRetryTimers\(\);/s);
  assert.doesNotMatch(source, /setTimeout\(scan, 40\)/);
});
