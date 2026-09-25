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
  const fallback = readText('extension/quick-continue-status-fallback.js');
  const stabilizer = readText('extension/quick-continue-status-stabilizer.js');

  assert.equal(manifest.version, '0.9.76');
  assert.ok(!manifest.content_scripts.some((entry) => Array.isArray(entry.js) && entry.js.includes('quick-continue-monitor-bridge.js')));
  assert.ok(!manifest.content_scripts.some((entry) => Array.isArray(entry.js) && entry.js.includes('quick-continue-status-fallback.js')));
  const stabilizerEntry = manifest.content_scripts.find((entry) => Array.isArray(entry.js) && entry.js.includes('quick-continue-status-stabilizer.js'));
  assert.ok(stabilizerEntry);
  assert.equal(stabilizerEntry.run_at, 'document_start');
  assert.match(bootstrap, /importScripts\('quick-continue-monitor-bridge-background\.js'\)/);
  assert.match(background, /BRIDGE_FILE = 'quick-continue-monitor-bridge\.js'/);
  assert.match(background, /STATUS_FALLBACK_FILE = 'quick-continue-status-fallback\.js'/);
  assert.match(background, /BRIDGE_RUNTIME_VERSION = 2/);
  assert.match(background, /STATUS_RUNTIME_VERSION = 3/);
  assert.match(background, /runtimeCurrent\(tabId, 'CHATGPT_NOTIFIER_QUICK_STATUS_PING', STATUS_RUNTIME_VERSION\)/);
  assert.match(background, /files:\s*\[BRIDGE_FILE\]/);
  assert.match(background, /files:\s*\[STATUS_FALLBACK_FILE\]/);
  assert.match(background, /ensureExistingTabs/);
  assert.match(background, /chrome\.tabs\.onUpdated\.addListener/);
  assert.match(background, /CHATGPT_NOTIFIER_QUICK_BRIDGE_PING/);
  assert.match(background, /CHATGPT_NOTIFIER_QUICK_STATUS_PING/);
  assert.match(stabilizer, /chatgpt-notifier-countdown-v/);
  assert.match(stabilizer, /display:\s*none !important/);

  assert.doesNotThrow(() => new vm.Script(background));
  assert.doesNotThrow(() => new vm.Script(bridge));
  assert.doesNotThrow(() => new vm.Script(fallback));
  assert.doesNotThrow(() => new vm.Script(stabilizer));
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

test('Quick Continue bridge suppresses the legacy click-time arm before the fresh turn exists', () => {
  const bridge = readText('extension/quick-continue-monitor-bridge.js');

  assert.match(bridge, /window\.addEventListener\('click', handleQuickAction, \{ capture: true/);
  assert.doesNotMatch(bridge, /document\.addEventListener\('click', handleQuickAction/);
  assert.match(bridge, /LEGACY_MASKED_ARIA_LABEL = 'Quick Continue sending'/);
  assert.match(bridge, /control\.setAttribute\('aria-label', LEGACY_MASKED_ARIA_LABEL\)/);
  assert.match(bridge, /control\.setAttribute\('aria-label', originalLabel\)/);
});

test('definitive rendered statuses directly park the watchdog', () => {
  const bridge = readText('extension/quick-continue-monitor-bridge.js');

  for (const code of ['PLANNING_ACTIVE', 'COMPLETE_APPLIED', 'COMPLETE_NO_CHANGES', 'BLOCKED_HUMAN']) {
    assert.ok(bridge.includes(`'${code}'`));
  }
  assert.match(bridge, /type:\s*'PARK_CODE_WATCHDOG_FOR_TERMINAL_STATUS_FOR_SENDER'/);
  assert.match(bridge, /statusCode:\s*terminal\.statusCode/);
  assert.doesNotMatch(bridge, /type:\s*'CHATGPT_MONITOR_STATE'/);
});

test('status presentation has one compact fixed owner and no competing pseudo status', () => {
  const bridge = readText('extension/quick-continue-monitor-bridge.js');
  const fallback = readText('extension/quick-continue-status-fallback.js');

  assert.match(bridge, /RUNTIME_VERSION = 2/);
  assert.match(bridge, /display:\s*none !important/);
  assert.match(bridge, /content:\s*none !important/);
  assert.match(fallback, /RUNTIME_VERSION = 3/);
  assert.match(fallback, /STATUS_WIDTH_PX = 200/);
  assert.match(fallback, /font-size:\s*10px !important/);
  assert.match(fallback, /background:\s*var\(--main-surface-primary, #fff\) !important/);
  assert.match(fallback, /node\.style\.setProperty\('width', `\$\{statusWidth\}px`, 'important'\)/);
  assert.match(fallback, /stopReason\.startsWith\('status:'\)/);
  assert.match(fallback, /manualOnlyDeadline/);
  assert.match(fallback, /waitingForRequestStart === true/);
  assert.match(fallback, /if \(!watchdog\) return ''/);
  assert.match(fallback, /overview\?\.codeWatchdog/);
  assert.doesNotMatch(fallback, /MutationObserver/);
  assert.doesNotMatch(fallback, /STATUS_WIDTH_PX = 280/);
  assert.doesNotMatch(fallback, /fetch\(/);
  assert.doesNotMatch(fallback, /XMLHttpRequest/);
});
