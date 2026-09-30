import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const extensionRoot = path.join(repoRoot, 'extension');
const hookSource = fs.readFileSync(path.join(extensionRoot, 'last-mile-toast-dedupe-background.js'), 'utf8');
const bootstrapSource = fs.readFileSync(path.join(extensionRoot, 'diagnostics-bootstrap.js'), 'utf8');
const recordSource = fs.readFileSync(path.join(repoRoot, 'src/ChatGPTResponseNotifier.Core/NotificationRecord.cs'), 'utf8');
const acceptedStoreSource = fs.readFileSync(path.join(repoRoot, 'src/ChatGPTResponseNotifier.Core/AcceptedNotificationStore.cs'), 'utf8');
const toastManagerSource = fs.readFileSync(path.join(repoRoot, 'src/ChatGPTResponseNotifier.Host/ToastManager.cs'), 'utf8');

function loadHook() {
  const context = {
    globalThis: {},
    notificationFromTurnRecord(record) {
      return { id: record.notificationId, conversationId: record.conversationId };
    }
  };
  context.globalThis = context;
  vm.runInNewContext(hookSource, context);
  return context;
}

test('last-mile hook survives synthetic assistant identity remounts for the same response revision', () => {
  const context = loadHook();

  const requestBacked = context.notificationFromTurnRecord({
    notificationId: 'n-1',
    conversationId: 'conversation-1',
    assistantKey: 'conversation-turn-compat-assistant-9',
    revision: '123:3acc5918',
    statusCode: 'COMPLETE_APPLIED'
  });
  const remountedFallback = context.notificationFromTurnRecord({
    notificationId: 'n-2',
    conversationId: 'conversation-1',
    assistantKey: 'conversation-turn-compat-assistant-8',
    revision: '123:3acc5918',
    statusCode: 'COMPLETE_APPLIED'
  });
  const nextResponse = context.notificationFromTurnRecord({
    notificationId: 'n-3',
    conversationId: 'conversation-1',
    assistantKey: 'conversation-turn-compat-assistant-10',
    revision: '141:8d9920aa',
    statusCode: 'COMPLETE_APPLIED'
  });

  assert.equal(requestBacked.deliveryKey, 'response-revision|conversation-1|COMPLETE_APPLIED|123:3acc5918');
  assert.equal(remountedFallback.deliveryKey, requestBacked.deliveryKey);
  assert.notEqual(nextResponse.deliveryKey, requestBacked.deliveryKey);
  assert.equal(context.__chatgptNotifierLastMileToastDedupe.version, 2);
});

test('legacy notifications without response revision retain assistant-key compatibility', () => {
  const context = loadHook();

  const legacy = context.notificationFromTurnRecord({
    notificationId: 'legacy-1',
    conversationId: 'conversation-1',
    assistantKey: 'assistant-9'
  });
  const missingIdentity = context.notificationFromTurnRecord({
    notificationId: 'legacy-2',
    conversationId: 'conversation-1'
  });

  assert.equal(legacy.deliveryKey, 'assistant|conversation-1|assistant-9');
  assert.equal(Object.hasOwn(missingIdentity, 'deliveryKey'), false);
});

test('bootstrap loads the last-mile hook after the main background runtime', () => {
  const backgroundAt = bootstrapSource.indexOf("importScripts('background.js')");
  const dedupeAt = bootstrapSource.indexOf("importScripts('last-mile-toast-dedupe-background.js')");
  assert.ok(backgroundAt >= 0);
  assert.ok(dedupeAt > backgroundAt);
});

test('native notification contract bounds response-revision idempotence to one completion window', () => {
  assert.match(recordSource, /public string DeliveryKey \{ get; init; \} = string\.Empty;/);
  assert.match(recordSource, /Notification delivery key is invalid/);
  assert.match(acceptedStoreSource, /public bool ContainsRecent\(string notificationId, TimeSpan maxAge\)/);
  assert.match(acceptedStoreSource, /item\.AcceptedAt >= cutoff/);
  assert.match(toastManagerSource, /SameCompletionDedupeWindow = TimeSpan\.FromSeconds\(30\)/);
  assert.match(toastManagerSource, /SameCompletion\(window\.Record\.CompletedAt, record\.CompletedAt\)/);
  assert.match(toastManagerSource, /ContainsRecent\(deliveryTombstone, SameCompletionDedupeWindow\)/);
  assert.match(toastManagerSource, /response-already-open/);
  assert.match(toastManagerSource, /response-already-accepted/);
  assert.match(toastManagerSource, /DeliveryTombstonePrefix = "delivery:"/);
  assert.match(toastManagerSource, /RememberAcceptance\(record\)/);

  // Existing persisted-toast restart behavior remains permanently idempotent.
  assert.match(toastManagerSource, /Restore\(\)[\s\S]*?_acceptedStore\.Contains\(deliveryTombstone\)/);
});
