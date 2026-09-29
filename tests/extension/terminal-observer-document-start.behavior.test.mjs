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
