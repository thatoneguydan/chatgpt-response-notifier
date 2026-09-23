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
const toastManagerSource = fs.readFileSync(path.join(repoRoot, 'src/ChatGPTResponseNotifier.Host/ToastManager.cs'), 'utf8');

test('last-mile hook attaches one stable delivery key per assistant response', () => {
  const context = {
    globalThis: {},
    notificationFromTurnRecord(record) {
      return { id: record.notificationId, conversationId: record.conversationId };
    }
  };
  context.globalThis = context;
  vm.runInNewContext(hookSource, context);

  const first = context.notificationFromTurnRecord({
    notificationId: 'n-1',
    conversationId: 'conversation-1',
    assistantKey: 'assistant-9'
  });
  const retry = context.notificationFromTurnRecord({
    notificationId: 'n-2',
    conversationId: 'conversation-1',
    assistantKey: 'assistant-9'
  });
  const nextResponse = context.notificationFromTurnRecord({
    notificationId: 'n-3',
    conversationId: 'conversation-1',
    assistantKey: 'assistant-10'
  });

  assert.equal(first.deliveryKey, 'assistant|conversation-1|assistant-9');
  assert.equal(retry.deliveryKey, first.deliveryKey);
  assert.notEqual(nextResponse.deliveryKey, first.deliveryKey);
});

test('notifications without assistant identity remain compatible', () => {
  const context = {
    globalThis: {},
    notificationFromTurnRecord(record) {
      return { id: record.notificationId, conversationId: record.conversationId };
    }
  };
  context.globalThis = context;
  vm.runInNewContext(hookSource, context);

  const legacy = context.notificationFromTurnRecord({
    notificationId: 'legacy-1',
    conversationId: 'conversation-1'
  });

  assert.equal(Object.hasOwn(legacy, 'deliveryKey'), false);
});

test('bootstrap loads the last-mile hook after the main background runtime', () => {
  const backgroundAt = bootstrapSource.indexOf("importScripts('background.js')");
  const dedupeAt = bootstrapSource.indexOf("importScripts('last-mile-toast-dedupe-background.js')");
  assert.ok(backgroundAt >= 0);
  assert.ok(dedupeAt > backgroundAt);
});

test('native notification contract and toast manager enforce delivery-key idempotence', () => {
  assert.match(recordSource, /public string DeliveryKey \{ get; init; \} = string\.Empty;/);
  assert.match(recordSource, /Notification delivery key is invalid/);
  assert.match(toastManagerSource, /response-already-open/);
  assert.match(toastManagerSource, /response-already-accepted/);
  assert.match(toastManagerSource, /DeliveryTombstonePrefix = "delivery:"/);
  assert.match(toastManagerSource, /RememberAcceptance\(record\)/);
});
