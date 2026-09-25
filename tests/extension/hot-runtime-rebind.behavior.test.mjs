import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root), 'utf8');

test('post-update rebind replaces all critical isolated-world runtimes without refreshing ChatGPT', () => {
  const recovery = read('extension/terminal-stop-post-update-recovery-background.js');
  const rebind = read('extension/page-runtime-rebind.js');

  assert.match(recovery, /const RUNTIME_VERSION = 3/);
  const requiredFiles = [
    'page-runtime-rebind.js',
    'page-dom-compat.js',
    'attachment-script.js',
    'content-script.js',
    'persistence-script.js',
    'status-code.js',
    'status-policy.js',
    'rendered-terminal-status.js',
    'monitor-script.js',
    'bounded-recovery-script.js',
    'status-script.js',
    'terminal-status-live-observer.js',
    'recovery-script.js',
    'watchdog-page-authority-v3.js',
    'quick-continue-monitor-bridge.js',
    'quick-continue-status-owner-v6.js'
  ];
  for (const file of requiredFiles) assert.ok(recovery.includes(`'${file}'`), file);
  assert.ok(recovery.indexOf("'page-runtime-rebind.js'") < recovery.indexOf("'page-dom-compat.js'"));
  assert.ok(recovery.indexOf("'page-dom-compat.js'") < recovery.indexOf("'monitor-script.js'"));
  assert.ok(recovery.indexOf("'attachment-script.js'") < recovery.indexOf("'content-script.js'"));
  assert.ok(recovery.indexOf("'rendered-terminal-status.js'") < recovery.indexOf("'terminal-status-live-observer.js'"));
  assert.doesNotMatch(recovery, /chrome\.tabs\.reload/);
  assert.doesNotMatch(recovery, /tabs\.update\([^)]*active:\s*true/);

  assert.match(rebind, /chrome\.runtime\.getManifest\(\)\.version/);
  assert.match(rebind, /__chatgptNotifierPageRuntimeRebindVersion/);
  assert.match(rebind, /previousVersion === extensionVersion/);
  assert.match(rebind, /__chatgptNotifierAttachmentRuntime/);
  assert.match(rebind, /__chatgptNotifierMonitorRuntime/);
  assert.match(rebind, /__chatgptNotifierStatusRuntime/);
  assert.match(rebind, /__chatgptNotifierRenderedTerminalObserver/);
  assert.match(rebind, /__chatgptNotifierStreamStatusBridge/);
  assert.match(rebind, /__chatgptNotifierQuickContinueBridge/);
  assert.match(rebind, /__chatgptNotifierQuickContinueStatusFallback/);
  assert.match(rebind, /__chatgptNotifierWatchdogPageAuthorityV3/);
  assert.match(rebind, /__chatgptPromptBoundNotifierInstalled = false/);
  assert.match(rebind, /__chatgptNotifierPersistenceInstalled = false/);
  assert.match(rebind, /__chatgptNotifierRecoveryInstalled = false/);
  assert.match(rebind, /__chatgptNotifierStatusDomInstalled = false/);

  assert.doesNotThrow(() => new vm.Script(rebind));
  assert.doesNotThrow(() => new vm.Script(recovery));
});

test('all programmatic turn readers receive the semantic DOM adapter', () => {
  const compat = read('extension/page-runtime-compat-background.js');
  assert.match(compat, /quick-continue-monitor-bridge\.js/);
  assert.match(compat, /watchdog-page-authority-v3\.js/);
  assert.match(compat, /terminal-status-live-observer\.js/);
  assert.match(compat, /PAGE_COMPAT_FILE = 'page-dom-compat\.js'/);
});
