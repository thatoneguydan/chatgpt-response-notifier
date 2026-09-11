import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root));
const text = (relative) => read(relative).toString('utf8');

function gitBlobSha(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(buffer).digest('hex');
}

function normalizedGitBlobSha(relative) {
  const checkoutText = text(relative);
  return gitBlobSha(Buffer.from(checkoutText.replace(/\r\n/g, '\n'), 'utf8'));
}

function loadStatusParser() {
  const context = vm.createContext({});
  vm.runInContext(text('extension/status-code.js'), context);
  return context.ChatGPTNotifierStatusCode;
}

test('completion content script remains upstream 1.0.8', () => {
  assert.equal(
    normalizedGitBlobSha('extension/content-script.js'),
    'fcea2bd286e1436d94addd9fe8c3b79feb0ad919',
    'content-script.js must remain identical to ramhaidar upstream revision cbe00dcfcff8a571f407c6109ed4d5f97cef60a9 apart from checkout line-ending conversion'
  );
});

test('terminal GitHub status parser only accepts an exact final non-whitespace footer line', () => {
  const parser = loadStatusParser();

  const complete = parser.parseTerminalStatus('Finished the build.\n\n[GITHUB_STATUS: COMPLETE_APPLIED]\n');
  assert.equal(complete.statusCode, 'COMPLETE_APPLIED');
  assert.equal(complete.statusLine, '[GITHUB_STATUS: COMPLETE_APPLIED]');
  assert.equal(complete.body, 'Finished the build.');

  const planning = parser.parseTerminalStatus('We are still choosing the architecture.\n[GITHUB_STATUS: PLANNING_ACTIVE]');
  assert.equal(planning.statusCode, 'PLANNING_ACTIVE');
  assert.equal(planning.body, 'We are still choosing the architecture.');

  assert.equal(
    parser.parseTerminalStatus('[GITHUB_STATUS: COMPLETE_APPLIED]\nThis is only a discussion of the code.').statusCode,
    '',
    'a status-looking line in the middle of a response must not notify'
  );
  assert.equal(parser.parseTerminalStatus('Done.\n[GITHUB_STATUS: complete_applied]').statusCode, '');
  assert.equal(parser.parseTerminalStatus('Done.\n[GITHUB_STATUS: COMPLETE-APPLIED]').statusCode, '');
  assert.equal(parser.parseTerminalStatus('Done without a footer.').statusCode, '');
});

test('status parser accepts only the canonical seven work-session codes', () => {
  const parser = loadStatusParser();
  const expected = [
    'PLANNING_ACTIVE',
    'COMPLETE_APPLIED',
    'COMPLETE_NO_CHANGES',
    'BLOCKED_HUMAN',
    'INCOMPLETE_LIMIT',
    'INCOMPLETE_TOOL_FAILURE',
    'INCOMPLETE_HANDOFF'
  ];

  assert.deepEqual(Array.from(parser.validStatusCodes), expected);
  for (const code of expected) {
    assert.equal(parser.isStatusCode(code), true, `${code} must qualify`);
    assert.equal(parser.parseTerminalStatus(`Body\n[GITHUB_STATUS: ${code}]`).statusCode, code);
  }

  assert.equal(parser.isStatusCode('FUTURE_POLICY_CODE_2'), false);
  assert.equal(parser.isStatusCode('future_policy_code'), false);
  assert.equal(parser.parseTerminalStatus('Body\n[GITHUB_STATUS: FUTURE_POLICY_CODE_2]').statusCode, '');
});

test('service worker observes ChatGPT traffic but never creates ChatGPT HTTP traffic', () => {
  const worker = text('extension/service-worker.js');
  assert.match(worker, /chrome\.webRequest\.onCompleted\.addListener/);
  assert.match(worker, /signalConversationRequestCompleted\(details\.tabId\)/);
  assert.doesNotMatch(worker, /\bfetch\s*\(/);
  assert.doesNotMatch(worker, /XMLHttpRequest/);
  assert.doesNotMatch(worker, /api\/auth\/session/i);
  assert.doesNotMatch(worker, /onBeforeSendHeaders/);
  assert.doesNotMatch(worker, /server-capture/i);
  assert.doesNotMatch(worker, /recovery-watchdog/i);
});

test('normal completion remains upstream-triggered but notification eligibility comes from the terminal status footer', () => {
  const worker = text('extension/service-worker.js');
  assert.match(worker, /CHATGPT_STATUS_CODE_QUERY/);
  assert.match(worker, /queryTerminalStatus\(tabId\)/);
  assert.match(worker, /ChatGPTNotifierStatusCode\?\.isStatusCode\(statusCode\)/);
  assert.match(worker, /statusCode,/);
  assert.match(worker, /preview:\s*truncateResponse\(status\?\.responseBody\s*\|\|\s*message\?\.response\)/);
  assert.match(worker, /title:\s*fullTabTitle\(sender, message\)/);
  assert.match(worker, /rememberEligibleCompletion/);
  assert.match(worker, /notified:\s*Boolean\(notificationId\)/);
});

test('status DOM layer preserves line boundaries outside the unchanged upstream detector', () => {
  const statusScript = text('extension/status-script.js');
  const upstream = text('extension/content-script.js');
  assert.match(statusScript, /innerText/);
  assert.match(statusScript, /parseTerminalStatus\(responseText\)/);
  assert.match(statusScript, /MutationObserver/);
  assert.match(statusScript, /CHATGPT_STATUS_CODE_QUERY/);
  assert.doesNotMatch(statusScript, /\bfetch\s*\(/);
  assert.match(upstream, /replace\(\/\\s\+\/g, ' '\)/, 'upstream whitespace normalization remains untouched');
});

test('INCOMPLETE_LIMIT auto-continuation uses only guarded ChatGPT DOM interaction and falls back to notification on failure', () => {
  const statusScript = text('extension/status-script.js');
  assert.match(statusScript, /AUTO_CONTINUE_TEXT\s*=\s*'continue until you finish or need something from me'/);
  assert.match(statusScript, /snapshot\?\.statusCode !== 'INCOMPLETE_LIMIT'/);
  assert.match(statusScript, /document\.activeElement === composer/);
  assert.match(statusScript, /composerText\(composer\) !== ''/);
  assert.match(statusScript, /button\[data-testid="send-button"\]/);
  assert.match(statusScript, /sendButton\.click\(\)/);
  assert.match(statusScript, /waitForSendAccepted/);
  assert.match(statusScript, /autoContinued \? '' : \(snapshot\?\.statusCode \|\| ''\)/);
  assert.match(statusScript, /pendingAutoContinueTurn/);
  assert.doesNotMatch(statusScript, /\bfetch\s*\(/);
  assert.doesNotMatch(statusScript, /XMLHttpRequest/);
  assert.doesNotMatch(statusScript, /chrome\.storage/);
  assert.doesNotMatch(statusScript, /api\/auth\/session/i);
});

test('refresh/reopen recovery stays local and uses the same terminal footer instead of ChatGPT action buttons', () => {
  const wrapper = text('extension/background.js');
  const recoveryBackground = text('extension/recovery-background.js');
  const recoveryScript = text('extension/recovery-script.js');

  assert.match(wrapper, /importScripts\([\s\S]*status-code\.js[\s\S]*service-worker\.js[\s\S]*recovery-background\.js[\s\S]*history-background\.js[\s\S]*\)/);
  assert.match(recoveryBackground, /chrome\.webRequest\.onBeforeRequest\.addListener/);
  assert.match(recoveryBackground, /indexedDB\.open/);
  assert.match(recoveryBackground, /CHATGPT_CONVERSATION_REQUEST_COMPLETED/);
  assert.match(recoveryBackground, /CHATGPT_RECOVERY_QUERY/);
  assert.match(recoveryBackground, /CHATGPT_RECOVERY_STATUS_READY/);
  assert.match(recoveryBackground, /ChatGPTNotifierStatusCode\?\.isStatusCode\(statusCode\)/);
  assert.doesNotMatch(recoveryBackground, /\bfetch\s*\(/);
  assert.doesNotMatch(recoveryBackground, /XMLHttpRequest/);
  assert.doesNotMatch(recoveryBackground, /chrome\.storage/);
  assert.doesNotMatch(recoveryBackground, /api\/auth\/session/i);

  assert.match(recoveryScript, /__chatgptNotifierStatusDom/);
  assert.match(recoveryScript, /snapshot\?\.statusCode/);
  assert.match(recoveryScript, /CHATGPT_RECOVERY_STATUS_READY/);
  assert.match(recoveryScript, /CHATGPT_RECOVERY_CANCEL/);
  assert.doesNotMatch(recoveryScript, /more-turn-action-button/);
  assert.doesNotMatch(recoveryScript, /copy-turn-action-button/);
  assert.doesNotMatch(recoveryScript, /FINISHED_ACTION_SELECTOR/);
  assert.doesNotMatch(recoveryScript, /\bfetch\s*\(/);
});

test('recent history contains only the rolling 20 eligible coded notifications while retaining preview data', () => {
  const history = text('extension/history-background.js');
  assert.match(history, /const MAX_HISTORY = 20/);
  assert.match(history, /indexedDB\.open/);
  assert.match(history, /rememberEligibleCompletion/);
  assert.match(history, /statusCode/);
  assert.match(history, /preview:/);
  assert.match(history, /filter\(\(item\) => isStatusCode\(item\?\.statusCode\)\)/);
  assert.match(history, /GET_RECENT_NOTIFICATIONS/);
  assert.match(history, /OPEN_RECENT_NOTIFICATION/);
  assert.doesNotMatch(history, /CHATGPT_RESPONSE_COMPLETE/);
  assert.doesNotMatch(history, /TEST_NATIVE_TOAST/);
  assert.doesNotMatch(history, /\bfetch\s*\(/);
  assert.doesNotMatch(history, /XMLHttpRequest/);
  assert.doesNotMatch(history, /chrome\.storage/);
  assert.doesNotMatch(history, /api\/auth\/session/i);
});

test('local extension scripts are valid JavaScript', () => {
  for (const relative of [
    'extension/background.js',
    'extension/service-worker.js',
    'extension/recovery-background.js',
    'extension/recovery-script.js',
    'extension/history-background.js',
    'extension/status-code.js',
    'extension/status-script.js',
    'extension/popup.js'
  ]) {
    const path = fileURLToPath(new URL(relative, root));
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${relative} failed syntax check:\n${result.stderr || result.stdout}`);
  }
});

test('extension delegates Windows notifications to localhost helper only and adds no permissions', () => {
  const worker = text('extension/service-worker.js');
  const recoveryBackground = text('extension/recovery-background.js');
  const historyBackground = text('extension/history-background.js');
  const statusScript = text('extension/status-script.js');
  const manifest = JSON.parse(text('extension/manifest.json'));

  assert.match(worker, /ws:\/\/127\.0\.0\.1:38473\/bridge/);
  assert.match(worker, /type:\s*'toast\.show'/);
  for (const source of [worker, recoveryBackground, historyBackground, statusScript]) {
    assert.doesNotMatch(source, /chrome\.notifications/);
    assert.doesNotMatch(source, /chrome\.offscreen/);
  }
  assert.doesNotMatch(worker, /Click to return/i);

  assert.deepEqual(manifest.permissions.sort(), ['scripting', 'tabs', 'webRequest']);
  assert.ok(manifest.host_permissions.includes('ws://127.0.0.1/*'));
  assert.ok(manifest.host_permissions.includes('https://chatgpt.com/*'));
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.deepEqual(
    manifest.content_scripts[0].js,
    ['content-script.js', 'persistence-script.js', 'status-code.js', 'status-script.js', 'recovery-script.js']
  );
});

test('popup remains twenty-item clickable history and displays the status code with full wrapping title', () => {
  const popup = text('extension/popup.html');
  const popupScript = text('extension/popup.js');

  assert.match(popup, /id="history"/);
  assert.match(popup, /class="history-status"|\.history-status/);
  assert.match(popup, /white-space:\s*normal/);
  assert.match(popup, /id="version"/);
  assert.match(popup, /id="checkUpdate"/);
  assert.match(popup, /id="test"/);
  assert.doesNotMatch(popup, /Uses the upstream prompt-bound/i);
  assert.doesNotMatch(popup, /Checking Windows helper/i);
  assert.match(popupScript, /record\.statusCode/);
  assert.match(popupScript, /GET_RECENT_NOTIFICATIONS/);
  assert.match(popupScript, /OPEN_RECENT_NOTIFICATION/);
  assert.match(popupScript, /slice\(0, 20\)/);
});

test('obsolete polling and action-button recovery machinery stays deleted', () => {
  for (const relative of [
    'extension/recovery-watchdog.js',
    'extension/lib/server-capture.js'
  ]) {
    assert.equal(existsSync(new URL(relative, root)), false, `${relative} must not return`);
  }
  assert.doesNotMatch(text('extension/recovery-script.js'), /FINISHED_ACTION_SELECTOR/);
});

test('persistent notification dismissal remains deliberate-interaction based', () => {
  const persistence = text('extension/persistence-script.js');
  assert.match(persistence, /pointerdown/);
  assert.match(persistence, /keydown/);
  assert.match(persistence, /CHATGPT_CONVERSATION_USER_INTERACTED/);
  assert.doesNotMatch(persistence, /visibilitychange/);
  assert.doesNotMatch(persistence, /window\.addEventListener\(['"]focus/);
});

test('Windows helper retains persisted stacking and v0.6 notification-state compatibility', () => {
  const manager = text('src/ChatGPTResponseNotifier.Host/ToastManager.cs');
  const record = text('src/ChatGPTResponseNotifier.Core/NotificationRecord.cs');
  assert.match(manager, /_store\.Load\(\)/);
  assert.match(manager, /Persist\(\)/);
  assert.match(manager, /OrderByDescending\(item => item\.Record\.CompletedAt\)/);
  assert.match(manager, /const double Gap = 10/);
  assert.match(record, /public string StatusCode \{ get; init; \} = string\.Empty/);
  assert.doesNotMatch(record, /Title\.Length\s*>/, 'full browser tab titles must not be truncated or rejected by the helper model');
});

test('Windows toast is compact, light, full-title plus status code, with preview retained but not rendered', () => {
  const window = text('src/ChatGPTResponseNotifier.Host/ToastWindow.cs');
  assert.match(window, /Width\s*=\s*350/);
  assert.match(window, /Color\.FromRgb\(248, 248, 248\)/);
  assert.match(window, /Text\s*=\s*record\.Title/);
  assert.match(window, /Text\s*=\s*record\.StatusCode/);
  assert.match(window, /TextWrapping\s*=\s*TextWrapping\.Wrap/);
  assert.doesNotMatch(window, /TextTrimming\s*=/);
  assert.doesNotMatch(window, /Text\s*=\s*record\.Preview/);
  assert.doesNotMatch(window, /record\.CompletedAt\.ToLocalTime/);
});

test('helper teardown cannot turn active toasts into dismissals during updates', () => {
  const window = text('src/ChatGPTResponseNotifier.Host/ToastWindow.cs');
  assert.doesNotMatch(window, /Closed\s*\+=/);
  assert.match(window, /close\.Click\s*\+=/);
  assert.match(window, /ToastDismissed\?\.Invoke/);
  assert.match(window, /border\.MouseLeftButtonUp\s*\+=/);
  assert.match(window, /ToastClicked\?\.Invoke/);
});
