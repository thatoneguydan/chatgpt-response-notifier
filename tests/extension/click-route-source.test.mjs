import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import './current-request-error.behavior.test.mjs';
import './v0914-safety-regression.test.mjs';
import './version-sync.test.mjs';

const readText = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

test('production click route contains no outgoing native foreground request', () => {
  const worker = readText('extension/service-worker.js');
  const background = readText('extension/background.js');
  const safety = readText('extension/v0914-safety-background.js');

  assert.doesNotMatch(worker, /type\s*:\s*['"]window\.foreground['"]/);
  assert.doesNotMatch(worker, /function\s+requestNativeChromeForeground\s*\(/);
  assert.match(worker, /chrome\.tabs\.update\(/);
  assert.match(worker, /chrome\.windows\.update\(/);
  assert.match(worker, /emitClickDiagnostic\(['"]worker-click-received['"]/);
  assert.match(worker, /emitClickDiagnostic\(['"]click-navigation-complete['"]/);

  assert.match(background, /Retired native foreground path is present in production runtime/);
  assert.match(safety, /typeof globalThis\.requestNativeChromeForeground !== ['"]function['"]/);
});

test('toast click routing is bounded, exact-targeted, and never silently duplicates an existing chat', () => {
  const worker = readText('extension/service-worker.js');
  const click = readText('extension/cross-desktop-click-fallback-background.js');
  const manager = readText('src/ChatGPTResponseNotifier.Host/ToastManager.cs');
  const window = readText('src/ChatGPTResponseNotifier.Host/ToastWindow.cs');
  const app = readText('src/ChatGPTResponseNotifier.Host/NativeHostApplication.cs');
  const record = readText('src/ChatGPTResponseNotifier.Core/NotificationRecord.cs');

  assert.match(worker, /targetTabId: Number\.isInteger\(record\.ownerTabId\)/);
  assert.match(worker, /resolveClickTarget\(conversationId, preferredTabId/);
  assert.match(worker, /ambiguous-conversation-target/);
  assert.match(worker, /activeToastClicks/);
  assert.match(worker, /click-duplicate-suppressed/);
  assert.match(worker, /type: 'toast\.clickResult'/);
  assert.match(worker, /message\.type === 'toast\.moveHere'/);

  assert.match(click, /PROBE_TIMEOUT_MS = 300/);
  assert.match(click, /CLICK_DEADLINE_MS = 3500/);
  assert.match(click, /Promise\.resolve\(promise\)/);
  assert.match(click, /state: 'other-desktop'/);
  assert.match(click, /chrome\.windows\.create\(\{ tabId: targetTabId, focused: true, type: 'normal' \}\)/);
  assert.doesNotMatch(click, /windows\.create\(\{\s*url:/);

  const clicked = manager.slice(manager.indexOf('window.ToastClicked'), manager.indexOf('window.ToastMoveHereRequested'));
  assert.doesNotMatch(clicked, /RemoveWindow/);
  assert.match(clicked, /targetTabId = record\.TargetTabId/);
  assert.match(manager, /ReportClickResult/);
  assert.match(window, /Content = "Move tab here"/);
  assert.match(window, /ToastMoveHereRequested/);
  assert.match(record, /TargetTabId/);

  assert.match(app, /case "toast\.clickResult"/);
  assert.doesNotMatch(app, /click-shell-fallback/);
  assert.doesNotMatch(app, /Process\.Start\(new ProcessStartInfo\(uri\.AbsoluteUri/);
});

test('status verification preserves prompt revision identity across monitor fallback', () => {
  const statusScript = readText('extension/status-script.js');
  const worker = readText('extension/service-worker.js');

  assert.match(statusScript, /const userText = turnText\(nodes\[userIndex\], ['"]user['"]\);/);
  assert.match(statusScript, /promptRevision:\s*revisionOf\(userText\)/);
  assert.match(statusScript, /promptRevision:\s*snapshot\?\.promptRevision \|\| ['"]['"]/);
  assert.match(worker, /promptRevision:\s*status\.promptRevision/);
});

test('all coded continuation routes use the shared continuation predicate', () => {
  const worker = readText('extension/service-worker.js');
  const observer = readText('extension/normal-continuation-budget-hook.js');

  assert.match(worker, /ChatGPTNotifierContinuationPolicy\?\.isAutoContinueStatusCode\?\.\(statusCode\) === true/);
  assert.match(observer, /ChatGPTNotifierContinuationPolicy\?\.isAutoContinueStatusCode\?\.\(String\(status\.statusCode \|\| ['"]['"]\)\) === true/);
  assert.doesNotMatch(worker, /statusCode\s*!==\s*['"]INCOMPLETE_LIMIT['"]/);
  assert.doesNotMatch(observer, /String\(status\.statusCode \|\| ['"]['"]\)\s*!==\s*['"]INCOMPLETE_LIMIT['"]/);
});
