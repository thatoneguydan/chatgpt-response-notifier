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
  assert.match(contentScript, /RENDER_GRACE_MS\s*=\s*650/);
  assert.match(contentScript, /scheduleCompletionFromRequest/);
});

test('current ChatGPT conversation-turn markup is accepted without old role attributes', () => {
  assert.match(contentScript, /article\[data-testid\*="conversation-turn"\]/);
  assert.match(contentScript, /\[data-testid\^="conversation-turn-"\]/);
  assert.match(contentScript, /\[data-message-author-role\], \[data-author\]/);
  assert.match(contentScript, /turn\.querySelector\('\.markdown, \[class\*="prose"\]'\)/);
  assert.match(contentScript, /chatgpt\|assistant/);
  assert.match(contentScript, /you\|user/);
});

test('real completion notifications require readable assistant text instead of generic fallback copy', () => {
  assert.doesNotMatch(contentScript, /Response finished\./);
  assert.match(contentScript, /if \(resolved\?\.response\) sendCompletion\(resolved\)/);
  assert.match(serviceWorker, /No readable assistant response was captured/);
});

test('project-aware notification metadata is captured from the exact current project route', () => {
  assert.match(contentScript, /function currentProjectId\(\)/);
  assert.match(contentScript, /function currentProjectTitle\(\)/);
  assert.match(contentScript, /const wantedPath = `\/g\/\$\{projectId\}\/project`/);
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
