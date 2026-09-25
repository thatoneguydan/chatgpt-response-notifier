import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');

const source = readText('extension/watchdog-request-lifecycle-fix-background.js');
const bootstrap = readText('extension/diagnostics-bootstrap.js');

test('production loads request lifecycle correction after the canonical monitor owner', () => {
  const backgroundAt = bootstrap.indexOf("importScripts('background.js')");
  const lifecycleAt = bootstrap.indexOf("importScripts('watchdog-request-lifecycle-fix-background.js')");
  const quickBridgeAt = bootstrap.indexOf("importScripts('quick-continue-monitor-bridge-background.js')");
  assert.ok(backgroundAt >= 0 && lifecycleAt > backgroundAt && quickBridgeAt > lifecycleAt);
  assert.doesNotThrow(() => new vm.Script(source));
});

test('a real conversation POST is the timer start boundary', () => {
  assert.match(source, /chrome\.webRequest\.onBeforeRequest\.addListener/);
  assert.match(source, /requestStartsByTab\.set\(details\.tabId, record\)/);
  assert.match(source, /armRequestStartForTab\(details\.tabId, record\.requestId, requestStartedAt\)/);
  assert.match(source, /monitor\.reconcileCodeWatchdog\(\{/);
  assert.match(source, /requestStartedAt:\s*Math\.max\(0, Number\(requestStartedAt/);
  assert.match(source, /chrome\.tabs\.onUpdated\.addListener/);
  assert.match(source, /ROUTE_BIND_RETRIES/);
});

test('manual Monitor enable is deferred until a later request instead of creating a countdown', () => {
  assert.match(source, /SET_BUILD_AUTOMATION_STATE_FOR_SENDER/);
  assert.match(source, /message\?\.enabled === true/);
  assert.match(source, /message\?\.resumeExistingRun !== true/);
  assert.match(source, /manualActivatedAt/);
  assert.match(source, /waitingForRequestStart:\s*true/);
  assert.match(source, /resetAt:\s*toggledAt/);
  assert.match(source, /deadlineAt:\s*0/);
  assert.match(source, /chrome\.alarms\.clear\(watchdogAlarmName\(target\.id\)\)/);
  assert.match(source, /freshRequestStartedAt >= toggledAt/);
});

test('COMPLETE and BLOCKED terminal statuses have a direct watchdog stop route', () => {
  assert.match(source, /PARK_CODE_WATCHDOG_FOR_TERMINAL_STATUS_FOR_SENDER/);
  assert.match(source, /policy\?\.isDefinitiveStopStatusCode\?\.\(statusCode\) !== true/);
  assert.match(source, /monitor\.parkCodeWatchdogForTerminalStatus\(\{/);
  assert.match(source, /publishOverview\(target\)/);
});
