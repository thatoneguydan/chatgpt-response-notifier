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
