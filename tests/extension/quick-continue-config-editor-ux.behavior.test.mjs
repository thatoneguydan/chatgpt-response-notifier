import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readText = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const styleSource = readText('standalone-quick-continue/config-editor-style.js');
const backgroundSource = readText('standalone-quick-continue/background.js');
const conversationStateSource = readText('standalone-quick-continue/conversation-state.js');
const installerSource = readText('standalone-quick-continue/Install.ps1');
const releaseWorkflow = readText('.github/workflows/quick-continue-release.yml');
const manifest = JSON.parse(readText('standalone-quick-continue/manifest.json'));
const config = JSON.parse(readText('standalone-quick-continue/config.json'));

const definitiveCodes = [
  'PLANNING_ACTIVE',
  'COMPLETE_APPLIED',
  'COMPLETE_NO_CHANGES',
  'BLOCKED_HUMAN',
  'INCOMPLETE_LIMIT',
  'INCOMPLETE_TOOL_FAILURE',
  'INCOMPLETE_HANDOFF',
  'INCOMPLETE_CONTINUE'
];

test('Quick Continue 1.2.33 ships the large config editor styling to new and already-open tabs', () => {
  assert.equal(manifest.version, '1.2.33');
  const declared = manifest.content_scripts.flatMap((entry) => entry.js || []);
  assert.ok(declared.includes('config-editor-style.js'));
  assert.ok(declared.includes('conversation-state.js'));
  assert.match(backgroundSource, /'config-editor-style\.js'[\s\S]*'content-script\.js'/);
  assert.match(backgroundSource, /'conversation-state\.js'/);
  assert.match(installerSource, /'config-editor-style\.js'/);
  assert.match(installerSource, /'conversation-state\.js'/);
  assert.match(releaseWorkflow, /'config-editor-style\.js'/);
  assert.match(releaseWorkflow, /'conversation-state\.js'/);
  assert.match(styleSource, /width:\s*min\(780px, calc\(100vw - 32px\)\)/);
  assert.match(styleSource, /height:\s*min\(560px, calc\(100vh - 180px\)\)/);
});

test('config editor caret uses high-contrast theme text instead of a fixed dark-on-dark color', () => {
  assert.match(styleSource, /caret-color:\s*var\(--text-primary, #000000\) !important/);
  assert.match(styleSource, /color:\s*var\(--text-primary, #111111\) !important/);
});

test('smart watchdog JSON exposes editable timer, attempt cap, status-class gates, and all GitHub status stop policies', () => {
  assert.equal(config.watchdog.timerMinutes, 30);
  assert.equal(config.watchdog.attempts, 3);
  assert.equal(config.watchdog.respectStopStatusCodes, true);
  assert.equal(config.watchdog.respectContinueStatusCodes, true);
  assert.deepEqual(Object.keys(config.watchdog.stopOnStatus).sort(), definitiveCodes.sort());
  for (const code of ['PLANNING_ACTIVE', 'COMPLETE_APPLIED', 'COMPLETE_NO_CHANGES', 'BLOCKED_HUMAN']) {
    assert.equal(config.watchdog.stopOnStatus[code], true);
  }
  for (const code of ['INCOMPLETE_LIMIT', 'INCOMPLETE_TOOL_FAILURE', 'INCOMPLETE_HANDOFF', 'INCOMPLETE_CONTINUE']) {
    assert.equal(config.watchdog.stopOnStatus[code], false);
  }
});

test('Simple watchdog JSON exposes every fixed-sequence timing and remains status-blind', () => {
  assert.deepEqual(config.simpleWatchdog, {
    timerMinutes: 30,
    attempts: 3,
    stopToRefreshSeconds: 30,
    refreshToContinueSeconds: 30
  });
  assert.match(conversationStateSource, /Toggle simple fallback watchdog/);
  assert.match(backgroundSource, /phase: 'countdown'/);
  assert.match(backgroundSource, /state\.phase = 'stop-wait'/);
  assert.match(backgroundSource, /chrome\.tabs\.reload\(tabId\)/);
  assert.match(backgroundSource, /state\.phase = 'refresh-wait'/);
  assert.match(backgroundSource, /action: 'send-continue'/);
  for (const code of definitiveCodes) {
    assert.equal(backgroundSource.includes(code), false, `Simple background path must not inspect ${code}`);
    assert.equal(conversationStateSource.includes(code), false, `Simple page path must not inspect ${code}`);
  }
});