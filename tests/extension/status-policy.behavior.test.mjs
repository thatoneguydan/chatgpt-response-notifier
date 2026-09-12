import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('extension/status-policy.js', root), 'utf8');

function loadPolicy() {
  const context = vm.createContext({ Date, Number, String });
  vm.runInContext(source, context);
  return context.ChatGPTNotifierContinuationPolicy;
}

const expected = {
  conversationId: 'conversation-1',
  documentId: 'document-1',
  promptKey: 'conversation-1|user-4',
  assistantKey: 'assistant-5',
  revision: '100:abc12345'
};

const current = { ...expected, statusCode: 'INCOMPLETE_LIMIT' };

test('identity match fails closed on every independently changing action boundary', () => {
  const policy = loadPolicy();
  assert.equal(policy.identityMatches(current, expected), true);
  for (const field of ['conversationId', 'documentId', 'promptKey', 'assistantKey', 'revision']) {
    assert.equal(
      policy.identityMatches({ ...current, [field]: `${current[field]}-changed` }, expected),
      false,
      `${field} change must cancel the action`
    );
  }
  assert.equal(policy.identityMatches({ ...current, statusCode: 'COMPLETE_APPLIED' }, expected), false);
});

test('drafts and recent trusted foreground activity block automation while idle/background pages do not', () => {
  const policy = loadPolicy();
  assert.equal(policy.userInteractionBlockReason({ composerText: 'my draft' }), 'composer-not-empty');
  assert.equal(policy.userInteractionBlockReason({
    composerText: '',
    documentFocused: true,
    documentVisible: true,
    lastTrustedInteractionAt: 9_000,
    now: 10_000,
    guardMs: 3_000
  }), 'active-user-interaction');
  assert.equal(policy.userInteractionBlockReason({
    documentFocused: true,
    documentVisible: true,
    lastTrustedInteractionAt: 5_000,
    now: 10_000,
    guardMs: 3_000
  }), '');
  assert.equal(policy.userInteractionBlockReason({
    documentFocused: false,
    documentVisible: false,
    lastTrustedInteractionAt: 9_900,
    now: 10_000,
    guardMs: 3_000
  }), '');
});

test('continuation acceptance requires both page-turn and request evidence in the same conversation', () => {
  const policy = loadPolicy();
  assert.deepEqual(
    { ...policy.continuationOutcome({ pageTurnConfirmed: true, requestAccepted: true, sameConversation: true }) },
    { accepted: true, reason: 'continuation-confirmed' }
  );
  assert.equal(policy.continuationOutcome({ pageTurnConfirmed: false, requestAccepted: true, sameConversation: true }).accepted, false);
  assert.equal(policy.continuationOutcome({ pageTurnConfirmed: true, requestAccepted: false, sameConversation: true }).accepted, false);
  assert.equal(policy.continuationOutcome({ pageTurnConfirmed: true, requestAccepted: true, sameConversation: false }).accepted, false);
});
