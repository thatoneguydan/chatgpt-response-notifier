import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '../../extension');
const [watchdog, serviceWorker, manifest] = await Promise.all([
  readFile(path.join(extensionRoot, 'recovery-watchdog.js'), 'utf8'),
  readFile(path.join(extensionRoot, 'service-worker.js'), 'utf8'),
  readFile(path.join(extensionRoot, 'manifest.json'), 'utf8')
]);

test('recovery watchdog is loaded with the main content script', () => {
  assert.match(manifest, /"version": "0\.2\.13"/);
  assert.match(manifest, /"js": \["content-script\.js", "recovery-watchdog\.js"\]/);
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

test('only deliberate click-or-keyboard interaction resolves alerts; scrolling does not', () => {
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
