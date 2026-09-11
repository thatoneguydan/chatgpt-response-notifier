import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root));
const text = (relative) => read(relative).toString('utf8');

function gitBlobSha(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(buffer).digest('hex');
}

test('completion content script remains upstream 1.0.8', () => {
  const checkoutText = text('extension/content-script.js');
  const repositoryBytes = Buffer.from(checkoutText.replace(/\r\n/g, '\n'), 'utf8');
  assert.equal(
    gitBlobSha(repositoryBytes),
    'fcea2bd286e1436d94addd9fe8c3b79feb0ad919',
    'content-script.js must remain identical to ramhaidar upstream revision cbe00dcfcff8a571f407c6109ed4d5f97cef60a9 apart from checkout line-ending conversion'
  );
});

test('service worker observes ChatGPT traffic but never creates ChatGPT HTTP traffic', () => {
  const worker = text('extension/service-worker.js');
  assert.match(worker, /chrome\.webRequest\.onCompleted\.addListener/);
  assert.match(worker, /signalConversationRequestCompleted\(details\.tabId\)/);
  assert.doesNotMatch(worker, /\bfetch\s*\(/);
  assert.doesNotMatch(worker, /api\/auth\/session/i);
  assert.doesNotMatch(worker, /onBeforeSendHeaders/);
  assert.doesNotMatch(worker, /server-capture/i);
  assert.doesNotMatch(worker, /recovery-watchdog/i);
});

test('refresh/reopen recovery stays local and only observes existing ChatGPT traffic', () => {
  const wrapper = text('extension/background.js');
  const recoveryBackground = text('extension/recovery-background.js');
  const recoveryScript = text('extension/recovery-script.js');

  assert.match(wrapper, /importScripts\(['"]service-worker\.js['"],\s*['"]recovery-background\.js['"]\)/);
  assert.match(recoveryBackground, /chrome\.webRequest\.onBeforeRequest\.addListener/);
  assert.match(recoveryBackground, /indexedDB\.open/);
  assert.match(recoveryBackground, /CHATGPT_CONVERSATION_REQUEST_COMPLETED/);
  assert.match(recoveryBackground, /CHATGPT_RECOVERY_QUERY/);
  assert.match(recoveryBackground, /CHATGPT_RECOVERY_FINISHED_UI/);
  assert.doesNotMatch(recoveryBackground, /\bfetch\s*\(/);
  assert.doesNotMatch(recoveryBackground, /XMLHttpRequest/);
  assert.doesNotMatch(recoveryBackground, /chrome\.storage/);
  assert.doesNotMatch(recoveryBackground, /api\/auth\/session/i);

  assert.match(recoveryScript, /more-turn-action-button/);
  assert.match(recoveryScript, /copy-turn-action-button/);
  assert.match(recoveryScript, /CHATGPT_RECOVERY_FINISHED_UI/);
  assert.match(recoveryScript, /CHATGPT_RECOVERY_CANCEL/);
  assert.doesNotMatch(recoveryScript, /\bfetch\s*\(/);

  const finishedSelector = recoveryScript.match(/const FINISHED_ACTION_SELECTOR = \[([\s\S]*?)\]\.join/)?.[1] || '';
  assert.ok(finishedSelector, 'finished-response action selector must exist');
  assert.doesNotMatch(finishedSelector, /stop-button/i, 'Stop/send control must not be required for recovery completion');
});

test('recovery scripts are valid JavaScript', () => {
  for (const relative of [
    'extension/background.js',
    'extension/recovery-background.js',
    'extension/recovery-script.js'
  ]) {
    const path = fileURLToPath(new URL(relative, root));
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${relative} failed syntax check:\n${result.stderr || result.stdout}`);
  }
});

test('extension delegates notifications to localhost helper only', () => {
  const worker = text('extension/service-worker.js');
  const recoveryBackground = text('extension/recovery-background.js');
  const manifest = JSON.parse(text('extension/manifest.json'));

  assert.match(worker, /ws:\/\/127\.0\.0\.1:38473\/bridge/);
  assert.match(worker, /type:\s*'toast\.show'/);
  assert.doesNotMatch(worker, /chrome\.notifications/);
  assert.doesNotMatch(worker, /chrome\.offscreen/);
  assert.doesNotMatch(recoveryBackground, /chrome\.notifications/);
  assert.doesNotMatch(recoveryBackground, /chrome\.offscreen/);
  assert.doesNotMatch(worker, /Click to return/i);

  assert.deepEqual(manifest.permissions.sort(), ['scripting', 'tabs', 'webRequest']);
  assert.ok(manifest.host_permissions.includes('ws://127.0.0.1/*'));
  assert.ok(manifest.host_permissions.includes('https://chatgpt.com/*'));
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.deepEqual(
    manifest.content_scripts[0].js,
    ['content-script.js', 'persistence-script.js', 'recovery-script.js']
  );
});

test('obsolete polling and recovery files stay deleted', () => {
  for (const relative of [
    'extension/recovery-watchdog.js',
    'extension/lib/server-capture.js'
  ]) {
    assert.equal(existsSync(new URL(relative, root)), false, `${relative} must not return`);
  }
});

test('persistent notification dismissal remains deliberate-interaction based', () => {
  const persistence = text('extension/persistence-script.js');
  assert.match(persistence, /pointerdown/);
  assert.match(persistence, /keydown/);
  assert.match(persistence, /CHATGPT_CONVERSATION_USER_INTERACTED/);
  assert.doesNotMatch(persistence, /visibilitychange/);
  assert.doesNotMatch(persistence, /window\.addEventListener\(['"]focus/);
});

test('Windows helper retains persisted stacking behavior', () => {
  const manager = text('src/ChatGPTResponseNotifier.Host/ToastManager.cs');
  assert.match(manager, /_store\.Load\(\)/);
  assert.match(manager, /Persist\(\)/);
  assert.match(manager, /OrderByDescending\(item => item\.Record\.CompletedAt\)/);
  assert.match(manager, /const double Gap = 10/);
});
