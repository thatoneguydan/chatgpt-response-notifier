import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const monitorSource = read('extension/monitor-background.js');
const routeRefreshSource = read('extension/automation-route-refresh.js');
const manifest = JSON.parse(read('extension/manifest.json'));

test('automation enrollment is durable and keyed independently by conversation', () => {
  assert.match(monitorSource, /createObjectStore\(ENROLLMENT_STORE, \{ keyPath: 'conversationId' \}\)/);
  assert.match(monitorSource, /async function getEnrollment\(conversationId\)/);
  assert.match(monitorSource, /conversationId: identity\.id/);
  assert.match(monitorSource, /userPaused: paused/);
  assert.match(monitorSource, /operator-pause/);
  assert.match(monitorSource, /const enrollment = active\?\.id \? await getEnrollment\(active\.id\) : null/);
});

test('chat route changes invalidate only notifier state UI so the next render reads that chat state', () => {
  assert.doesNotThrow(() => new vm.Script(routeRefreshSource));
  assert.match(routeRefreshSource, /AUTOMATION_UI_SELECTOR = '\[data-chatgpt-notifier-automation-ui-owner\]'/);
  assert.match(routeRefreshSource, /nextConversationId === activeConversationId/);
  assert.match(routeRefreshSource, /invalidateAutomationUi\(\)/);
  assert.match(routeRefreshSource, /MutationObserver\(scheduleSync\)/);
  assert.match(routeRefreshSource, /navigatesuccess/);
  assert.doesNotMatch(routeRefreshSource, /fetch\s*\(|XMLHttpRequest|WebSocket|tabs\.update|windows\.update/);
});

test('route refresh is a dedicated document-start content script without changing the canonical automation bundle', () => {
  const entry = manifest.content_scripts.find((item) => Array.isArray(item.js) && item.js.length === 1 && item.js[0] === 'automation-route-refresh.js');
  assert.ok(entry);
  assert.equal(entry.run_at, 'document_start');
  assert.deepEqual(entry.matches, ['https://chatgpt.com/*']);
});
