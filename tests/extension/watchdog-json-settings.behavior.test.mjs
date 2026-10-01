import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');
const readJson = (relative) => JSON.parse(readText(relative));

const bundled = readJson('standalone-quick-continue/config.json');
const configSource = readText('standalone-quick-continue/config.js');
const contentSource = readText('standalone-quick-continue/content-script.js');
const bridgeSource = readText('extension/quick-continue-monitor-bridge.js');
const statusCodeSource = readText('extension/status-code.js');
const policySource = readText('extension/status-policy.js');
const monitorSource = readText('extension/monitor-background.js');
const invariantSource = readText('extension/watchdog-continuation-invariant-background.js');
const notifierManifest = readJson('extension/manifest.json');

function loadPolicy() {
  const context = vm.createContext({
    Date,
    Number,
    String,
    Set,
    Map,
    Object,
    Math,
    Array,
    URL,
    chrome: {
      storage: undefined,
      runtime: { onMessage: { addListener() {} } }
    }
  });
  context.globalThis = context;
  vm.runInContext(statusCodeSource, context);
  vm.runInContext(policySource, context);
  return context.ChatGPTNotifierContinuationPolicy;
}

test('bundled Quick Continue JSON exposes watchdog timing, gates, attempts, and every GitHub status policy', () => {
  assert.equal(bundled.watchdog.timerMinutes, 30);
  assert.equal(bundled.watchdog.attempts, 3);
  assert.equal(bundled.watchdog.respectStopStatusCodes, true);
  assert.equal(bundled.watchdog.respectContinueStatusCodes, true);
  assert.deepEqual(bundled.watchdog.stopOnStatus, {
    PLANNING_ACTIVE: true,
    COMPLETE_APPLIED: true,
    COMPLETE_NO_CHANGES: true,
    BLOCKED_HUMAN: true,
    INCOMPLETE_LIMIT: false,
    INCOMPLETE_TOOL_FAILURE: false,
    INCOMPLETE_CONTINUE: false,
    INCOMPLETE_HANDOFF: false
  });
  assert.match(configSource, /"watchdog\.timerMinutes" must be between 0\.1 and 1440/);
  assert.match(configSource, /"watchdog\.attempts" must be an integer between 0 and 20/);
  assert.match(configSource, /"watchdog\.respectStopStatusCodes" must be true or false/);
  assert.match(configSource, /"watchdog\.respectContinueStatusCodes" must be true or false/);
  assert.match(configSource, /Unknown GitHub status code in watchdog\.stopOnStatus/);
  assert.match(configSource, /typeof stopRaw\[key\] !== 'boolean'/);
});

test('runtime policy applies custom cadence and custom per-code stop behavior', () => {
  const policy = loadPolicy();
  const applied = policy.applyWatchdogSettings({
    timerMinutes: 7.5,
    attempts: 5,
    stopOnStatus: {
      BLOCKED_HUMAN: false,
      INCOMPLETE_LIMIT: true
    }
  });

  assert.equal(applied.timerMinutes, 7.5);
  assert.equal(applied.attempts, 5);
  assert.equal(applied.respectStopStatusCodes, true);
  assert.equal(applied.respectContinueStatusCodes, true);
  assert.equal(policy.watchdogDelayMs(), 7.5 * 60_000);
  assert.equal(policy.watchdogMaxSends(), 5);
  assert.equal(policy.statusCodeDisposition('BLOCKED_HUMAN'), 'continue');
  assert.equal(policy.isDefinitiveStopStatusCode('BLOCKED_HUMAN'), false);
  assert.equal(policy.isAutoContinueStatusCode('BLOCKED_HUMAN'), true);
  assert.equal(policy.statusCodeDisposition('INCOMPLETE_LIMIT'), 'stop');
  assert.equal(policy.isDefinitiveStopStatusCode('INCOMPLETE_LIMIT'), true);
  assert.equal(policy.isAutoContinueStatusCode('INCOMPLETE_LIMIT'), false);
  assert.equal(policy.isDefinitiveStopStatusCode('COMPLETE_APPLIED'), true);
});

test('stop-code and continue-code respect gates independently ignore their configured classes', () => {
  const policy = loadPolicy();

  policy.applyWatchdogSettings({
    respectStopStatusCodes: false,
    respectContinueStatusCodes: true
  });
  assert.equal(policy.statusCodeDisposition('COMPLETE_APPLIED'), 'ignore');
  assert.equal(policy.isDefinitiveStopStatusCode('COMPLETE_APPLIED'), false);
  assert.equal(policy.isAutoContinueStatusCode('COMPLETE_APPLIED'), true, 'ignored stop codes must not block an already-due timer');
  assert.deepEqual(
    { ...policy.classifyObservation({ statusCode: 'COMPLETE_APPLIED' }) },
    { state: 'waiting', reason: 'status-ignored:COMPLETE_APPLIED', automaticActionAllowed: false }
  );
  assert.equal(policy.statusCodeDisposition('INCOMPLETE_CONTINUE'), 'continue');
  assert.equal(policy.classifyObservation({ statusCode: 'INCOMPLETE_CONTINUE' }).automaticActionAllowed, true);

  policy.applyWatchdogSettings({
    respectStopStatusCodes: true,
    respectContinueStatusCodes: false
  });
  assert.equal(policy.statusCodeDisposition('COMPLETE_APPLIED'), 'stop');
  assert.equal(policy.isDefinitiveStopStatusCode('COMPLETE_APPLIED'), true);
  assert.equal(policy.statusCodeDisposition('INCOMPLETE_CONTINUE'), 'ignore');
  assert.equal(policy.isAutoContinueStatusCode('INCOMPLETE_CONTINUE'), true, 'ignored continue codes must not stop an already-due timer');
  assert.deepEqual(
    { ...policy.classifyObservation({ statusCode: 'INCOMPLETE_CONTINUE' }) },
    { state: 'waiting', reason: 'status-ignored:INCOMPLETE_CONTINUE', automaticActionAllowed: false }
  );
});

test('Quick Continue persists both respect gates and publishes normalized settings before arming a fresh watchdog', () => {
  assert.match(configSource, /respectStopStatusCodes: value\.watchdog\.respectStopStatusCodes/);
  assert.match(configSource, /respectContinueStatusCodes: value\.watchdog\.respectContinueStatusCodes/);
  assert.match(contentSource, /toolbar\.dataset\.watchdogSettings = JSON\.stringify\(config\.watchdog\)/);
  assert.match(contentSource, /publishWatchdogConfig\(currentConfig\)/);
  const syncAt = bridgeSource.indexOf('await syncWatchdogSettings(true)');
  const armAt = bridgeSource.indexOf("type: 'ARM_CODE_WATCHDOG_FOR_SENDER'");
  assert.ok(syncAt >= 0 && armAt > syncAt, 'settings must be synchronized before the fresh-turn arm');
  assert.match(bridgeSource, /type: 'SET_CODE_WATCHDOG_SETTINGS_FOR_SENDER'/);
});

test('canonical monitor owner persists settings in existing IndexedDB and uses them for deadlines, caps, and overview', () => {
  assert.equal(notifierManifest.permissions.includes('storage'), false, 'notifier must not add a storage permission for these settings');
  assert.match(monitorSource, /WATCHDOG_SETTINGS_KEY = 'code-watchdog-settings'/);
  assert.match(monitorSource, /async function persistCodeWatchdogSettings/);
  assert.match(monitorSource, /async function restoreCodeWatchdogSettings/);
  assert.match(monitorSource, /codeWatchdogSettingsReady\.then\(\(\) => handleCodeWatchdogAlarm/);
  assert.match(monitorSource, /function codeWatchdogDelayMs\(\)/);
  assert.match(monitorSource, /function codeWatchdogMaxSends\(\)/);
  assert.match(monitorSource, /deadlineAt: activationAt \+ codeWatchdogDelayMs\(\)/);
  assert.match(monitorSource, /deadlineAt: armedAt \+ codeWatchdogDelayMs\(\)/);
  assert.match(monitorSource, /Number\(record\.sendCount \|\| 0\) >= codeWatchdogMaxSends\(\)/);
  assert.match(monitorSource, /codeWatchdogMaxSends: codeWatchdogMaxSends\(\)/);
  assert.match(monitorSource, /codeWatchdogDelayMs: codeWatchdogDelayMs\(\)/);
  assert.match(invariantSource, /ChatGPTNotifierContinuationPolicy\?\.watchdogDelayMs\?\.\(\)/);
  assert.match(invariantSource, /ChatGPTNotifierContinuationPolicy\?\.watchdogMaxSends\?\.\(\)/);
});

test('JSON editor is materially larger and uses a dark explicit caret', () => {
  assert.match(contentSource, /projectPopover\.style\.minWidth = editing \? '540px'/);
  assert.match(contentSource, /width: '520px'/);
  assert.match(contentSource, /height: '360px'/);
  assert.match(contentSource, /caretColor: '#111827'/);
  assert.match(contentSource, /maxWidth: '520px'/);
});