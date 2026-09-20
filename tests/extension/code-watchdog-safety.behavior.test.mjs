import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const monitorSource = readFileSync(new URL('extension/monitor-background.js', root), 'utf8');
const statusSource = readFileSync(new URL('extension/status-script.js', root), 'utf8');

function loadEligibility() {
  const start = monitorSource.indexOf('function codeWatchdogNoCodeEligibility');
  const end = monitorSource.indexOf('async function handleCodeWatchdogAlarm', start);
  assert.ok(start >= 0 && end > start, 'watchdog no-code eligibility helper must exist');
  const context = vm.createContext({ String, Number, Array, globalThis: null });
  context.globalThis = context;
  vm.runInContext(`${monitorSource.slice(start, end)}\nglobalThis.__eligibility = codeWatchdogNoCodeEligibility;`, context);
  return context.__eligibility;
}

test('watchdog no-code path preserves genuine submission and identity vetoes', () => {
  const eligibility = loadEligibility();
  const cases = [
    ['observable', false, 'page-unobservable'],
    ['online', false, 'offline'],
    ['authRequired', true, 'auth-required'],
    ['approvalRequired', true, 'approval-required'],
    ['rateLimited', true, 'rate-limited'],
    ['hasDraft', true, 'draft-present'],
    ['hasUpload', true, 'upload-present'],
    ['applicationStateIdentityMatched', false, 'application-state-identity-mismatch']
  ];
  for (const [field, value, reason] of cases) {
    assert.deepEqual(
      { ...eligibility({ requestPhase: 'completed', assistantKey: 'assistant-1', stableTerminal: true, [field]: value }) },
      { eligible: false, reason },
      field
    );
  }
});

test('30-minute no-code deadline is authoritative even while generation is active or unsettled', () => {
  const eligibility = loadEligibility();
  const cases = [
    { requestPhase: 'started', stopGenerating: true, toolActivity: true, assistantKey: 'assistant-1', stableTerminal: false },
    { requestPhase: 'unknown', stopGenerating: false, toolActivity: false, assistantKey: 'assistant-1', stableTerminal: false },
    { requestPhase: 'completed', manualStopped: true, assistantKey: '', silentIdleConfirmations: 0 },
    { requestPhase: 'completed', assistantKey: '', silentIdleConfirmations: 1 }
  ];
  for (const snapshot of cases) {
    assert.deepEqual(
      { ...eligibility(snapshot) },
      { eligible: true, reason: 'deadline-no-code' }
    );
  }
});

test('page-side watchdog can queue the deadline Continue while generation is active', () => {
  const waitStart = statusSource.indexOf('function waitForWatchdogSendButton');
  const waitEnd = statusSource.indexOf('function matchesExpected', waitStart);
  const waitSource = statusSource.slice(waitStart, waitEnd);
  assert.match(waitSource, /enabledSend\(node\)/);
  assert.doesNotMatch(waitSource, /stopPresent\(\)/);

  const start = statusSource.indexOf('async function performWatchdogContinuation');
  const end = statusSource.indexOf('async function waitForTerminalStatus', start);
  const watchdog = statusSource.slice(start, end);
  assert.doesNotMatch(watchdog, /response-still-generating/);
  assert.match(watchdog, /beforeSendStatusCode/);
});

test('watchdog command is bound to the exact prompt at both send boundaries', () => {
  assert.match(monitorSource, /promptKey:\s*String\(promptKey \|\| ''\)/);
  assert.match(monitorSource, /sendCodeWatchdogContinuation\(tab\.id, conversationId, String\(live\.promptKey \|\| ''\)\)/);

  const start = statusSource.indexOf('async function performWatchdogContinuation');
  const end = statusSource.indexOf('async function waitForTerminalStatus', start);
  const watchdog = statusSource.slice(start, end);
  assert.match(watchdog, /expectedPromptKey/);
  assert.match(watchdog, /watchdog-prompt-changed/);
  assert.match(watchdog, /watchdog-prompt-changed-before-send/);
  assert.match(statusSource, /performWatchdogContinuation\(message\?\.conversationId \|\| '', message\?\.promptKey \|\| ''\)/);
});

test('hard-deadline watchdog preserves timing and retry cap', () => {
  assert.match(monitorSource, /CODE_WATCHDOG_DELAY_MS = 30 \* 60_000/);
  assert.match(monitorSource, /CODE_WATCHDOG_RETRY_MS = 60_000/);
  assert.match(monitorSource, /CODE_WATCHDOG_MAX_SENDS = 3/);
  assert.match(monitorSource, /const noCodeEligibility = codeWatchdogNoCodeEligibility\(live\)/);
  assert.match(monitorSource, /if \(noCodeEligibility\.eligible !== true\)/);
});

test('overdue watchdog observation retries do not replace the continuation deadline', () => {
  const retryStart = monitorSource.indexOf('async function scheduleCodeWatchdogRetry');
  const retryEnd = monitorSource.indexOf('async function parkCodeWatchdog', retryStart);
  assert.ok(retryStart >= 0 && retryEnd > retryStart, 'watchdog retry scheduler must exist');
  const retrySource = monitorSource.slice(retryStart, retryEnd);

  assert.match(retrySource, /retryAt/);
  assert.match(retrySource, /retryReason/);
  assert.doesNotMatch(retrySource, /deadlineAt\s*:/);
  assert.match(monitorSource, /scheduleCodeWatchdogRetry\(record, noCodeEligibility\.reason\)/);
  assert.match(monitorSource, /scheduleCodeWatchdogRetry\(record, 'page-unavailable'\)/);
  assert.match(monitorSource, /scheduleCodeWatchdogRetry\(record, 'runtime-unavailable'\)/);
  assert.match(monitorSource, /deadlineAt,[\s\S]*retryAt: 0,[\s\S]*retryReason: ''/);
});

test('worker startup rearms an overdue persisted deadline immediately instead of honoring an old settlement retry', () => {
  const start = monitorSource.indexOf('async function restoreCodeWatchdogAlarms');
  const end = monitorSource.indexOf('async function pruneOldRuns', start);
  assert.ok(start >= 0 && end > start, 'watchdog alarm restore helper must exist');
  const restore = monitorSource.slice(start, end);
  assert.match(restore, /if \(deadlineAt > 0\) when = deadlineAt <= now \? now \+ 1000 : deadlineAt/);
  assert.match(restore, /else if \(retryAt > 0\)/);
  assert.match(monitorSource, /restoreCodeWatchdogAlarms\(\)\.catch/);
});
