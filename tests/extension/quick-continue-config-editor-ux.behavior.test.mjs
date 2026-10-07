import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readText = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const styleSource = readText('standalone-quick-continue/config-editor-style.js');
const contentSource = readText('standalone-quick-continue/content-script.js');
const backgroundSource = readText('standalone-quick-continue/background.js');
const conversationStateSource = readText('standalone-quick-continue/conversation-state.js');
const monitorWatchdogSource = readText('standalone-quick-continue/monitor-watchdog.js');
const monitorBackgroundSource = readText('standalone-quick-continue/monitor-watchdog-background.js');
const notifierObserverSource = readText('extension/terminal-status-live-observer.js');
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

test('Quick Continue ships the large config editor styling to new and already-open tabs', () => {
  assert.match(manifest.version, /^1\.2\.\d+$/);
  const declared = manifest.content_scripts.flatMap((entry) => entry.js || []);
  assert.ok(declared.includes('config-editor-style.js'));
  assert.ok(declared.includes('monitor-watchdog.js'));
  assert.ok(declared.includes('conversation-state.js'));
  assert.match(backgroundSource, /'config-editor-style\.js'[\s\S]*'content-script\.js'/);
  assert.match(backgroundSource, /'monitor-watchdog\.js'/);
  assert.match(backgroundSource, /'conversation-state\.js'/);
  assert.match(installerSource, /'config-editor-style\.js'/);
  assert.match(installerSource, /'monitor-watchdog-background\.js'/);
  assert.match(installerSource, /'monitor-watchdog\.js'/);
  assert.match(installerSource, /'conversation-state\.js'/);
  assert.match(releaseWorkflow, /'config-editor-style\.js'/);
  assert.match(releaseWorkflow, /'monitor-watchdog-background\.js'/);
  assert.match(releaseWorkflow, /'monitor-watchdog\.js'/);
  assert.match(releaseWorkflow, /'conversation-state\.js'/);
  assert.match(styleSource, /width:\s*min\(780px, calc\(100vw - 32px\)\)/);
  assert.match(styleSource, /height:\s*min\(560px, calc\(100vh - 180px\)\)/);
});

test('independent Monitor countdown uses the existing countdown layout without altering Simple ownership', () => {
  assert.match(styleSource, /#chatgpt-quick-continue-simple-countdown,\s*#chatgpt-quick-continue-monitor-countdown/);
  assert.match(styleSource, /#chatgpt-quick-continue-monitor-countdown\[hidden\]/);
  assert.match(contentSource, /#chatgpt-quick-continue-simple-countdown, #chatgpt-quick-continue-monitor-countdown/);
  assert.doesNotMatch(conversationStateSource, /chatgpt-quick-continue-monitor-countdown/);
  assert.match(monitorWatchdogSource, /chatgpt-quick-continue-monitor-countdown/);
});

test('config editor caret uses high-contrast theme text instead of a fixed dark-on-dark color', () => {
  assert.match(styleSource, /caret-color:\s*var\(--text-primary, #000000\) !important/);
  assert.match(styleSource, /color:\s*var\(--text-primary, #111111\) !important/);
});

test('watchdog JSON keeps only the shared GitHub status classification table', () => {
  assert.equal(config.watchdog.timerMinutes, undefined);
  assert.equal(config.watchdog.attempts, undefined);
  assert.equal(config.watchdog.respectStopStatusCodes, undefined);
  assert.equal(config.watchdog.respectContinueStatusCodes, undefined);
  assert.deepEqual(Object.keys(config.watchdog.stopOnStatus).sort(), definitiveCodes.sort());
  for (const code of ['PLANNING_ACTIVE', 'COMPLETE_APPLIED', 'COMPLETE_NO_CHANGES', 'BLOCKED_HUMAN']) {
    assert.equal(config.watchdog.stopOnStatus[code], true);
  }
  for (const code of ['INCOMPLETE_LIMIT', 'INCOMPLETE_TOOL_FAILURE', 'INCOMPLETE_HANDOFF', 'INCOMPLETE_CONTINUE']) {
    assert.equal(config.watchdog.stopOnStatus[code], false);
  }
});

test('Monitor watchdog JSON starts from Simple defaults but owns an independent runtime and config block', () => {
  assert.deepEqual(config.monitorWatchdog, config.simpleWatchdog);
  assert.match(monitorWatchdogSource, /config\?\.monitorWatchdog/);
  assert.match(monitorWatchdogSource, /MONITOR_STATUS_MESSAGE = 'QUICK_CONTINUE_MONITOR_WATCHDOG_STATUS'/);
  assert.match(monitorBackgroundSource, /quickContinueMonitorWatchdogStates/);
  assert.match(monitorBackgroundSource, /quick-continue-monitor-watchdog:/);
  assert.doesNotMatch(conversationStateSource, /QUICK_CONTINUE_MONITOR_WATCHDOG_/);
});

test('Simple watchdog JSON owns timing, retries, refresh delays, and terminal-status gates', () => {
  assert.deepEqual(config.simpleWatchdog, {
    timerMinutes: 30,
    attempts: 3,
    stopToRefreshSeconds: 30,
    refreshToContinueSeconds: 30,
    respectStopStatusCodes: true,
    respectContinueStatusCodes: true
  });
  assert.match(conversationStateSource, /Toggle Simple watchdog/);
  assert.match(conversationStateSource, /SIMPLE_STATUS_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_STATUS'/);
  assert.match(conversationStateSource, /TERMINAL_BRIDGE_MARKER = 'chatgpt-notifier-terminal-status-v1'/);
  assert.match(conversationStateSource, /queryNotifierTerminalSignal/);
  assert.doesNotMatch(conversationStateSource, /latestSimpleTerminal|terminalCodeFromElement|conversationTurns/);
  assert.match(notifierObserverSource, /terminalStatusClass/);
  assert.match(notifierObserverSource, /getWatchdogSettings/);
  assert.match(backgroundSource, /SIMPLE_STATUS_MESSAGE = 'QUICK_CONTINUE_SIMPLE_WATCHDOG_STATUS'/);
  assert.match(backgroundSource, /statusClass === 'stop'/);
  assert.match(backgroundSource, /state\.settings\?\.respectStopStatusCodes !== false/);
  assert.match(backgroundSource, /state\.settings\?\.respectContinueStatusCodes !== false/);
  assert.match(backgroundSource, /reason: 'status-stop'/);
  assert.match(backgroundSource, /statusAction: 'continue'/);
  assert.match(backgroundSource, /statusAction: 'exhausted'/);
  assert.doesNotMatch(backgroundSource, /normalizeStopOnStatus|DEFAULT_STOP_ON_STATUS/);
  assert.match(backgroundSource, /state\.phase = 'stop-wait'/);
  assert.match(backgroundSource, /chrome\.tabs\.reload\(tabId\)/);
  assert.match(backgroundSource, /state\.phase = 'refresh-loading'/);
  assert.match(backgroundSource, /String\(tab\.status \|\| ''\) !== 'complete'/);
  assert.match(backgroundSource, /state\.phase = 'refresh-wait'/);
  assert.match(backgroundSource, /action: 'send-continue'/);
});