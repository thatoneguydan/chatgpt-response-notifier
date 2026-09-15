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
