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

test('legacy page-interaction signals cannot dismiss alerts after the 0.2.13 lifecycle split', () => {
  assert.match(contentScript, /CHATGPT_CONVERSATION_INTERACTED/);
  assert.doesNotMatch(serviceWorker, /message\?\.type === 'CHATGPT_CONVERSATION_INTERACTED'/);
  assert.match(serviceWorker, /CHATGPT_CONVERSATION_USER_INTERACTED/);
  assert.match(serviceWorker, /dismissReportedUserInteraction/);
  assert.doesNotMatch(contentScript, /CHATGPT_CONVERSATION_VIEWED/);
  assert.doesNotMatch(contentScript, /scheduleViewedSignal/);
});

test('focus, activation, navigation, and helper restart do not clear unresolved alerts', () => {
  assert.doesNotMatch(contentScript, /document\.visibilityState/);
  assert.doesNotMatch(contentScript, /window\.addEventListener\('focus'/);
  assert.doesNotMatch(contentScript, /window\.addEventListener\('pageshow'/);
  assert.doesNotMatch(serviceWorker, /isTabActuallyViewed/);
  assert.doesNotMatch(serviceWorker, /dismissCurrentlyViewedConversations/);
  assert.doesNotMatch(serviceWorker, /chrome\.tabs\.onUpdated/);
  assert.doesNotMatch(serviceWorker, /chrome\.tabs\.onActivated/);
  assert.doesNotMatch(serviceWorker, /chrome\.windows\.onFocusChanged/);
  assert.match(serviceWorker, /message\.type === 'host\.ready'/);
  assert.match(serviceWorker, /await ensureContentScriptsInChatgptTabs\(\)/);
});

test('toast click activates the matching tab and foregrounds its Chrome window', () => {
  assert.match(serviceWorker, /function foregroundChromeWindow\(windowId\)/);
  assert.match(serviceWorker, /windowInfo\.state === 'minimized'/);
  assert.match(serviceWorker, /chrome\.windows\.update\(windowId, \{ state: 'normal' \}\)/);
  assert.match(serviceWorker, /chrome\.windows\.update\(windowId, \{ focused: true \}\)/);
  assert.match(serviceWorker, /chrome\.tabs\.update\(existing\.id, \{ active: true \}\)/);
  assert.match(serviceWorker, /await foregroundChromeWindow\(existing\.windowId\)/);
  assert.match(serviceWorker, /message\.type === 'toast\.clicked'/);
  assert.match(serviceWorker, /await focusOrOpenConversation\(conversationId, conversationUrl\)/);
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

test('assistant capture evaluates the whole newest turn instead of one nested role node', () => {
  assert.match(contentScript, /function assistantCapture\(turn\)/);
  assert.match(contentScript, /turn\.querySelectorAll\('\.markdown, \[class\*="prose"\]'\)/);
  assert.match(contentScript, /turn\.querySelectorAll\('\[data-message-author-role="assistant"\], \[data-author="assistant"\]'\)/);
  assert.match(contentScript, /source: 'whole-turn'/);
  assert.match(contentScript, /candidates\.sort\(\(left, right\) => right\.text\.length - left\.text\.length\)/);
  assert.doesNotMatch(contentScript, /const scope = directAssistant \|\| turn/);
});

test('real completion follows available live ChatGPT streaming state with a conservative markerless fallback', () => {
  assert.match(contentScript, /function hasVisibleStopButton\(\)/);
  assert.match(contentScript, /button\[data-testid="stop-button"\]/);
  assert.match(contentScript, /button\[data-testid="fruitjuice-stop-button"\]/);
  assert.match(contentScript, /function hasBusyAssistantSignal\(turn\)/);
  assert.match(contentScript, /aria-busy="true"/);
  assert.match(contentScript, /function hasResultStreamingSignal\(turn\)/);
  assert.match(contentScript, /\.result-streaming/);
  assert.match(contentScript, /generationActive: stopButtonActive \|\| assistantBusy \|\| resultStreamingActive/);
  assert.match(contentScript, /ANSWER_STABLE_AFTER_GENERATION_MS\s*=\s*1200/);
  assert.match(contentScript, /ANSWER_STABLE_WITHOUT_GENERATION_MARKER_MS\s*=\s*45000/);
  assert.match(contentScript, /waitForCompletedLatestAnswer/);
});

test('formatted response DOM and final-state transitions participate in the stability fingerprint', () => {
  assert.match(contentScript, /function responseRenderSignature\(turn, response\)/);
  assert.match(contentScript, /String\(node\.innerHTML \|\| ''\)\.length/);
  assert.match(contentScript, /function completionSettleSignature\(snapshot\)/);
  assert.match(contentScript, /snapshot\.finalActionKind/);
  assert.match(contentScript, /snapshot\.generationActive/);
  assert.match(contentScript, /lastSettleSignature/);
  assert.match(contentScript, /finalSettleSignature !== settleSignature/);
  assert.doesNotMatch(contentScript, /let lastText = ''/);
  assert.doesNotMatch(contentScript, /let lastSignature = ''/);
});

test('busy-state detection checks the whole latest turn', () => {
  assert.match(contentScript, /turn\.getAttribute\?\.\('aria-busy'\) === 'true'/);
  assert.match(contentScript, /turn\.querySelector\?\.\('\[aria-busy="true"\]'\)/);
  assert.doesNotMatch(contentScript, /const scope = directAssistant \|\| turn/);
});

test('current final response actions provide optional fast completion confirmation', () => {
  assert.match(contentScript, /function finalResponseActionKind\(turn\)/);
  assert.match(contentScript, /good-response-turn-action-button/);
  assert.match(contentScript, /bad-response-turn-action-button/);
  assert.match(contentScript, /copy-turn-action-button/);
  assert.match(contentScript, /Good response/);
  assert.match(contentScript, /Bad response/);
  assert.match(contentScript, /Copy response/);
  assert.match(contentScript, /finalActionReady: Boolean\(finalActionKind\)/);
  assert.match(contentScript, /ANSWER_STABLE_AFTER_FINAL_ACTION_MS\s*=\s*500/);
  assert.match(contentScript, /if \(snapshot\?\.finalActionReady\) return ANSWER_STABLE_AFTER_FINAL_ACTION_MS/);
  assert.doesNotMatch(contentScript, /buttons\.some\(\(button\) => !button\.disabled && isRenderedElement\(button\)\)/);
});

test('completion watcher observes page-wide generation and final-action transitions', () => {
  assert.match(contentScript, /const observedRoot = document\.body \|\| document\.documentElement \|\| root/);
  assert.match(contentScript, /observer\.observe\(observedRoot/);
  assert.match(contentScript, /'data-testid'/);
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
  assert.match(contentScript, /captureSource/);
  assert.match(contentScript, /turnTextLength/);
  assert.match(contentScript, /responseSurfaceCount/);
  assert.match(contentScript, /assistantRoleNodeCount/);
  assert.match(contentScript, /renderSignatureLength/);
  assert.match(contentScript, /generationActive/);
  assert.match(contentScript, /generationObserved/);
  assert.match(contentScript, /resultStreamingActive/);
  assert.match(contentScript, /finalActionKind/);
  assert.match(contentScript, /GET_CHATGPT_CAPTURE_DIAGNOSTIC/);
  assert.match(popupHtml, /id="captureStatus"/);
  assert.match(popupJs, /GET_CHATGPT_CAPTURE_DIAGNOSTIC/);
  assert.match(popupJs, /source /);
  assert.match(popupJs, /surfaces /);
  assert.match(popupJs, /assistant nodes /);
  assert.match(popupJs, /render /);
  assert.match(popupJs, /streaming seen/);
  assert.match(popupJs, /result streaming/);
  assert.match(popupJs, /final marker /);
  assert.match(popupJs, /capture\.finalActionKind \|\| 'none'/);
  assert.doesNotMatch(popupJs, /capture\.response\b/);
});

test('service worker proactively injects both current content scripts into already-open ChatGPT tabs', () => {
  assert.match(serviceWorker, /ensureContentScriptsInChatgptTabs/);
  assert.match(serviceWorker, /chrome\.tabs\.query\(\{ url: \['https:\/\/chatgpt\.com\/\*'\] \}\)/);
  assert.match(serviceWorker, /files: \['content-script\.js', 'recovery-watchdog\.js'\]/);
  assert.match(serviceWorker, /await ensureContentScriptsInChatgptTabs\(\)/);
  assert.match(serviceWorker, /ensureContentScriptsInChatgptTabs\(\)\.catch/);
});
