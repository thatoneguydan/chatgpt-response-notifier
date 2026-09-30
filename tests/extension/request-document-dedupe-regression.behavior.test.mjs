import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../../extension/delivery-dedupe-hook.js', import.meta.url), 'utf8');

function loadRequestDeliveryKey() {
  const start = source.indexOf('function requestDeliveryKey');
  const end = source.indexOf('function legacyTurnDeliveryKey', start);
  assert.ok(start >= 0 && end > start, 'request delivery key implementation was not found');
  const context = vm.createContext({});
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.requestDeliveryKey = requestDeliveryKey;`, context);
  return context.requestDeliveryKey;
}

test('same ChatGPT request keeps one durable delivery identity across Chrome document replacement', () => {
  const requestDeliveryKey = loadRequestDeliveryKey();
  const snapshot = { conversationId: 'conversation-1', requestId: 'request-1' };

  const beforeReplacement = requestDeliveryKey(snapshot, { documentId: 'document-before' });
  const afterReplacement = requestDeliveryKey(snapshot, { documentId: 'document-after' });

  assert.equal(beforeReplacement, 'request|conversation-1|request-1');
  assert.equal(afterReplacement, beforeReplacement);
  assert.doesNotMatch(beforeReplacement, /document-/);
});

test('different ChatGPT requests remain independently notifiable', () => {
  const requestDeliveryKey = loadRequestDeliveryKey();
  const first = requestDeliveryKey({ conversationId: 'conversation-1', requestId: 'request-1' }, { documentId: 'document-1' });
  const second = requestDeliveryKey({ conversationId: 'conversation-1', requestId: 'request-2' }, { documentId: 'document-1' });
  assert.notEqual(first, second);
});

test('request-key migration inspects persisted records instead of only the new key', () => {
  assert.match(source, /function matchingRequestRecord\(/);
  assert.match(source, /store\.getAll\(\)/);
  assert.match(source, /String\(record\?\.conversationId \|\| ''\) === conversationId/);
  assert.match(source, /String\(record\?\.requestId \|\| ''\) === requestId/);
});

test('repeated already-delivered diagnostics are bounded without hiding acceptance/error events', () => {
  assert.match(source, /CLAIM_DIAGNOSTIC_COALESCE_MS = 5 \* 60 \* 1000/);
  assert.match(source, /normalizedStatus === 'claim-observed'/);
  assert.match(source, /normalizedStatus === 'claim-suppressed'/);
  assert.match(source, /normalizedReason === 'already-delivered-logical-turn'/);
  assert.doesNotMatch(source, /normalizedStatus === 'claim-accepted'[^\n]*noisy/);
  assert.doesNotMatch(source, /normalizedStatus === 'claim-error'[^\n]*noisy/);
});

test('delivery dedupe runtime generation advances for the cross-document repair', () => {
  assert.match(source, /version:\s*5/);
});
