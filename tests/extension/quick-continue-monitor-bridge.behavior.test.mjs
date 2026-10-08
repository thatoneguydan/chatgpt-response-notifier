import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');

test('Quick Continue primary-watchdog bridge is shipped through the hot-tab bootstrap path', () => {
  const manifest = JSON.parse(readText('extension/manifest.json'));
  const version = readText('VERSION.txt').trim();
  const bootstrap = readText('extension/diagnostics-bootstrap.js');
  const background = readText('extension/quick-continue-monitor-bridge-background.js');
  const bridge = readText('extension/quick-continue-monitor-bridge.js');
  const statusOwner = readText('extension/quick-continue-status-owner-v6.js');
  const backgroundAuthority = readText('extension/watchdog-authority-v3-background.js');

  assert.equal(manifest.version, version);
  const statusEntry = manifest.content_scripts.find((entry) => entry.js?.includes('quick-continue-status-owner-v6.js'));
  assert.equal(statusEntry?.run_at, 'document_start');
  assert.match(bootstrap, /importScripts\('quick-continue-monitor-bridge-background\.js'\)/);
  assert.match(background, /BRIDGE_FILE = 'quick-continue-monitor-bridge\.js'/);
  assert.match(background, /STATUS_FILE = 'quick-continue-status-owner-v6\.js'/);
  assert.match(background, /BRIDGE_RUNTIME_VERSION = 7/);
  assert.match(background, /STATUS_RUNTIME_VERSION = 9/);
  assert.match(statusOwner, /RUNTIME_VERSION = 9/);
  assert.match(backgroundAuthority, /STATUS_RUNTIME_VERSION = 9/);

  const bridgeRuntimeVersion = Number(bridge.match(/const RUNTIME_VERSION = (\d+)/)?.[1] || 0);
  const requiredBridgeRuntimeVersion = Number(background.match(/const BRIDGE_RUNTIME_VERSION = (\d+)/)?.[1] || 0);
  assert.equal(requiredBridgeRuntimeVersion, bridgeRuntimeVersion);
  assert.doesNotThrow(() => new vm.Script(background));
  assert.doesNotThrow(() => new vm.Script(bridge));
  assert.doesNotThrow(() => new vm.Script(statusOwner));
});

test('Continue and Project actions enable Monitor but never arm the retired notifier watchdog', () => {
  const bridge = readText('extension/quick-continue-monitor-bridge.js');

  assert.match(bridge, /Send timestamped Continue/);
  assert.match(bridge, /Send custom Project Continue/);
  assert.match(bridge, /type:\s*'SET_BUILD_AUTOMATION_STATE_FOR_SENDER'/);
  assert.match(bridge, /enabled:\s*true/);
  assert.doesNotMatch(bridge, /ARM_CODE_WATCHDOG_FOR_SENDER/);
  assert.doesNotMatch(bridge, /RUN_CODE_WATCHDOG_NOW_V3/);
  assert.doesNotMatch(bridge, /PARK_CODE_WATCHDOG_FOR_TERMINAL_STATUS_FOR_SENDER/);
  assert.doesNotMatch(bridge, /latestAssistantSnapshot|statusCode|assistantKey/);
});

test('production keeps the retired notifier scheduler off while Quick Continue owns Monitor scheduling', () => {
  const background = readText('extension/background.js');
  const monitor = readText('extension/monitor-background.js');
  const soleAuthority = readText('extension/watchdog-sole-continuation-authority-background.js');
  const monitorBackground = readText('standalone-quick-continue/monitor-watchdog-background.js');

  // The compatibility flag still retires the old notifier scheduler; it is not
  // the Monitor implementation anymore. Monitor now has an independent engine.
  assert.match(background, /__chatgptNotifierPrimaryWatchdogMode = Object\.freeze\(\{[\s\S]*simplePrimary: true/);
  assert.match(monitor, /LEGACY_CODE_WATCHDOG_RETIRED = globalThis\.__chatgptNotifierPrimaryWatchdogMode\?\.simplePrimary === true/);
  assert.match(monitor, /if \(LEGACY_CODE_WATCHDOG_RETIRED\) \{[\s\S]*clearCodeWatchdog\(conversationId\)/);
  assert.match(monitor, /reason: 'legacy-watchdog-retired'/);
  assert.match(soleAuthority, /legacyWatchdogRetired = globalThis\.__chatgptNotifierLegacyWatchdogRetired === true/);
  assert.match(soleAuthority, /if \(!legacyWatchdogRetired\) retireShortCadenceState/);
  assert.match(monitorBackground, /quickContinueMonitorWatchdogStates/);
  assert.match(monitorBackground, /quick-continue-monitor-watchdog:/);
  assert.doesNotMatch(monitorBackground, /quickContinueSimpleWatchdogStates/);
});

test('Monitor publishes its state to the independent Monitor runtime, never to Simple', () => {
  const attachment = readText('extension/attachment-script.js');
  const monitorRuntime = readText('standalone-quick-continue/monitor-watchdog.js');
  const simpleRuntime = readText('standalone-quick-continue/conversation-state.js');

  assert.match(attachment, /PRIMARY_WATCHDOG_ATTR = 'data-chatgpt-notifier-primary-watchdog'/);
  assert.match(attachment, /publishPrimaryWatchdogAuthority/);
  assert.match(attachment, /enabled: overview\.automationEnabled === true && overview\.pausedByUser !== true/);
  assert.match(attachment, /setAttribute\?\.\(PRIMARY_WATCHDOG_ATTR, JSON\.stringify\(command\)\)/);

  assert.match(monitorRuntime, /PRIMARY_WATCHDOG_ATTR = 'data-chatgpt-notifier-primary-watchdog'/);
  assert.match(monitorRuntime, /function monitorWatchdogAuthority\(\)/);
  assert.match(monitorRuntime, /const token = `\$\{authority\.conversationId\}\|\$\{authority\.enabled \? 1 : 0\}`/);
  assert.match(monitorRuntime, /setMonitorEnabled\(authority\.enabled\)/);
  assert.match(monitorRuntime, /QUICK_CONTINUE_MONITOR_WATCHDOG_SET/);
  assert.match(monitorRuntime, /config\?\.monitorWatchdog/);

  assert.doesNotMatch(simpleRuntime, /PRIMARY_WATCHDOG_ATTR/);
  assert.doesNotMatch(simpleRuntime, /QUICK_CONTINUE_MONITOR_WATCHDOG_/);
  assert.match(simpleRuntime, /QUICK_CONTINUE_SIMPLE_WATCHDOG_SET/);
});

test('trusted monitored sends reset only the Monitor timer; Simple remains independent', () => {
  const monitorRuntime = readText('standalone-quick-continue/monitor-watchdog.js');
  const simpleRuntime = readText('standalone-quick-continue/conversation-state.js');

  assert.match(monitorRuntime, /function restartMonitorWatchdogFromTrustedSend\(\)/);
  assert.match(monitorRuntime, /authority\?\.enabled !== true/);
  assert.match(monitorRuntime, /setMonitorEnabled\(true\)/);
  assert.match(monitorRuntime, /event\?\.isTrusted !== true/);
  assert.match(monitorRuntime, /Send timestamped Continue/);
  assert.match(monitorRuntime, /Send custom Project Continue/);
  assert.match(monitorRuntime, /testId\.includes\('send-button'\)/);
  assert.match(monitorRuntime, /event\?\.key !== 'Enter'/);

  assert.doesNotMatch(simpleRuntime, /restartPrimaryWatchdogFromTrustedSend/);
  assert.doesNotMatch(simpleRuntime, /setMonitorEnabled/);
});

test('the retired notifier watchdog timer surface removes stale nodes and has no send authority', () => {
  const owner = readText('extension/quick-continue-status-owner-v6.js');

  assert.match(owner, /RUNTIME_VERSION = 9/);
  assert.match(owner, /legacyWatchdogRetired: true/);
  assert.match(owner, /removeLegacyWatchdogUi/);
  assert.match(owner, /data-chatgpt-notifier-watchdog-status-owner/);
  assert.match(owner, /chatgpt-notifier-countdown-v/);
  assert.doesNotMatch(owner, /RUN_CODE_WATCHDOG_NOW_V3/);
  assert.doesNotMatch(owner, /STOP_CODE_WATCHDOG_TIMER_FOR_SENDER/);
  assert.doesNotMatch(owner, /RESET_CODE_WATCHDOG_BUDGET_FOR_SENDER/);
  assert.doesNotMatch(owner, /setInterval/);
  assert.doesNotMatch(owner, /fetch\(/);
  assert.doesNotMatch(owner, /XMLHttpRequest/);
});

test('bridge only synchronizes local policy state and does not add ChatGPT network traffic', () => {
  const bridge = readText('extension/quick-continue-monitor-bridge.js');

  assert.match(bridge, /SET_CODE_WATCHDOG_SETTINGS_FOR_SENDER/);
  assert.match(bridge, /data-watchdog-settings/);
  assert.doesNotMatch(bridge, /backend-api|XMLHttpRequest|WebSocket|fetch\(/);
});
