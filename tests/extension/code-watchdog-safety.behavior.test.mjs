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

test('watchdog no-code path never acts on active or unsettled work', () => {
  const eligibility = loadEligibility();

  assert.deepEqual(
    { ...eligibility({ requestPhase: 'started', stopGenerating: true, assistantKey: 'assistant-1', stableTerminal: true }) },
    { eligible: false, reason: 'generation-active' }
  );
  assert.deepEqual(
    { ...eligibility({ requestPhase: 'started', stopGenerating: false, assistantKey: 'assistant-1', stableTerminal: true }) },
    { eligible: false, reason: 'request-not-settled' }
  );
  assert.deepEqual(
    { ...eligibility({ requestPhase: 'unknown', assistantKey: 'assistant-1', stableTerminal: true }) },
    { eligible: false, reason: 'request-not-settled' }
  );
});

test('watchdog no-code path requires existing settled/stable evidence', () => {
  const eligibility = loadEligibility();

  assert.deepEqual(
    { ...eligibility({ requestPhase: 'completed', assistantKey: 'assistant-1', stableTerminal: false }) },
    { eligible: false, reason: 'assistant-not-stable' }
  );
  assert.deepEqual(
    { ...eligibility({ requestPhase: 'completed', assistantKey: 'assistant-1', stableTerminal: true }) },
    { eligible: true, reason: 'stable-terminal-no-code' }
  );
  assert.deepEqual(
    { ...eligibility({ requestPhase: 'completed', assistantKey: '', silentIdleConfirmations: 1 }) },
    { eligible: false, reason: 'silent-stop-unconfirmed' }
  );
  assert.deepEqual(
    { ...eligibility({ requestPhase: 'completed', assistantKey: '', silentIdleConfirmations: 2 }) },
    { eligible: true, reason: 'silent-stop-confirmed' }
  );
});

test('page-side watchdog has an independent active-generation veto', () => {
  const waitStart = statusSource.indexOf('function waitForWatchdogSendButton');
  const waitEnd = statusSource.indexOf('function matchesExpected', waitStart);
  const waitSource = statusSource.slice(waitStart, waitEnd);
  assert.match(waitSource, /!stopPresent\(\)\s*&&\s*enabledSend\(node\)/);

  const start = statusSource.indexOf('async function performWatchdogContinuation');
  const end = statusSource.indexOf('async function waitForTerminalStatus', start);
  const watchdog = statusSource.slice(start, end);
  assert.match(watchdog, /if \(stopPresent\(\)\) return \{ ok: false, clicked: false, reason: 'response-still-generating'/);
  assert.match(watchdog, /response-still-generating-before-send/);
});

test('settlement repair preserves watchdog timing and retry cap', () => {
  assert.match(monitorSource, /CODE_WATCHDOG_DELAY_MS = 30 \* 60_000/);
  assert.match(monitorSource, /CODE_WATCHDOG_RETRY_MS = 60_000/);
  assert.match(monitorSource, /CODE_WATCHDOG_MAX_SENDS = 3/);
  assert.match(monitorSource, /const noCodeEligibility = codeWatchdogNoCodeEligibility\(live\)/);
  assert.match(monitorSource, /if \(noCodeEligibility\.eligible !== true\)/);
});
