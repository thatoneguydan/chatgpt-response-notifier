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
const blobSha = (buffer) => createHash('sha1').update(Buffer.from(`blob ${buffer.length}\0`)).update(buffer).digest('hex');
const normalizedBlobSha = (relative) => blobSha(Buffer.from(text(relative).replace(/\r\n/g, '\n')));

function loadStatusParser() {
  const context = vm.createContext({});
  vm.runInContext(text('extension/status-code.js'), context);
  return context.ChatGPTNotifierStatusCode;
}

test('upstream completion detector remains byte-for-byte unchanged', () => {
  assert.equal(normalizedBlobSha('extension/content-script.js'), 'fcea2bd286e1436d94addd9fe8c3b79feb0ad919');
});

test('only the canonical seven exact terminal footer codes qualify', () => {
  const parser = loadStatusParser();
  const expected = ['PLANNING_ACTIVE','COMPLETE_APPLIED','COMPLETE_NO_CHANGES','BLOCKED_HUMAN','INCOMPLETE_LIMIT','INCOMPLETE_TOOL_FAILURE','INCOMPLETE_HANDOFF'];
  assert.deepEqual(Array.from(parser.validStatusCodes), expected);
  for (const code of expected) assert.equal(parser.parseTerminalStatus(`Body\n[GITHUB_STATUS: ${code}]`).statusCode, code);
  assert.equal(parser.parseTerminalStatus('[GITHUB_STATUS: COMPLETE_APPLIED]\nnot terminal').statusCode, '');
  assert.equal(parser.parseTerminalStatus('Body\n[GITHUB_STATUS: FUTURE_CODE]').statusCode, '');
});

test('background composition keeps policy/coordinator before recovery and monitoring', () => {
  const wrapper = text('extension/background.js');
  assert.match(wrapper, /status-code\.js[\s\S]*status-policy\.js[\s\S]*coordinator-background\.js[\s\S]*recovery-background\.js[\s\S]*history-background\.js[\s\S]*service-worker\.js/);
});

test('monitoring observes the page request but creates no ChatGPT HTTP traffic', () => {
  const sources = [
    text('extension/service-worker.js'),
    text('extension/recovery-background.js'),
    text('extension/status-script.js'),
    text('extension/coordinator-background.js')
  ];
  const worker = sources[0];
  assert.match(worker, /chrome\.webRequest\.onCompleted\.addListener/);
  assert.match(worker, /chrome\.webRequest\.onBeforeRequest\.addListener/);
  assert.match(worker, /chrome\.webRequest\.onHeadersReceived\.addListener/);
  for (const source of sources) {
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /XMLHttpRequest/);
    assert.doesNotMatch(source, /api\/auth\/session/i);
  }
});

test('status observation is read-only and continuation is separately authorized', () => {
  const status = text('extension/status-script.js');
  const worker = text('extension/service-worker.js');
  const policy = text('extension/status-policy.js');
  assert.match(status, /CHATGPT_STATUS_CODE_QUERY/);
  assert.match(status, /CHATGPT_CONTINUE_COMMAND/);
  assert.match(status, /autoContinued:\s*false/);
  assert.match(status, /read-only-observation/);
  assert.match(status, /revisionOf\(responseText\)/);
  assert.match(status, /documentId/);
  assert.match(status, /waitForContinuationUserTurn/);
  assert.match(status, /AUTO_CONTINUE_TEXT\s*=\s*'continue until you finish or need something from me'/);
  assert.doesNotMatch(status, /composerText\([^)]*\)\s*===\s*''[^\n]*return\s*\{[^}]*ok:\s*true/);
  assert.match(worker, /claimTurn\(status, owner\)/);
  assert.match(worker, /continuation-authorized/);
  assert.match(worker, /requestContinuation\(tabId, senderDocumentId, expected\)/);
  assert.match(policy, /current\.conversationId === expected\.conversationId/);
  assert.match(policy, /current\.documentId === expected\.documentId/);
  assert.match(policy, /current\.promptKey === expected\.promptKey/);
  assert.match(policy, /current\.assistantKey === expected\.assistantKey/);
  assert.match(policy, /current\.revision === expected\.revision/);
});

test('active user and draft safeguards are explicit and trusted-event based', () => {
  const status = text('extension/status-script.js');
  const policy = text('extension/status-policy.js');
  assert.match(status, /event\?\.isTrusted === true/);
  assert.match(status, /pointerdown/);
  assert.match(status, /keydown/);
  assert.match(status, /beforeinput/);
  assert.match(status, /compositionstart/);
  assert.match(policy, /composer-not-empty/);
  assert.match(policy, /active-user-interaction/);
});

test('version-aware attachment re-arms stale listeners without changing upstream source', () => {
  const attachment = text('extension/attachment-script.js');
  assert.match(attachment, /chrome\.runtime\.getManifest\(\)\.version/);
  assert.match(attachment, /__chatgptPromptBoundNotifierInstalled = false/);
  assert.match(attachment, /__chatgptNotifierStatusDomInstalled = false/);
  assert.match(text('extension/service-worker.js'), /attachment-script\.js/);
  assert.match(text('extension/recovery-background.js'), /attachment-script\.js/);
});

test('durable coordinator owns turns and unresolved clicks reconcile to notification, never replay', () => {
  const coordinator = text('extension/coordinator-background.js');
  const worker = text('extension/service-worker.js');
  assert.match(coordinator, /indexedDB\.open/);
  assert.match(coordinator, /TURN_STORE = 'turns'/);
  assert.match(coordinator, /OUTBOX_STORE = 'notification-outbox'/);
  assert.match(coordinator, /conversationId\}\|\$\{promptKey\}\|\$\{assistantKey\}\|\$\{revision/);
  assert.match(coordinator, /store\.add\(record\)/);
  assert.match(worker, /listUnresolvedTurns\(\)/);
  assert.match(worker, /without-replay/);
  assert.doesNotMatch(worker, /reconcileUnresolvedTurns[\s\S]{0,1200}requestContinuation/);
});

test('continuation acceptance requires matching user turn plus passive accepted request evidence', () => {
  const status = text('extension/status-script.js');
  const worker = text('extension/service-worker.js');
  assert.match(status, /matchingContinuationUserTurn/);
  assert.match(status, /cleanComposer\(user\.text\) === AUTO_CONTINUE_TEXT/);
  assert.match(worker, /startContinuationRequestWatch/);
  assert.match(worker, /requestEvidence\?\.accepted === true/);
  assert.match(worker, /continuationOutcome/);
  assert.match(worker, /sameConversation:/);
});

test('completion is bound to the originating conversation, document and rendered response before claim', () => {
  const worker = text('extension/service-worker.js');
  assert.match(worker, /senderDocumentId = String\(sender\.documentId/);
  assert.match(worker, /queryTerminalStatus\(tabId, senderDocumentId\)/);
  assert.match(worker, /statusBoundToCompletion\(status, originIdentity, message\?\.response\)/);
  assert.match(worker, /upstream === observed/);
  assert.match(worker, /currentIdentity\.id !== originIdentity\.id/);
});

test('notification delivery is durable until exact helper persistence acknowledgment', () => {
  const coordinator = text('extension/coordinator-background.js');
  const worker = text('extension/service-worker.js');
  const app = text('src/ChatGPTResponseNotifier.Host/NativeHostApplication.cs');
  const manager = text('src/ChatGPTResponseNotifier.Host/ToastManager.cs');
  const accepted = text('src/ChatGPTResponseNotifier.Core/AcceptedNotificationStore.cs');
  assert.match(coordinator, /queueNotification/);
  assert.match(worker, /\['toast\.accepted'\]/);
  assert.match(worker, /queueIfDisconnected:\s*false/);
  assert.match(worker, /acknowledgeNotification\(notification\.id\)/);
  assert.match(app, /type = "toast\.accepted"/);
  assert.match(app, /notificationId = message\.Notification\.Id/);
  assert.match(app, /accepted-notifications\.json/);
  assert.match(manager, /_acceptedStore\.Contains\(record\.Id\)/);
  assert.match(manager, /Persist\(\);[\s\S]*_acceptedStore\.Remember\(record\.Id\)/);
  assert.match(accepted, /MaxAcceptedIds = 512/);
});

test('recovery is cleared only after a durable outcome and frozen/discarded pages are not activated to recover', () => {
  const recovery = text('extension/recovery-background.js');
  const worker = text('extension/service-worker.js');
  assert.match(recovery, /finalizeConversation:\s*clearPending/);
  assert.doesNotMatch(recovery, /message\?\.type === 'CHATGPT_RESPONSE_COMPLETE'[\s\S]{0,300}clearPending/);
  assert.match(worker, /finalizeRecovery\(turnRecord\.conversationId\)/);
  assert.match(worker, /tab\.discarded === true \|\| tab\.frozen === true/);
  assert.match(recovery, /tab\.discarded === true \|\| tab\.frozen === true/);
});

test('history remains a rolling 20 coded notifications', () => {
  const history = text('extension/history-background.js');
  assert.match(history, /const MAX_HISTORY = 20/);
  assert.match(history, /rememberEligibleCompletion/);
  assert.match(history, /GET_RECENT_NOTIFICATIONS/);
});

test('manifest adds no privileges and installs version-aware local scripts', () => {
  const manifest = JSON.parse(text('extension/manifest.json'));
  assert.equal(manifest.version, '0.9.0');
  assert.deepEqual(manifest.permissions.sort(), ['scripting','tabs','webRequest']);
  assert.deepEqual(manifest.host_permissions.sort(), ['https://chatgpt.com/*','ws://127.0.0.1/*'].sort());
  assert.deepEqual(manifest.content_scripts[0].js, [
    'attachment-script.js','content-script.js','persistence-script.js','status-code.js','status-policy.js','status-script.js','recovery-script.js'
  ]);
});

test('local JavaScript is syntactically valid', () => {
  for (const relative of [
    'extension/background.js','extension/service-worker.js','extension/attachment-script.js','extension/coordinator-background.js',
    'extension/recovery-background.js','extension/recovery-script.js','extension/history-background.js','extension/status-code.js',
    'extension/status-policy.js','extension/status-script.js','extension/persistence-script.js','extension/popup.js'
  ]) {
    const path = fileURLToPath(new URL(relative, root));
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${relative} failed syntax check:\n${result.stderr || result.stdout}`);
  }
});

test('obsolete polling/action-button recovery files stay deleted and helper toast UX stays non-activating', () => {
  assert.equal(existsSync(new URL('extension/recovery-watchdog.js', root)), false);
  assert.equal(existsSync(new URL('extension/lib/server-capture.js', root)), false);
  const window = text('src/ChatGPTResponseNotifier.Host/ToastWindow.cs');
  assert.match(window, /ShowActivated\s*=\s*false/);
  assert.doesNotMatch(window, /Text\s*=\s*record\.Preview/);
});
