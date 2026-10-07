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
const conversationStateSource = readText('standalone-quick-continue/conversation-state.js');
const simpleBackgroundSource = readText('standalone-quick-continue/background.js');
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

test('bundled Quick Continue JSON keeps only classification under watchdog and all timing under Simple', () => {
  assert.equal(bundled.watchdog.timerMinutes, undefined);
  assert.equal(bundled.watchdog.attempts, undefined);
  assert.equal(bundled.watchdog.respectStopStatusCodes, undefined);
  assert.equal(bundled.watchdog.respectContinueStatusCodes, undefined);
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
  assert.equal(bundled.simpleWatchdog.respectStopStatusCodes, true);
  assert.equal(bundled.simpleWatchdog.respectContinueStatusCodes, true);
  assert.doesNotMatch(configSource, /"watchdog\.timerMinutes" must be between 0\.1 and 1440/);
  assert.doesNotMatch(configSource, /"watchdog\.attempts" must be an integer between 0 and 20/);
  assert.match(configSource, /legacy\.timerMinutes/);
  assert.match(configSource, /legacy\.attempts/);
  assert.match(configSource, /"simpleWatchdog\.respectStopStatusCodes" must be true or false/);
  assert.match(configSource, /"simpleWatchdog\.respectContinueStatusCodes" must be true or false/);
  assert.match(configSource, /Unknown GitHub status code in watchdog\.stopOnStatus/);
  assert.match(configSource, /typeof stopRaw\[key\] !== 'boolean'/);
});

test('normal runtime policy continues to honor the shared classification table with both classes respected by default', () => {
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

test('notifier policy still implements class gating internally, but Quick Continue no longer publishes user gates to it', () => {
  const policy = loadPolicy();

  policy.applyWatchdogSettings({
    respectStopStatusCodes: false,
    respectContinueStatusCodes: true
  });
  assert.equal(policy.statusCodeDisposition('COMPLETE_APPLIED'), 'ignore');
  assert.equal(policy.statusCodeDisposition('INCOMPLETE_CONTINUE'), 'continue');

  policy.applyWatchdogSettings({
    respectStopStatusCodes: true,
    respectContinueStatusCodes: false
  });
  assert.equal(policy.statusCodeDisposition('COMPLETE_APPLIED'), 'stop');
  assert.equal(policy.statusCodeDisposition('INCOMPLETE_CONTINUE'), 'ignore');

  assert.match(contentSource, /toolbar\.dataset\.watchdogSettings = JSON\.stringify\(config\.watchdog\)/);
  assert.doesNotMatch(configSource, /respectStopStatusCodes: value\.watchdog\.respectStopStatusCodes/);
  assert.doesNotMatch(configSource, /respectContinueStatusCodes: value\.watchdog\.respectContinueStatusCodes/);
});

test('Quick Continue migrates legacy watchdog gate values into Simple and serializes them only there', () => {
  assert.match(configSource, /normalizeSimpleWatchdog\(value\.simpleWatchdog, value\.watchdog\)/);
  assert.match(configSource, /typeof legacy\.respectStopStatusCodes === 'boolean'/);
  assert.match(configSource, /typeof legacy\.respectContinueStatusCodes === 'boolean'/);
  assert.match(configSource, /respectStopStatusCodes: value\.simpleWatchdog\.respectStopStatusCodes/);
  assert.match(configSource, /respectContinueStatusCodes: value\.simpleWatchdog\.respectContinueStatusCodes/);
  assert.match(conversationStateSource, /settings: config\.simpleWatchdog/);
  assert.match(conversationStateSource, /statusClass: signal\.statusClass/);
  assert.doesNotMatch(conversationStateSource, /stopOnStatus:\s*config\.watchdog/);
  assert.match(simpleBackgroundSource, /const statusClass = String\(message\?\.statusClass/);
  assert.match(simpleBackgroundSource, /state\.settings\?\.respectStopStatusCodes !== false/);
  assert.match(simpleBackgroundSource, /state\.settings\?\.respectContinueStatusCodes !== false/);
  assert.doesNotMatch(simpleBackgroundSource, /normalizeStopOnStatus|state\.stopOnStatus/);
});

test('Quick Continue publishes only the shared status table and never arms the retired notifier watchdog', () => {
  assert.match(contentSource, /toolbar\.dataset\.watchdogSettings = JSON\.stringify\(config\.watchdog\)/);
  assert.match(contentSource, /publishWatchdogConfig\(currentConfig\)/);
  assert.match(bridgeSource, /syncStatusPolicySettings/);
  assert.match(bridgeSource, /type: 'SET_CODE_WATCHDOG_SETTINGS_FOR_SENDER'/);
  assert.doesNotMatch(bridgeSource, /ARM_CODE_WATCHDOG_FOR_SENDER|RUN_CODE_WATCHDOG_NOW_V3/);
  assert.doesNotMatch(configSource, /timerMinutes: value\.watchdog\.timerMinutes/);
  assert.doesNotMatch(configSource, /attempts: value\.watchdog\.attempts/);
});

test('legacy monitor timing implementation remains testable while production marks it retired', () => {
  assert.equal(notifierManifest.permissions.includes('storage'), false, 'notifier must not add a storage permission for these settings');
  assert.match(monitorSource, /WATCHDOG_SETTINGS_KEY = 'code-watchdog-settings'/);
  assert.match(monitorSource, /LEGACY_CODE_WATCHDOG_RETIRED = globalThis\.__chatgptNotifierPrimaryWatchdogMode\?\.simplePrimary === true/);
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
  assert.match(contentSource, /menuPopover\.style\.minWidth = editing \? '540px'/);
  assert.match(contentSource, /width: '520px'/);
  assert.match(contentSource, /height: '360px'/);
  assert.match(contentSource, /caretColor: '#111827'/);
  assert.match(contentSource, /maxWidth: '520px'/);
});