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
  assert.match(source, /RUNTIME_VERSION = 2/);
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

test('COMPLETE and BLOCKED terminal statuses serialize through the canonical watchdog queue and reset attempts', () => {
  assert.match(source, /PARK_CODE_WATCHDOG_FOR_TERMINAL_STATUS_FOR_SENDER/);
  assert.match(source, /policy\?\.isDefinitiveStopStatusCode\?\.\(statusCode\) !== true/);
  assert.match(source, /const stopped = await monitor\.reconcileCodeWatchdog\(\{/);
  assert.doesNotMatch(source, /monitor\.parkCodeWatchdogForTerminalStatus\(\{/);
  assert.match(source, /resetStoppedAttempts\(target\.id, statusCode\)/);
  assert.match(source, /sendCount:\s*0/);
  assert.match(source, /lastAutomaticSentAt:\s*0/);
  assert.match(source, /lastAutomaticPromptKey:\s*''/);
  assert.match(source, /lastAutomaticParentPromptKey:\s*''/);
  assert.match(source, /deadlineAt:\s*0/);
  assert.match(source, /retryAt:\s*0/);
  assert.match(source, /publishOverview\(target\)/);
});

test('definitive terminal latch defeats late stale monitor snapshots until a genuinely newer request starts', () => {
  assert.match(source, /TERMINAL_REASSERT_DELAYS_MS/);
  assert.match(source, /terminalLatchesByConversation/);
  assert.match(source, /rememberTerminalLatch\(target\.id, statusCode, promptKey, stoppedAt\)/);
  assert.match(source, /message\?\.type === 'CHATGPT_MONITOR_STATE'/);
  assert.match(source, /scheduleTerminalReassert\(conversationId, sender\.tab\.id\)/);
  assert.match(source, /reassertTerminalLatch/);
  assert.match(source, /freshRequestClearsTerminalLatch/);
  assert.match(source, /requestStartedAt > Number\(latch\.stoppedAt \|\| 0\)/);
  assert.match(source, /currentRequestStartedAt > Number\(activeLatch\.stoppedAt \|\| 0\)/);
});
