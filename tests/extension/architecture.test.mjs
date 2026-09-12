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

test('background composition loads policy, passive observation, recovery ownership and normal continuation fuse in dependency order', () => {
  const wrapper = text('extension/background.js');
  assert.match(wrapper, /status-code\.js[\s\S]*status-policy\.js[\s\S]*recovery-model\.js[\s\S]*coordinator-background\.js[\s\S]*recovery-background\.js[\s\S]*history-background\.js[\s\S]*monitor-background\.js[\s\S]*monitor-query-compat-background\.js[\s\S]*recovery-control-background\.js[\s\S]*bounded-recovery-background\.js[\s\S]*bounded-recovery-attachment-background\.js[\s\S]*service-worker\.js[\s\S]*normal-continuation-budget-hook\.js/);
});

test('monitoring and bounded recovery observe page/request state but create no ChatGPT HTTP traffic', () => {
  const sources = [
    text('extension/service-worker.js'),
    text('extension/recovery-background.js'),
    text('extension/status-script.js'),
    text('extension/coordinator-background.js'),
    text('extension/monitor-background.js'),
    text('extension/monitor-script.js'),
    text('extension/bounded-recovery-background.js'),
    text('extension/bounded-recovery-script.js'),
    text('extension/normal-continuation-budget-hook.js')
  ];
  const worker = sources[0];
  const monitor = sources[4];
  const bounded = sources[6];
  assert.match(worker, /chrome\.webRequest\.onCompleted\.addListener/);
  assert.match(worker, /chrome\.webRequest\.onBeforeRequest\.addListener/);
  assert.match(worker, /chrome\.webRequest\.onHeadersReceived\.addListener/);
  assert.match(monitor, /chrome\.webRequest\.onBeforeRequest\.addListener/);
  assert.match(monitor, /chrome\.webRequest\.onCompleted\.addListener/);
  assert.match(monitor, /chrome\.webRequest\.onErrorOccurred\.addListener/);
  assert.match(bounded, /chrome\.webRequest\.onBeforeRequest\.addListener/);
  assert.match(bounded, /chrome\.webRequest\.onHeadersReceived\.addListener/);
  assert.match(bounded, /chrome\.webRequest\.onErrorOccurred\.addListener/);
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

test('passive monitored-build observer persists identity without raw prompt or assistant content', () => {
  const page = text('extension/monitor-script.js');
  const monitor = text('extension/monitor-background.js');
  assert.match(page, /promptRevision/);
  assert.match(page, /assistantRevision/);
  assert.match(page, /CHATGPT_MONITOR_STATE/);
  assert.match(page, /silentIdleConfirmations/);
  assert.match(page, /stableTerminal/);
  assert.match(monitor, /ENROLLMENT_STORE = 'enrollments'/);
  assert.match(monitor, /RUN_STORE = 'runs'/);
  assert.match(monitor, /runKey\(snapshot\)/);
  assert.match(monitor, /promptRevision:/);
  assert.match(monitor, /assistantRevision:/);
  assert.doesNotMatch(monitor, /promptText\s*:/);
  assert.doesNotMatch(monitor, /assistantText\s*:/);
  assert.doesNotMatch(monitor, /responseText\s*:/);
});

test('monitor query compatibility preserves the passive wrapper while exposing direct identity fields to recovery', () => {
  const compat = text('extension/monitor-query-compat-background.js');
  assert.match(compat, /message\?\.type !== 'CHATGPT_MONITOR_QUERY'/);
  assert.match(compat, /result\?\.snapshot/);
  assert.match(compat, /\{ \.\.\.result\.snapshot, \.\.\.result, snapshot: result\.snapshot \}/);
});

test('monitoring enrollment is explicit and recovery is a second per-conversation opt-in', () => {
  const monitor = text('extension/monitor-background.js');
  const recoveryControl = text('extension/recovery-control-background.js');
  const popup = text('extension/popup.js');
  assert.match(monitor, /SET_ACTIVE_CHAT_MONITORING/);
  assert.match(monitor, /source:\s*String\(source \|\| 'operator'\)/);
  assert.match(monitor, /statusIsValid[\s\S]*setEnrollment\([^)]*true, 'coded-turn'\)/);
  assert.match(recoveryControl, /SET_ACTIVE_CHAT_RECOVERY/);
  assert.match(recoveryControl, /recoveryEnabled:\s*recoveryEnabled === true/);
  assert.match(recoveryControl, /operator-recovery/);
  assert.match(recoveryControl, /RESUME_ACTIVE_CHAT_RECOVERY/);
  assert.match(popup, /SET_ACTIVE_CHAT_MONITORING/);
  assert.match(popup, /SET_ACTIVE_CHAT_RECOVERY/);
  assert.match(popup, /RESUME_ACTIVE_CHAT_RECOVERY/);
  assert.doesNotMatch(monitor, /https:\/\/(?:api\.)?github\.com/i);
});

test('attention.required is durable and separate from rolling coded history', () => {
  const monitor = text('extension/monitor-background.js');
  const history = text('extension/history-background.js');
  const popup = text('extension/popup.js');
  const record = text('src/ChatGPTResponseNotifier.Core/NotificationRecord.cs');
  assert.match(monitor, /ATTENTION_STORE = 'attention'/);
  assert.match(monitor, /eventKind:\s*'attention\.required'/);
  assert.match(monitor, /kind:\s*'attention\.required'/);
  assert.match(monitor, /\['toast\.accepted'\]/);
  assert.match(monitor, /delivered:\s*true/);
  assert.match(popup, /ACK_RECOVERY_ATTENTION/);
  assert.match(record, /Kind \{ get; init; \} = "coded-result"/);
  assert.match(record, /"coded-result" or "attention\.required"/);
  assert.match(history, /const MAX_HISTORY = 20/);
  assert.doesNotMatch(history, /attention\.required/);
});

test('known interruption text is scoped to application alerts, not quoted assistant turn content', () => {
  const page = text('extension/monitor-script.js');
  assert.match(page, /\[role="alert"\]/);
  assert.match(page, /node\.closest\(TURN_SELECTOR\)/);
  assert.match(page, /connection interrupted/);
  assert.match(page, /taking longer than expected/);
  assert.match(page, /timed out/);
  assert.match(page, /rate limit/);
});

test('active user, draft, upload and manual-stop safeguards are explicit and trusted-event based', () => {
  const status = text('extension/status-script.js');
  const monitor = text('extension/monitor-script.js');
  const boundedPage = text('extension/bounded-recovery-script.js');
  const policy = text('extension/status-policy.js');
  assert.match(status, /event\?\.isTrusted === true/);
  assert.match(status, /pointerdown/);
  assert.match(status, /keydown/);
  assert.match(status, /beforeinput/);
  assert.match(status, /compositionstart/);
  assert.match(monitor, /event\?\.isTrusted !== true/);
  assert.match(monitor, /manualStopped = true/);
  assert.match(boundedPage, /snapshot\?\.hasUpload/);
  assert.match(boundedPage, /snapshot\?\.manualStopped/);
  assert.match(boundedPage, /snapshot\?\.authRequired/);
  assert.match(boundedPage, /snapshot\?\.approvalRequired/);
  assert.match(boundedPage, /snapshot\?\.rateLimited/);
  assert.match(policy, /composer-not-empty/);
  assert.match(policy, /active-user-interaction/);
});

test('version-aware attachment re-arms stale listeners without activating frozen or discarded pages', () => {
  const attachment = text('extension/attachment-script.js');
  const boundedAttachment = text('extension/bounded-recovery-attachment-background.js');
  assert.match(attachment, /chrome\.runtime\.getManifest\(\)\.version/);
  assert.match(attachment, /__chatgptPromptBoundNotifierInstalled = false/);
  assert.match(attachment, /__chatgptNotifierStatusDomInstalled = false/);
  assert.match(text('extension/service-worker.js'), /attachment-script\.js/);
  assert.match(text('extension/recovery-background.js'), /attachment-script\.js/);
  assert.match(text('extension/monitor-background.js'), /monitor-script\.js/);
  assert.match(boundedAttachment, /bounded-recovery-script\.js/);
  assert.match(boundedAttachment, /tab\.discarded === true \|\| tab\.frozen === true/);
  assert.doesNotMatch(boundedAttachment, /tabs\.update\([^)]*active:\s*true/);
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

test('bounded recovery persists human-run lineage, incidents, profile lease and action counters before side effects', () => {
  const bounded = text('extension/bounded-recovery-background.js');
  assert.match(bounded, /HUMAN_RUN_STORE = 'human-runs'/);
  assert.match(bounded, /GENERATION_STORE = 'generations'/);
  assert.match(bounded, /INCIDENT_STORE = 'incidents'/);
  assert.match(bounded, /PROFILE_STORE = 'profile'/);
  assert.match(bounded, /MAPPING_STORE = 'automatic-prompts'/);
  assert.match(bounded, /database\.transaction\(\[HUMAN_RUN_STORE, INCIDENT_STORE, PROFILE_STORE\], 'readwrite'\)/);
  assert.match(bounded, /model\(\)\.claimAction/);
  assert.match(bounded, /humans\.put\(claimed\.humanRun\)/);
  assert.match(bounded, /profiles\.put\(\{ key: PROFILE_KEY, \.\.\.claimed\.profile \}\)/);
  assert.match(bounded, /incidents\.put\(claimed\.incident\)/);
  assert.match(bounded, /await chrome\.tabs\.reload\(generation\.ownerTabId\)/);
});

test('bounded recovery uses one earliest-deadline alarm and never foregrounds a tab automatically', () => {
  const bounded = text('extension/bounded-recovery-background.js');
  assert.match(bounded, /ALARM_NAME = 'chatgpt-notifier-recovery-deadline'/);
  assert.match(bounded, /chrome\.alarms\.create\(ALARM_NAME, \{ when \}\)/);
  assert.match(bounded, /incidents\[0\][\s\S]*processIncident\(incidents\[0\]\.incidentId\)/);
  assert.match(bounded, /chrome\.tabs\.reload\(generation\.ownerTabId\)/);
  assert.doesNotMatch(bounded, /tabs\.update\([^)]*active:\s*true/);
  assert.doesNotMatch(bounded, /windows\.update\([^)]*focused:\s*true/);
});

test('guarded recovery adapter sends only exact continuation or exact format repair after identity checks', () => {
  const page = text('extension/bounded-recovery-script.js');
  const contract = JSON.parse(text('extension/github-work-status-contract.v1.json'));
  assert.ok(page.includes(contract.formatRepairPrompt));
  assert.match(page, /AUTO_CONTINUE_TEXT = 'continue until you finish or need something from me'/);
  assert.match(page, /current\.conversationId !== expected\.conversationId/);
  assert.match(page, /current\.documentId !== expected\.documentId/);
  assert.match(page, /current\.promptKey !== expected\.promptKey/);
  assert.match(page, /current\.assistantKey === expected\.assistantKey/);
  assert.match(page, /current\.assistantRevision/);
  assert.match(page, /recovery-identity-changed-before-send/);
  assert.match(page, /matchingNewUserTurn/);
  assert.doesNotMatch(page, /regenerate/i);
  assert.doesNotMatch(page, /originalPrompt|original-prompt|resendPrompt/i);
});

test('existing INCOMPLETE_LIMIT continuation is admitted through the same whole-run fuse and passive request evidence', () => {
  const hook = text('extension/normal-continuation-budget-hook.js');
  assert.match(hook, /originalRequestContinuation = globalThis\.requestContinuation/);
  assert.match(hook, /admitNormalContinuation/);
  assert.match(hook, /finishNormalContinuation/);
  assert.match(hook, /continuationUserKey/);
  assert.match(hook, /evidence\?\.accepted === true/);
  assert.match(hook, /sameConversation/);
  assert.match(hook, /registerAutomaticPrompt|newPromptKey/);
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

test('recovery clears only after durable outcomes and all automation refuses frozen/discarded pages', () => {
  const recovery = text('extension/recovery-background.js');
  const worker = text('extension/service-worker.js');
  const monitor = text('extension/monitor-background.js');
  const bounded = text('extension/bounded-recovery-background.js');
  assert.match(recovery, /finalizeConversation:\s*clearPending/);
  assert.doesNotMatch(recovery, /message\?\.type === 'CHATGPT_RESPONSE_COMPLETE'[\s\S]{0,300}clearPending/);
  assert.match(worker, /finalizeRecovery\(turnRecord\.conversationId\)/);
  assert.match(worker, /tab\.discarded === true \|\| tab\.frozen === true/);
  assert.match(recovery, /tab\.discarded === true \|\| tab\.frozen === true/);
  assert.match(monitor, /tab\.discarded === true \|\| tab\.frozen === true/);
  assert.match(monitor, /page-unobservable/);
  assert.match(bounded, /tab\.discarded === true \|\| tab\.frozen === true/);
  assert.doesNotMatch(monitor, /tabs\.update\([^)]*active:\s*true/);
  assert.doesNotMatch(bounded, /tabs\.update\([^)]*active:\s*true/);
});

test('history remains a rolling 20 coded notifications', () => {
  const history = text('extension/history-background.js');
  assert.match(history, /const MAX_HISTORY = 20/);
  assert.match(history, /rememberEligibleCompletion/);
  assert.match(history, /GET_RECENT_NOTIFICATIONS/);
});

test('manifest adds only reviewed alarms permission for scheduled recovery wake', () => {
  const manifest = JSON.parse(text('extension/manifest.json'));
  assert.equal(manifest.version, '0.9.0');
  assert.deepEqual(manifest.permissions.sort(), ['alarms','scripting','tabs','webRequest'].sort());
  assert.deepEqual(manifest.host_permissions.sort(), ['https://chatgpt.com/*','ws://127.0.0.1/*'].sort());
  assert.deepEqual(manifest.content_scripts[0].js, [
    'attachment-script.js','content-script.js','persistence-script.js','status-code.js','status-policy.js','monitor-script.js','bounded-recovery-script.js','status-script.js','recovery-script.js'
  ]);
});

test('local JavaScript is syntactically valid', () => {
  for (const relative of [
    'extension/background.js','extension/service-worker.js','extension/attachment-script.js','extension/coordinator-background.js',
    'extension/recovery-background.js','extension/recovery-script.js','extension/history-background.js','extension/status-code.js',
    'extension/status-policy.js','extension/status-script.js','extension/monitor-background.js','extension/monitor-script.js',
    'extension/recovery-model.js','extension/monitor-query-compat-background.js','extension/recovery-control-background.js',
    'extension/bounded-recovery-background.js','extension/bounded-recovery-attachment-background.js','extension/bounded-recovery-script.js',
    'extension/normal-continuation-budget-hook.js','extension/persistence-script.js','extension/popup.js'
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
