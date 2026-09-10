import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '../../extension');
const [serviceWorker, contentScript] = await Promise.all([
  readFile(path.join(extensionRoot, 'service-worker.js'), 'utf8'),
  readFile(path.join(extensionRoot, 'content-script.js'), 'utf8')
]);

test('conversation dismissal is driven by an explicit visible/focused page signal', () => {
  assert.match(contentScript, /CHATGPT_CONVERSATION_VIEWED/);
  assert.match(contentScript, /document\.visibilityState !== 'visible'/);
  assert.match(contentScript, /document\.hasFocus/);
  assert.match(serviceWorker, /CHATGPT_CONVERSATION_VIEWED/);
  assert.match(serviceWorker, /dismissReportedViewedConversation/);
  assert.doesNotMatch(serviceWorker, /chrome\.tabs\.onActivated/);
  assert.doesNotMatch(serviceWorker, /chrome\.windows\.onFocusChanged/);
});

test('tab URL navigation is a narrow fallback and tab teardown cannot dismiss by activation alone', () => {
  assert.match(serviceWorker, /if \(!changeInfo\.url \|\| !tab\.active\) return;/);
  assert.doesNotMatch(serviceWorker, /changeInfo\.status\s*!==\s*['"]complete['"]/);
});

test('native host restart reconciles the currently viewed conversation after persisted alerts restore', () => {
  assert.match(serviceWorker, /message\.type === 'host\.ready'/);
  assert.match(serviceWorker, /dismissCurrentlyViewedConversations/);
  assert.match(serviceWorker, /await ensureContentScriptsInChatgptTabs\(\)/);
  assert.match(serviceWorker, /await dismissCurrentlyViewedConversations\(\)/);
});

test('completion still starts from the upstream-proven request-complete path', () => {
  assert.match(serviceWorker, /chrome\.webRequest\.onCompleted/);
  assert.match(serviceWorker, /signalConversationRequestCompleted/);
  assert.match(contentScript, /CHATGPT_CONVERSATION_REQUEST_COMPLETED/);
  assert.match(contentScript, /REQUEST_RENDER_GRACE_MS\s*=\s*250/);
  assert.match(contentScript, /scheduleCompletionFromRequest/);
});

test('capture is restricted to the canonical conversation stream and never arbitrary articles', () => {
  assert.match(contentScript, /document\.querySelector\('main'\)/);
  assert.match(contentScript, /root\.querySelectorAll\('\[data-testid\^="conversation-turn-"\]'\)/);
  assert.doesNotMatch(contentScript, /article\[data-testid\*="conversation-turn"\]/);
  assert.match(contentScript, /const assistantIndex = turns\.length - 1/);
  assert.doesNotMatch(contentScript, /for \(let index = turns\.length - 1; index >= 0/);
});

test('final response text must stabilize before the toast is emitted', () => {
  assert.match(contentScript, /ANSWER_STABLE_MS\s*=\s*700/);
  assert.match(contentScript, /FINAL_RENDER_TIMEOUT_MS\s*=\s*8000/);
  assert.match(contentScript, /waitForStableLatestAnswer/);
  assert.match(contentScript, /finalSnapshot\.response !== text/);
  assert.match(contentScript, /if \(snapshot\?\.response\) sendCompletion\(snapshot\)/);
});

test('real completion notifications require readable assistant text instead of generic fallback copy', () => {
  assert.doesNotMatch(contentScript, /Response finished\./);
  assert.match(serviceWorker, /No readable assistant response was captured/);
});

test('project-aware notification metadata cleans the current Open <name> project control', () => {
  assert.match(contentScript, /function currentProjectId\(\)/);
  assert.match(contentScript, /function cleanProjectLabel\(rawLabel\)/);
  assert.match(contentScript, /projectTitle: currentProjectTitle\(\)/);
  assert.match(serviceWorker, /formatNotificationTitle\(message\.projectTitle, message\.sessionTitle\)/);
});

test('service worker proactively injects the current content script into already-open ChatGPT tabs', () => {
  assert.match(serviceWorker, /ensureContentScriptsInChatgptTabs/);
  assert.match(serviceWorker, /chrome\.tabs\.query\(\{ url: \['https:\/\/chatgpt\.com\/\*'\] \}\)/);
  assert.match(serviceWorker, /chrome\.scripting\.executeScript\(\{ target: \{ tabId: tab\.id \}, files: \['content-script\.js'\] \}\)/);
  assert.match(serviceWorker, /await ensureContentScriptsInChatgptTabs\(\)/);
  assert.match(serviceWorker, /ensureContentScriptsInChatgptTabs\(\)\.catch/);
});
