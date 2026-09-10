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
  assert.match(serviceWorker, /await dismissCurrentlyViewedConversations\(\)/);
});

test('completion capture is driven by the visible generation lifecycle', () => {
  assert.match(contentScript, /isGenerationInProgress/);
  assert.match(contentScript, /stop-button/);
  assert.match(contentScript, /fruitjuice-stop-button/);
  assert.match(contentScript, /startGenerationLifecycleObserver/);
  assert.match(contentScript, /generationWasActive/);
  assert.match(contentScript, /if \(!generationWasActive\) return;/);
  assert.match(contentScript, /armForCurrentPrompt\(\)/);
});

test('network completion is fallback-only and cannot finalize while generation is visibly active', () => {
  assert.match(contentScript, /NETWORK_FALLBACK_DELAY_MS\s*=\s*2500/);
  assert.match(contentScript, /scheduleNetworkFallback/);
  assert.match(contentScript, /if \(isGenerationInProgress\(\)\) \{/);
  assert.match(contentScript, /generationWasActive = true/);
  assert.match(contentScript, /message\?\.type === 'CHATGPT_CONVERSATION_REQUEST_COMPLETED'\) scheduleNetworkFallback\(\)/);
});

test('completion capture aggregates rendered blocks and waits for stable final text after generation ends', () => {
  assert.match(contentScript, /querySelectorAll\('\.markdown'\)/);
  assert.match(contentScript, /renderedNodes[\s\S]*\.map\(\(node\)/);
  assert.match(contentScript, /fullText\.length > renderedText\.length \+ 80/);
  assert.match(contentScript, /ANSWER_STABLE_MS\s*=\s*1200/);
  assert.match(contentScript, /stableTimerId/);
  assert.match(contentScript, /snapshotFingerprint/);
  assert.doesNotMatch(contentScript, /if \(immediate\?\.response\) return Promise\.resolve\(immediate\)/);
});

test('service worker proactively injects the current content script into already-open ChatGPT tabs', () => {
  assert.match(serviceWorker, /ensureContentScriptsInChatgptTabs/);
  assert.match(serviceWorker, /chrome\.tabs\.query\(\{ url: \['https:\/\/chatgpt\.com\/\*'\] \}\)/);
  assert.match(serviceWorker, /chrome\.scripting\.executeScript\(\{ target: \{ tabId: tab\.id \}, files: \['content-script\.js'\] \}\)/);
  assert.match(serviceWorker, /await ensureContentScriptsInChatgptTabs\(\)/);
  assert.match(serviceWorker, /ensureContentScriptsInChatgptTabs\(\)\.catch/);
});
