import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root), 'utf8');
const manifest = JSON.parse(read('extension/manifest.json'));
const domCompat = read('extension/page-dom-compat.js');
const runtimeCompat = read('extension/page-runtime-compat-background.js');
const refreshPolicy = read('extension/recovery-refresh-policy-background.js');
const bootstrap = read('extension/diagnostics-bootstrap.js');

test('current ChatGPT UI compatibility loads before page readers and stays page-local', () => {
  assert.equal(manifest.version, '0.9.82');
  assert.equal(manifest.content_scripts[0].js[0], 'page-dom-compat.js');
  assert.match(domCompat, /data-message-author-role=\\?"user\\?"/);
  assert.match(domCompat, /data-message-author-role=\\?"assistant\\?"/);
  assert.match(domCompat, /contenteditable=\\?"true\\?"\]\[role=\\?"textbox\\?"\]/);
  assert.match(domCompat, /fallbackSend/);
  assert.match(domCompat, /fallbackStop/);
  assert.doesNotMatch(domCompat, /\bfetch\s*\(|XMLHttpRequest|WebSocket|backend-api|\/conversation\b/);

  const context = vm.createContext({ globalThis: null });
  context.globalThis = context;
  vm.runInContext(domCompat, context);
});

test('programmatic reinjection prepends the page adapter and all recovery reloads bypass cache', async () => {
  const executeCalls = [];
  const reloadCalls = [];
  const scripting = {
    async executeScript(details) {
      executeCalls.push(details);
      return [];
    }
  };
  const tabs = {
    async reload(tabId, details) {
      reloadCalls.push({ tabId, details });
    }
  };
  const context = vm.createContext({
    globalThis: null,
    chrome: { scripting, tabs },
    Set,
    Object,
    Array,
    String
  });
  context.globalThis = context;
  vm.runInContext(runtimeCompat, context);

  await context.chrome.scripting.executeScript({ target: { tabId: 7 }, files: ['status-script.js'] });
  assert.deepEqual([...executeCalls[0].files], ['page-dom-compat.js', 'status-script.js']);

  await context.chrome.tabs.reload(7);
  assert.equal(reloadCalls.length, 1);
  assert.equal(reloadCalls[0].tabId, 7);
  assert.equal(reloadCalls[0].details.bypassCache, true);
});

test('recovery hard-refresh cadence is persistently gated to at least sixty seconds', () => {
  const originalPolicy = Object.freeze({
    thresholds: Object.freeze({ profileActionSpacingMs: 30_000 }),
    marker: 'policy'
  });
  const originalModel = Object.freeze({
    thresholds: Object.freeze({ profileActionSpacingMs: 30_000 }),
    marker: 'model'
  });
  const context = vm.createContext({
    globalThis: null,
    ChatGPTNotifierContinuationPolicy: originalPolicy,
    ChatGPTNotifierRecoveryModel: originalModel,
    Object,
    Number,
    Math
  });
  context.globalThis = context;
  vm.runInContext(refreshPolicy, context);

  assert.equal(context.ChatGPTNotifierContinuationPolicy.thresholds.profileActionSpacingMs, 60_000);
  assert.equal(context.ChatGPTNotifierRecoveryModel.thresholds.profileActionSpacingMs, 60_000);
  assert.equal(context.__chatgptNotifierRecoveryRefreshPolicy.minHardReloadSpacingMs, 60_000);
  assert.equal(context.__chatgptNotifierRecoveryRefreshPolicy.bypassCacheRequired, true);
});

test('service worker installs injection compatibility before background and refresh policy after it', () => {
  const compatAt = bootstrap.indexOf("importScripts('page-runtime-compat-background.js')");
  const backgroundAt = bootstrap.indexOf("importScripts('background.js')");
  const refreshAt = bootstrap.indexOf("importScripts('recovery-refresh-policy-background.js')");
  assert.ok(compatAt >= 0 && backgroundAt > compatAt && refreshAt > backgroundAt);
  assert.doesNotMatch(runtimeCompat, /\bfetch\s*\(|XMLHttpRequest|WebSocket|backend-api/);
  assert.doesNotMatch(refreshPolicy, /\bfetch\s*\(|XMLHttpRequest|WebSocket|backend-api/);
});
