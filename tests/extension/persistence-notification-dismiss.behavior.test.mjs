import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const persistenceSource = fs.readFileSync(new URL('../../extension/persistence-script.js', import.meta.url), 'utf8');
const workerSource = fs.readFileSync(new URL('../../extension/service-worker.js', import.meta.url), 'utf8');

test('generic ChatGPT pointer and keyboard activity cannot dismiss native completion notifications', () => {
  assert.equal(persistenceSource.includes('pointerdown'), false);
  assert.equal(persistenceSource.includes('keydown'), false);
  assert.equal(persistenceSource.includes('CHATGPT_CONVERSATION_USER_INTERACTED'), false);
  assert.match(persistenceSource, /genericInteractionDismissRetired:\s*true/);
});

test('toast dismissal remains available only through explicit worker-side notification actions', () => {
  assert.match(workerSource, /toast\.dismissConversation/);
  assert.match(workerSource, /click-presentation-complete/);
});
