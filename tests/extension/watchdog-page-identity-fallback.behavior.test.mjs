import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');

test('due watchdog falls back to persisted prompt identity when the live page temporarily cannot expose one', () => {
  const status = readText('extension/status-script.js');

  assert.match(status, /async function persistedWatchdogPromptKey\(conversationId\)/);
  assert.match(status, /type:\s*'GET_BUILD_AUTOMATION_OVERVIEW_FOR_SENDER'/);
  assert.match(status, /String\(overview\?\.activeConversationId \|\| ''\) !== expectedConversationId/);
  assert.match(status, /String\(watchdog\?\.conversationId \|\| ''\) !== expectedConversationId/);
  assert.match(status, /watchdog\?\.stopped === true/);
  assert.match(status, /promptKey = await persistedWatchdogPromptKey\(conversationId\)/);
  assert.match(status, /const authorizedPromptKey = String\(authorization\?\.promptKey \|\| expectedPromptKey \|\| ''\)/);
  assert.match(status, /performWatchdogContinuationRaw\(expectedConversationId, authorizedPromptKey/);
  assert.match(status, /finalizeWatchdogAuthorization\(expectedConversationId, authorizedPromptKey/);
});

test('persisted prompt fallback tolerates only missing DOM identity, never a conflicting live prompt', () => {
  const status = readText('extension/status-script.js');

  assert.match(status, /if \(expectedPrompt && initialPromptKey && initialPromptKey !== expectedPrompt\)/);
  assert.match(status, /if \(expectedPrompt && beforeSendPromptKey && beforeSendPromptKey !== expectedPrompt\)/);
  assert.doesNotMatch(status, /if \(expectedPrompt && initialPromptKey !== expectedPrompt\)/);
  assert.doesNotMatch(status, /if \(expectedPrompt && beforeSendPromptKey !== expectedPrompt\)/);
});
