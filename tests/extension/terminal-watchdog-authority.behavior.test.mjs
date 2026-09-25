import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');
const source = readText('extension/terminal-watchdog-authority-background.js');
const bootstrap = readText('extension/diagnostics-bootstrap.js');

test('definitive stream status authority loads after watchdog lifecycle and before quick UI bridge', () => {
  const lifecycleAt = bootstrap.indexOf("importScripts('watchdog-request-lifecycle-fix-background.js')");
  const authorityAt = bootstrap.indexOf("importScripts('terminal-watchdog-authority-background.js')");
  const bridgeAt = bootstrap.indexOf("importScripts('quick-continue-monitor-bridge-background.js')");
  assert.ok(lifecycleAt >= 0 && authorityAt > lifecycleAt && bridgeAt > authorityAt);
  assert.doesNotThrow(() => new vm.Script(source));
});

test('COMPLETE and BLOCKED stream statuses stop the watchdog and reset its attempts', () => {
  assert.match(source, /CHATGPT_RESPONSE_STREAM_TERMINAL_STATUS/);
  assert.match(source, /policy\?\.isDefinitiveStopStatusCode\?\.\(statusCode\) === true/);
  assert.match(source, /lifecycle\.parkTerminalStatusForSender/);
  assert.match(source, /sendCount:\s*0/);
  assert.match(source, /lastAutomaticSentAt:\s*0/);
  assert.match(source, /lastAutomaticPromptKey:\s*''/);
  assert.match(source, /lastAutomaticParentPromptKey:\s*''/);
  assert.match(source, /deadlineAt:\s*0/);
  assert.match(source, /retryAt:\s*0/);
  assert.match(source, /publishOverview\(target\)/);
});

test('terminal authority accepts only canonical definitive stop codes', () => {
  assert.match(source, /parser\?\.isStatusCode\?\.\(statusCode\) === true/);
  assert.match(source, /policy\?\.isDefinitiveStopStatusCode\?\.\(statusCode\) === true/);
  assert.doesNotMatch(source, /isAutoContinueStatusCode\?\.\(statusCode\) === true/);
});
