import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');

test('Quick Continue monitoring bridge is shipped in page and hot-tab bootstrap paths', () => {
  const manifest = JSON.parse(readText('extension/manifest.json'));
  const bootstrap = readText('extension/diagnostics-bootstrap.js');
  const background = readText('extension/quick-continue-monitor-bridge-background.js');
  const bridge = readText('extension/quick-continue-monitor-bridge.js');

  assert.equal(manifest.version, '0.9.71');
  assert.ok(manifest.content_scripts[0].js.includes('quick-continue-monitor-bridge.js'));
  assert.match(bootstrap, /importScripts\('quick-continue-monitor-bridge-background\.js'\)/);
  assert.match(background, /files:\s*\[BRIDGE_FILE\]/);
  assert.match(background, /CHATGPT_NOTIFIER_QUICK_BRIDGE_PING/);

  assert.doesNotThrow(() => new vm.Script(background));
  assert.doesNotThrow(() => new vm.Script(bridge));
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
