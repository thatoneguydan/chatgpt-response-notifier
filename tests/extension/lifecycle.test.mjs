import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '../../extension');
const [serviceWorker, contentScript, popupHtml, popupJs] = await Promise.all([
  readFile(path.join(extensionRoot, 'service-worker.js'), 'utf8'),
  readFile(path.join(extensionRoot, 'content-script.js'), 'utf8'),
  readFile(path.join(extensionRoot, 'popup.html'), 'utf8'),
  readFile(path.join(extensionRoot, 'popup.js'), 'utf8')
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
  assert.match(contentScript, /REQUEST_RENDER_GRACE_MS\s*=\s*100/);
  assert.match(contentScript, /scheduleCompletionFromRequest/);
});

test('capture is restricted to the canonical newest conversation turn', () => {
  assert.match(contentScript, /document\.querySelector\('main'\)/);
  assert.match(contentScript, /root\.querySelectorAll\('\[data-testid\^="conversation-turn-"\]'\)/);
  assert.doesNotMatch(contentScript, /article\[data-testid\*="conversation-turn"\]/);
  assert.match(contentScript, /const assistantIndex = turns\.length - 1/);
  assert.doesNotMatch(contentScript, /for \(let index = turns\.length - 1; index >= 0/);
});

test('real completion follows live ChatGPT streaming state instead of requiring a Copy action', () => {
  assert.match(contentScript, /function hasVisibleStopButton\(\)/);
  assert.match(contentScript, /button\[data-testid="stop-button"\]/);
  assert.match(contentScript, /button\[data-testid="fruitjuice-stop-button"\]/);
  assert.match(contentScript, /function hasBusyAssistantSignal\(turn\)/);
  assert.match(contentScript, /aria-busy="true"/);
  assert.match(contentScript, /generationActive: stopButtonActive \|\| assistantBusy/);
  assert.match(contentScript, /ANSWER_STABLE_AFTER_GENERATION_MS\s*=\s*1200/);
  assert.match(contentScript, /ANSWER_STABLE_WITHOUT_GENERATION_MARKER_MS\s*=\s*2500/);
  assert.match(contentScript, /waitForCompletedLatestAnswer/);
  assert.doesNotMatch(contentScript, /if \(!text \|\| !snapshot\?\.finalActionReady\)/);
});

test('final response action remains an optional fast confirmation', () => {
  assert.match(contentScript, /function hasFinalResponseAction\(turn\)/);
  assert.match(contentScript, /copy-turn-action-button/);
  assert.match(contentScript, /Copy response/);
  assert.match(contentScript, /ANSWER_STABLE_AFTER_FINAL_ACTION_MS\s*=\s*500/);
  assert.match(contentScript, /if \(snapshot\?\.finalActionReady\) return ANSWER_STABLE_AFTER_FINAL_ACTION_MS/);
  assert.match(contentScript, /if \(snapshot\.generationActive && !snapshot\.finalActionReady\) return;/);
});

test('completion watcher observes page-wide stop-button and turn-local busy transitions', () => {
  assert.match(contentScript, /const observedRoot = document\.body \|\| document\.documentElement \|\| root/);
  assert.match(contentScript, /observer\.observe\(observedRoot/);
  assert.match(contentScript, /'aria-busy'/);
  assert.match(contentScript, /generationObserved = true/);
  assert.match(contentScript, /cancelActiveCompletionWait/);
});

test('timeout fails closed while generation remains active or response is empty', () => {
  assert.match(contentScript, /timeout-still-generating-or-empty/);
  assert.match(contentScript, /!finalSnapshot\.generationActive \|\| finalSnapshot\.finalActionReady/);
  assert.doesNotMatch(contentScript, /Response finished\./);
  assert.match(serviceWorker, /No readable assistant response was captured/);
});

test('project-aware notification metadata cleans the current Open <name> project control', () => {
  assert.match(contentScript, /function currentProjectId\(\)/);
  assert.match(contentScript, /function cleanProjectLabel\(rawLabel\)/);
  assert.match(contentScript, /\^Open\\s\+\(\.\+\?\)\\s\+project/);
  assert.match(contentScript, /projectTitle: currentProjectTitle\(\)/);
  assert.match(serviceWorker, /formatNotificationTitle\(message\.projectTitle, message\.sessionTitle\)/);
});

test('popup exposes bounded local capture diagnostics without logging response text', () => {
  assert.match(contentScript, /lastCaptureDiagnostic/);
  assert.match(contentScript, /responseLength/);
  assert.match(contentScript, /generationActive/);
  assert.match(contentScript, /generationObserved/);
  assert.match(contentScript, /finalActionReady/);
  assert.match(contentScript, /GET_CHATGPT_CAPTURE_DIAGNOSTIC/);
  assert.match(popupHtml, /id="captureStatus"/);
  assert.match(popupJs, /GET_CHATGPT_CAPTURE_DIAGNOSTIC/);
  assert.match(popupJs, /streaming seen/);
  assert.match(popupJs, /final marker/);
  assert.doesNotMatch(popupJs, /capture\.response\b/);
});

test('service worker proactively injects the current content script into already-open ChatGPT tabs', () => {
  assert.match(serviceWorker, /ensureContentScriptsInChatgptTabs/);
  assert.match(serviceWorker, /chrome\.tabs\.query\(\{ url: \['https:\/\/chatgpt\.com\/\*'\] \}\)/);
  assert.match(serviceWorker, /chrome\.scripting\.executeScript\(\{ target: \{ tabId: tab\.id \}, files: \['content-script\.js'\] \}\)/);
  assert.match(serviceWorker, /await ensureContentScriptsInChatgptTabs\(\)/);
  assert.match(serviceWorker, /ensureContentScriptsInChatgptTabs\(\)\.catch/);
});
