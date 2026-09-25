import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');

test('Quick Continue monitoring bridge is shipped through the hot-tab bootstrap path', () => {
  const manifest = JSON.parse(readText('extension/manifest.json'));
  const bootstrap = readText('extension/diagnostics-bootstrap.js');
  const background = readText('extension/quick-continue-monitor-bridge-background.js');
  const bridge = readText('extension/quick-continue-monitor-bridge.js');
  const statusOwner = readText('extension/quick-continue-status-owner-v6.js');
  const pageAuthority = readText('extension/watchdog-page-authority-v3.js');
  const backgroundAuthority = readText('extension/watchdog-authority-v3-background.js');

  assert.equal(manifest.version, '0.9.87');
  assert.ok(!manifest.content_scripts.some((entry) => Array.isArray(entry.js) && entry.js.includes('quick-continue-monitor-bridge.js')));
  assert.ok(!manifest.content_scripts.some((entry) => Array.isArray(entry.js) && entry.js.includes('quick-continue-status-fallback.js')));
  assert.ok(!manifest.content_scripts.some((entry) => entry.js?.includes('quick-continue-status-stabilizer.js')));
  const statusEntry = manifest.content_scripts.find((entry) => entry.js?.includes('quick-continue-status-owner-v6.js'));
  assert.equal(statusEntry?.run_at, 'document_start');
  const watchdogEntry = manifest.content_scripts.find((entry) => Array.isArray(entry.js) && entry.js.includes('watchdog-page-authority-v3.js'));
  assert.ok(watchdogEntry);
  assert.equal(watchdogEntry.run_at, 'document_start');
  assert.match(bootstrap, /importScripts\('quick-continue-monitor-bridge-background\.js'\)/);
  assert.match(bootstrap, /importScripts\('watchdog-authority-v3-background\.js'\)/);
  assert.match(background, /BRIDGE_FILE = 'quick-continue-monitor-bridge\.js'/);
  assert.match(background, /STATUS_FILE = 'quick-continue-status-owner-v6\.js'/);
  assert.match(background, /BRIDGE_RUNTIME_VERSION = 3/);
  assert.match(background, /STATUS_RUNTIME_VERSION = 8/);
  assert.match(background, /runtimeCurrent\(tabId, 'CHATGPT_NOTIFIER_QUICK_STATUS_PING', STATUS_RUNTIME_VERSION\)/);
  assert.match(background, /files:\s*\[BRIDGE_FILE\]/);
  assert.match(background, /files:\s*\[STATUS_FILE\]/);
  assert.match(background, /ensureExistingTabs/);
  assert.match(background, /chrome\.tabs\.onUpdated\.addListener/);
  assert.match(background, /CHATGPT_NOTIFIER_QUICK_BRIDGE_PING/);
  assert.match(background, /CHATGPT_NOTIFIER_QUICK_STATUS_PING/);
  assert.match(statusOwner, /RUNTIME_VERSION = 8/);
  assert.match(backgroundAuthority, /STATUS_RUNTIME_VERSION = 8/);

  assert.doesNotThrow(() => new vm.Script(background));
  assert.doesNotThrow(() => new vm.Script(bridge));
  assert.doesNotThrow(() => new vm.Script(statusOwner));
  assert.doesNotThrow(() => new vm.Script(pageAuthority));
  assert.doesNotThrow(() => new vm.Script(backgroundAuthority));
});

test('Continue and Project actions enable monitoring before arming the fresh user turn', () => {
  const bridge = readText('extension/quick-continue-monitor-bridge.js');

  assert.match(bridge, /Send timestamped Continue/);
  assert.match(bridge, /Send custom Project Continue/);
  assert.match(bridge, /\^Continue\\s\+\.\+/);
  assert.match(bridge, /type:\s*'SET_BUILD_AUTOMATION_STATE_FOR_SENDER'/);
  assert.match(bridge, /enabled:\s*true/);
  assert.match(bridge, /type:\s*'ARM_CODE_WATCHDOG_FOR_SENDER'/);
  assert.match(bridge, /source:\s*`quick-\$\{action\}-fresh-turn`/);

  const enableIndex = bridge.indexOf('const enabledPromise = enableAutomationForQuickAction()');
  const freshTurnIndex = bridge.indexOf('const newUserKey = await waitForNewUserTurn(previousUserKey)');
  const armIndex = bridge.indexOf("type: 'ARM_CODE_WATCHDOG_FOR_SENDER'", freshTurnIndex);
  assert.ok(enableIndex >= 0 && freshTurnIndex > enableIndex && armIndex > freshTurnIndex);
});

test('trusted manual and Quick Continue sends explicitly reset the fresh-turn 30-minute watchdog', () => {
  const pageAuthority = readText('extension/watchdog-page-authority-v3.js');

  assert.match(pageAuthority, /event\?\.isTrusted !== true/);
  assert.match(pageAuthority, /handleTrustedClick/);
  assert.match(pageAuthority, /handleTrustedKeydown/);
  assert.match(pageAuthority, /handleTrustedSubmit/);
  assert.doesNotMatch(pageAuthority, /quick-toolbar-fresh-turn-v3/);
  assert.match(pageAuthority, /trusted-send-click-v3/);
  assert.match(pageAuthority, /trusted-enter-submit-v3/);
  assert.match(pageAuthority, /type:\s*'ARM_CODE_WATCHDOG_FOR_SENDER'/);
  assert.match(pageAuthority, /const newUserKey = await waitForNewUserTurn\(previousUserKey\)/);
  assert.match(pageAuthority, /overview\?\.automationEnabled !== true/);
  assert.doesNotMatch(pageAuthority, /SET_BUILD_AUTOMATION_STATE_FOR_SENDER/);
});

test('Quick Continue bridge suppresses the legacy click-time arm before the fresh turn exists', () => {
  const bridge = readText('extension/quick-continue-monitor-bridge.js');

  assert.match(bridge, /window\.addEventListener\('click', handleQuickAction, \{ capture: true/);
  assert.doesNotMatch(bridge, /document\.addEventListener\('click', handleQuickAction/);
  assert.doesNotMatch(bridge, /LEGACY_MASKED_ARIA_LABEL|MutationObserver.*toolbar|style\.display/);
});

test('definitive rendered statuses have both legacy and v3 authoritative stop routes', () => {
  const bridge = readText('extension/quick-continue-monitor-bridge.js');
  const pageAuthority = readText('extension/watchdog-page-authority-v3.js');
  const backgroundAuthority = readText('extension/watchdog-authority-v3-background.js');

  for (const code of ['PLANNING_ACTIVE', 'COMPLETE_APPLIED', 'COMPLETE_NO_CHANGES', 'BLOCKED_HUMAN']) {
    assert.ok(bridge.includes(`'${code}'`));
    assert.ok(pageAuthority.includes(`'${code}'`));
  }
  assert.match(bridge, /type:\s*'PARK_CODE_WATCHDOG_FOR_TERMINAL_STATUS_FOR_SENDER'/);
  assert.match(pageAuthority, /type:\s*'FORCE_PARK_CODE_WATCHDOG_TERMINAL_V3'/);
  assert.match(backgroundAuthority, /monitor\.parkCodeWatchdogForTerminalStatus/);
  assert.match(backgroundAuthority, /terminal-stop-not-persisted/);
});

test('status presentation has one durable DOM owner and quarantines stale pre-v8 timer surfaces', () => {
  const owner = readText('extension/quick-continue-status-owner-v6.js');

  assert.match(owner, /RUNTIME_VERSION = 8/);
  assert.match(owner, /STATUS_OWNER_ATTR = 'data-chatgpt-notifier-watchdog-status-owner'/);
  assert.match(owner, /UI_OWNER_ATTR = 'data-chatgpt-notifier-watchdog-ui-owner'/);
  assert.match(owner, /STATUS_ID = `chatgpt-notifier-watchdog-status-v8-\$\{ownerToken\}`/);
  assert.match(owner, /function ownsUi\(\)/);
  assert.match(owner, /function claimUi\(\)/);
  assert.match(owner, /function relinquishUi\(\)/);
  assert.match(owner, /removeSupersededOwnedRows/);
  assert.match(owner, /\[id\^="chatgpt-notifier-countdown-v"\]/);
  assert.match(owner, /\[id\^="chatgpt-notifier-countdown-fallback-v"\]/);
  assert.match(owner, /display: none !important/);
  assert.match(owner, /width: calc\(100% \+ 2px\)/);
  assert.match(owner, /color: #111/);
  assert.match(owner, /text-align: right/);
  assert.match(owner, /overflow-wrap: anywhere/);
  assert.match(owner, /Stop current auto-continue timer/);
  assert.match(owner, /STOP_CODE_WATCHDOG_TIMER_FOR_SENDER/);
  assert.match(owner, /stopReason\.startsWith\('status:'\)/);
  assert.match(owner, /manualOnly/);
  assert.match(owner, /waitingForRequestStart === true/);
  assert.match(owner, /highestStateRevision/);
  assert.match(owner, /highestWatchdogRevision/);
  assert.match(owner, /overview\.codeWatchdog && !candidate\.codeWatchdog/);
  assert.match(owner, /RUN_CODE_WATCHDOG_NOW_V3/);
  assert.match(owner, /Sending auto-continue…/);
  assert.doesNotMatch(owner, /Auto-continue due/);
  assert.match(owner, /if \(!ownsUi\(\)\) \{\s*relinquishUi\(\);/);
  assert.doesNotMatch(owner, /MutationObserver/);
  assert.doesNotMatch(owner, /fetch\(/);
  assert.doesNotMatch(owner, /XMLHttpRequest/);
});
