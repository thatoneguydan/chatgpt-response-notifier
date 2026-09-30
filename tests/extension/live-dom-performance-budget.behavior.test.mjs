import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');

test('recovery observation is demand-driven instead of a high-frequency full-page loop', () => {
  const recovery = readText('extension/recovery-live-fix-content.js');
  const recoveryBackground = readText('extension/recovery-live-fix-background.js');
  const rebind = readText('extension/page-runtime-rebind.js');
  const compat = readText('extension/page-dom-compat.js');

  assert.match(recovery, /const RUNTIME_VERSION = 6/);
  assert.match(recoveryBackground, /const RUNTIME_VERSION = 6/);
  assert.doesNotMatch(recovery, /new MutationObserver/);
  assert.doesNotMatch(recovery, /function schedulePublish/);
  assert.match(recovery, /CHATGPT_RECOVERY_LIVE_INSPECT/);
  assert.match(recovery, /CHATGPT_RECOVERY_LIVE_REPUBLISH/);

  assert.match(rebind, /const RUNTIME_GENERATION = 3/);
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

test('mutation-driven live readers use quiet debounces with hard ceilings', () => {
  const monitor = readText('extension/monitor-script.js');
  const bridge = readText('extension/quick-continue-monitor-bridge.js');
  const watchdog = readText('extension/watchdog-page-authority-v3.js');

  assert.match(monitor, /MUTATION_PUBLISH_DEBOUNCE_MS = 500/);
  assert.match(monitor, /MUTATION_PUBLISH_MAX_INTERVAL_MS = 2000/);
  assert.match(monitor, /function clearPublishTimers/);
  assert.match(monitor, /if \(publishTimer !== null\) clearTimeout\(publishTimer\)/);
  assert.match(monitor, /publishMaxTimer === null/);
  assert.match(monitor, /cachedPreviousPromptOwnerKey/);
  assert.match(monitor, /cachedPreviousPromptTerminal/);

  const monitorObserve = monitor.match(/observer\.observe\(root, \{[^\n]+\}\);/)?.[0] || '';
  assert.ok(monitorObserve, 'monitor observer contract missing');
  assert.doesNotMatch(monitorObserve, /'style'|'class'/);

  for (const source of [bridge, watchdog]) {
    assert.match(source, /TERMINAL_DEBOUNCE_MS = 250/);
    assert.match(source, /TERMINAL_MAX_INTERVAL_MS = 1500/);
    assert.match(source, /function clearTerminalTimers/);
    assert.match(source, /if \(terminalTimer !== null\) clearTimeout\(terminalTimer\)/);
    assert.match(source, /terminalMaxTimer === null/);
  }
});

test('extension-owned countdown mutations are filtered before expensive live observers', () => {
  const filter = readText('extension/owned-dom-mutation-filter.js');
  const manifest = JSON.parse(readText('extension/manifest.json'));
  const compatBackground = readText('extension/page-runtime-compat-background.js');
  const postUpdate = readText('extension/terminal-stop-post-update-recovery-background.js');

  assert.match(filter, /RUNTIME_VERSION = 2/);
  assert.match(filter, /#chatgpt-quick-continue-toolbar/);
  assert.match(filter, /class NotifierFilteredMutationObserver/);
  assert.match(filter, /if \(filtered\.length\) callback\(filtered, facade\)/);
  assert.match(filter, /PASSTHROUGH_ATTRIBUTES = new Set\(\['data-watchdog-settings'\]\)/);
  assert.match(filter, /globalThis\.MutationObserver = NotifierFilteredMutationObserver/);

  const documentStartReaders = manifest.content_scripts[0]?.js || [];
  assert.equal(documentStartReaders[0], 'owned-dom-mutation-filter.js');
  const watchdogReaders = manifest.content_scripts.find((entry) => entry.js?.includes('watchdog-page-authority-v3.js'))?.js || [];
  assert.equal(watchdogReaders[0], 'owned-dom-mutation-filter.js');

  assert.match(compatBackground, /OWNED_DOM_FILTER_FILE = 'owned-dom-mutation-filter\.js'/);
  assert.match(compatBackground, /files: \[\.\.\.prefix, \.\.\.files\]/);

  const rebindIndex = postUpdate.indexOf("'page-runtime-rebind.js'");
  const filterIndex = postUpdate.indexOf("'owned-dom-mutation-filter.js'");
  const monitorIndex = postUpdate.indexOf("'monitor-script.js'");
  assert.ok(rebindIndex >= 0 && filterIndex > rebindIndex && monitorIndex > filterIndex,
    'hot-tab reinjection must dispose old runtimes, install the mutation filter, then recreate live readers');
});
