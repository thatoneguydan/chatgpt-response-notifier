import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '../../extension');
const projectRoot = path.resolve(extensionRoot, '..');
const [watchdog, serviceWorker, contentScript, manifestText, versionText] = await Promise.all([
  readFile(path.join(extensionRoot, 'recovery-watchdog.js'), 'utf8'),
  readFile(path.join(extensionRoot, 'service-worker.js'), 'utf8'),
  readFile(path.join(extensionRoot, 'content-script.js'), 'utf8'),
  readFile(path.join(extensionRoot, 'manifest.json'), 'utf8'),
  readFile(path.join(projectRoot, 'VERSION.txt'), 'utf8')
]);
const manifest = JSON.parse(manifestText);
const version = versionText.trim();

test('recovery watchdog is loaded with the main content script and release versions stay aligned', () => {
  assert.equal(manifest.version, version);
  assert.deepEqual(manifest.content_scripts[0]?.js, ['content-script.js', 'recovery-watchdog.js']);
  assert.match(serviceWorker, /files: \['content-script\.js', 'recovery-watchdog\.js'\]/);
});

test('known backend disconnect messages start bounded recovery', () => {
  assert.match(watchdog, /connection interrupted/);
  assert.match(watchdog, /delivery failed/);
  assert.match(watchdog, /our systems are taking longer/);
  assert.match(watchdog, /sessionStorage\.setItem\(STORAGE_KEY/);
  assert.match(watchdog, /RETRY_INTERVAL_MS = 60000/);
  assert.match(watchdog, /MAX_AUTO_RELOADS = 5/);
  assert.match(watchdog, /MAX_RECOVERY_WINDOW_MS = 6 \* 60 \* 1000/);
  assert.match(watchdog, /location\.reload\(\)/);
});

test('maximum-conversation-length failures notify immediately instead of entering a reload loop', () => {
  assert.match(watchdog, /maximum length for this conversation/);
  assert.match(watchdog, /the conversation is too long/);
  assert.match(watchdog, /conversation has reached its maximum length/);
  assert.match(watchdog, /terminal: true/);
  assert.match(watchdog, /if \(failure\?\.terminal\) \{/);
  assert.match(watchdog, /notifyAttention\(state, failure\)/);
  assert.match(watchdog, /This conversation cannot continue here/);
});

test('weak markerless captures fail closed and hand off to bounded recovery', () => {
  assert.match(contentScript, /MIN_TRUSTED_MARKERLESS_RESPONSE_CHARS = 80/);
  assert.match(contentScript, /function hasTrustworthyMarkerlessCapture\(snapshot\)/);
  assert.match(contentScript, /snapshot\.captureSource === 'whole-turn'/);
  assert.match(contentScript, /markerless-capture-untrusted/);
  assert.match(contentScript, /chatgpt-native-notifier-recovery-needed/);
  assert.match(watchdog, /RECOVERY_REQUEST_EVENT = 'chatgpt-native-notifier-recovery-needed'/);
  assert.match(watchdog, /document\.addEventListener\(RECOVERY_REQUEST_EVENT, signalUntrustedCaptureRecovery, true\)/);
});

test('quoted failure text in user messages is ignored', () => {
  assert.match(watchdog, /roleOfTurn\(turn\) === 'user'/);
  assert.match(watchdog, /const turn = newestTurn\(\)/);
  assert.match(watchdog, /if \(turn && roleOfTurn\(turn\) !== 'user'\)/);
});

test('successful final response clears any recovery loop', () => {
  assert.match(watchdog, /function finalActionKind\(\)/);
  assert.match(watchdog, /copy-turn-action-button/);
  assert.match(watchdog, /good-response-turn-action-button/);
  assert.match(watchdog, /if \(finalActionKind\(\)\) \{/);
  assert.match(watchdog, /clearState\(\)/);
});

test('exhausted recovery escalates to a persistent native attention toast', () => {
  assert.match(watchdog, /CHATGPT_RECOVERY_ATTENTION/);
  assert.match(watchdog, /Automatic recovery tried/);
  assert.match(watchdog, /This chat still appears incomplete/);
  assert.match(serviceWorker, /message\?\.type === 'CHATGPT_RECOVERY_ATTENTION'/);
  assert.match(serviceWorker, /ChatGPT needs attention/);
  assert.match(serviceWorker, /toast\.show/);
});

test('only deliberate click-or-keyboard interaction resolves recovery alerts; scrolling does not', () => {
  assert.match(watchdog, /document\.addEventListener\('pointerdown', signalDeliberateInteraction, true\)/);
  assert.match(watchdog, /document\.addEventListener\('keydown', signalDeliberateInteraction, true\)/);
  assert.doesNotMatch(watchdog, /addEventListener\('wheel'/);
  assert.match(watchdog, /CHATGPT_CONVERSATION_USER_INTERACTED/);
  assert.match(serviceWorker, /CHATGPT_CONVERSATION_USER_INTERACTED/);
  assert.doesNotMatch(serviceWorker, /message\?\.type === 'CHATGPT_CONVERSATION_INTERACTED'/);
});

test('toast click still foregrounds the matching Chrome window', () => {
  assert.match(serviceWorker, /function foregroundChromeWindow\(windowId\)/);
  assert.match(serviceWorker, /chrome\.windows\.update\(windowId, \{ focused: true \}\)/);
  assert.match(serviceWorker, /chrome\.tabs\.update\(existing\.id, \{ active: true \}\)/);
  assert.match(serviceWorker, /message\.type === 'toast\.clicked'/);
});
