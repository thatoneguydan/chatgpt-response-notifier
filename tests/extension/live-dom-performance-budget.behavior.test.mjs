import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');

test('live DOM observation avoids high-frequency whole-page scan loops', () => {
  const recovery = readText('extension/recovery-live-fix-content.js');
  const recoveryBackground = readText('extension/recovery-live-fix-background.js');
  const monitor = readText('extension/monitor-script.js');
  const bridge = readText('extension/quick-continue-monitor-bridge.js');
  const watchdog = readText('extension/watchdog-page-authority-v3.js');
  const rebind = readText('extension/page-runtime-rebind.js');
  const compat = readText('extension/page-dom-compat.js');

  assert.match(recovery, /const RUNTIME_VERSION = 6/);
  assert.match(recoveryBackground, /const RUNTIME_VERSION = 6/);
  assert.doesNotMatch(recovery, /new MutationObserver/);
  assert.doesNotMatch(recovery, /function schedulePublish/);
  assert.match(recovery, /CHATGPT_RECOVERY_LIVE_INSPECT/);
  assert.match(recovery, /CHATGPT_RECOVERY_LIVE_REPUBLISH/);

  assert.match(monitor, /MUTATION_PUBLISH_DEBOUNCE_MS = 500/);
  assert.match(monitor, /MUTATION_PUBLISH_MAX_INTERVAL_MS = 2000/);
  assert.match(monitor, /new MutationObserver\(scheduleMutationPublish\)/);
  const monitorObserve = monitor.match(/observer\.observe\(root, \{[^\n]+\}\);/)?.[0] || '';
  assert.ok(monitorObserve, 'monitor observer contract missing');
  assert.doesNotMatch(monitorObserve, /'style'|'class'/);
  assert.match(monitor, /cachedPreviousPromptOwnerKey/);
  assert.match(monitor, /cachedPreviousPromptTerminal/);

  for (const source of [bridge, watchdog]) {
    assert.match(source, /TERMINAL_DEBOUNCE_MS = 250/);
    assert.match(source, /TERMINAL_MAX_INTERVAL_MS = 1500/);
    assert.match(source, /clearTerminalTimers/);
  }

  assert.match(rebind, /const RUNTIME_GENERATION = 2/);
  assert.match(rebind, /__chatgptNotifierPageRuntimeRebindGeneration/);
  assert.match(rebind, /previousGeneration === RUNTIME_GENERATION/);

  const getAttributeStart = compat.indexOf('function notifierCompatGetAttribute');
  const getAttributeBody = compat.slice(getAttributeStart);
  assert.ok(getAttributeStart >= 0);
  assert.ok(
    getAttributeBody.indexOf('if (value != null) return value;') < getAttributeBody.indexOf('const role = semanticRole(this);'),
    'native getAttribute hits must return before semantic-role fallback work'
  );
});
