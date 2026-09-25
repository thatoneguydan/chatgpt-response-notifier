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

  assert.equal(manifest.version, '0.9.73');
  assert.ok(!manifest.content_scripts.some((entry) => Array.isArray(entry.js) && entry.js.includes('quick-continue-monitor-bridge.js')));
  assert.ok(!manifest.content_scripts.some((entry) => Array.isArray(entry.js) && entry.js.includes('quick-continue-status-fallback.js')));
  assert.match(bootstrap, /importScripts\('quick-continue-monitor-bridge-background\.js'\)/);
  assert.match(background, /BRIDGE_FILE = 'quick-continue-monitor-bridge\.js'/);
  assert.match(background, /STATUS_FALLBACK_FILE = 'quick-continue-status-fallback\.js'/);
  assert.match(background, /files:\s*\[BRIDGE_FILE\]/);
  assert.match(background, /files:\s*\[STATUS_FALLBACK_FILE\]/);
  assert.match(background, /ensureExistingTabs/);
  assert.match(background, /chrome\.tabs\.onUpdated\.addListener/);
  assert.match(background, /CHATGPT_NOTIFIER_QUICK_BRIDGE_PING/);
  assert.match(background, /CHATGPT_NOTIFIER_QUICK_STATUS_PING/);

  assert.doesNotThrow(() => new vm.Script(background));
  assert.doesNotThrow(() => new vm.Script(bridge));
  assert.doesNotThrow(() => new vm.Script(fallback));
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
  assert.match(bridge, /setTimeout\(\(\) => \{/);
});

test('definitive status fallback stops the current prompt without inheriting an old footer', () => {
  const bridge = readText('extension/quick-continue-monitor-bridge.js');

  for (const code of ['PLANNING_ACTIVE', 'COMPLETE_APPLIED', 'COMPLETE_NO_CHANGES', 'BLOCKED_HUMAN']) {
    assert.ok(bridge.includes(`'${code}'`));
  }
  assert.match(bridge, /terminal\.promptKey.*snapshot\.promptKey/);
  assert.match(bridge, /terminal\.conversationId.*snapshot\.conversationId/);
  assert.match(bridge, /type:\s*'CHATGPT_MONITOR_STATE'/);
  assert.match(bridge, /statusCode:\s*terminal\.statusCode/);
  assert.match(bridge, /hasStatusEvidence:\s*true/);
});

test('automation status is left aligned above the toolbar and reinjection preserves visual geometry', () => {
  const bridge = readText('extension/quick-continue-monitor-bridge.js');

  assert.match(bridge, /left:\s*0 !important/);
  assert.match(bridge, /bottom:\s*calc\(100% \+ 4px\) !important/);
  assert.match(bridge, /text-align:\s*left !important/);
  assert.match(bridge, /background:\s*transparent !important/);
  assert.match(bridge, /data-chatgpt-notifier-last-state/);
  assert.match(bridge, /data-chatgpt-notifier-last-status/);
  assert.match(bridge, /:not\(:has\(\[id\^="chatgpt-notifier-control-v"\]\)\)::before/);
  assert.match(bridge, /:not\(:has\(\[id\^="chatgpt-notifier-countdown-v"\]\)\)::after/);
});

test('timer fallback keeps countdown and attempts visible when canonical status is hidden', () => {
  const fallback = readText('extension/quick-continue-status-fallback.js');

  assert.match(fallback, /CANONICAL_STATUS_SELECTOR/);
  assert.match(fallback, /status\.hidden === true/);
  assert.match(fallback, /Next auto-continue \$\{formatCountdown/);
  assert.match(fallback, /const remainingText = `\$\{remaining\} left`/);
  assert.match(fallback, /GET_BUILD_AUTOMATION_OVERVIEW_FOR_SENDER/);
  assert.match(fallback, /RESET_CODE_WATCHDOG_BUDGET_FOR_SENDER/);
  assert.match(fallback, /refreshTimer = setInterval/);
  assert.match(fallback, /tickTimer = setInterval\(render, 1000\)/);
  assert.match(fallback, /if \(canonicalStatusVisible\(toolbar\)\) \{\s*fallback\.hidden = true/);
  assert.match(fallback, /target === fallback \|\| fallback\?\.contains\?\.\(target\)/);
  assert.doesNotMatch(fallback, /fetch\(/);
  assert.doesNotMatch(fallback, /XMLHttpRequest/);
});