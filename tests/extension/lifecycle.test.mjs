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

test('completion capture follows the pinned upstream v1.0.8 request-complete path', () => {
  assert.match(contentScript, /cbe00dcfcff8a571f407c6109ed4d5f97cef60a9/);
  assert.match(contentScript, /message\?\.type === 'CHATGPT_CONVERSATION_REQUEST_COMPLETED'\) armForCurrentPrompt\(\)/);
  assert.match(contentScript, /const snapshot = latestPromptSnapshot\(\);/);
  assert.match(contentScript, /if \(snapshot\?\.response\) \{\s*sendCompletion\(snapshot\);\s*return;/);
  assert.match(contentScript, /const rendered = roleNode\.querySelector\('\.markdown, \[class\*=\"prose\"\]'\)/);
  assert.match(contentScript, /const immediate = answerBoundToLatestPrompt\(\);\s*if \(immediate\) return Promise\.resolve\(immediate\);/);
});

test('experimental UI lifecycle and stabilization heuristics are absent from completion capture', () => {
  assert.doesNotMatch(contentScript, /isGenerationInProgress/);
  assert.doesNotMatch(contentScript, /startGenerationLifecycleObserver/);
  assert.doesNotMatch(contentScript, /generationWasActive/);
  assert.doesNotMatch(contentScript, /ANSWER_STABLE_MS/);
  assert.doesNotMatch(contentScript, /NETWORK_FALLBACK_DELAY_MS/);
  assert.doesNotMatch(contentScript, /scheduleNetworkFallback/);
  assert.doesNotMatch(contentScript, /snapshotFingerprint/);
});

test('service worker proactively injects the current content script into already-open ChatGPT tabs', () => {
  assert.match(serviceWorker, /ensureContentScriptsInChatgptTabs/);
  assert.match(serviceWorker, /chrome\.tabs\.query\(\{ url: \['https:\/\/chatgpt\.com\/\*'\] \}\)/);
  assert.match(serviceWorker, /chrome\.scripting\.executeScript\(\{ target: \{ tabId: tab\.id \}, files: \['content-script\.js'\] \}\)/);
  assert.match(serviceWorker, /await ensureContentScriptsInChatgptTabs\(\)/);
  assert.match(serviceWorker, /ensureContentScriptsInChatgptTabs\(\)\.catch/);
});
