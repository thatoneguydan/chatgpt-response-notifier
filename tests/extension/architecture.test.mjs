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

test('background composition loads policy, unified automation owner, recovery and diagnostics in dependency order', () => {
  const wrapper = text('extension/background.js');
  assert.match(wrapper, /status-code\.js[\s\S]*status-policy\.js[\s\S]*recovery-model\.js[\s\S]*coordinator-background\.js[\s\S]*delivery-dedupe-hook\.js[\s\S]*recovery-background\.js[\s\S]*history-background\.js[\s\S]*monitor-background\.js[\s\S]*monitor-query-compat-background\.js[\s\S]*recovery-control-background\.js[\s\S]*bounded-recovery-background\.js[\s\S]*bounded-recovery-attachment-background\.js[\s\S]*service-worker\.js[\s\S]*normal-continuation-budget-hook\.js[\s\S]*delivery-diagnostics-hook\.js/);
});

test('monitoring and bounded recovery observe page/request state but create no ChatGPT HTTP traffic', () => {
  const sources = [
    text('extension/service-worker.js'),
    text('extension/recovery-background.js'),
    text('extension/status-script.js'),
    text('extension/coordinator-background.js'),
    text('extension/delivery-dedupe-hook.js'),
    text('extension/monitor-background.js'),
    text('extension/monitor-script.js'),
    text('extension/bounded-recovery-background.js'),
    text('extension/bounded-recovery-script.js'),
    text('extension/normal-continuation-budget-hook.js'),
    text('extension/delivery-diagnostics-hook.js')
  ];
  const worker = sources[0];
  const monitor = sources[5];
  const bounded = sources[7];
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

test('passive monitored-build observer persists identity and scope signal without raw prompt or assistant content', () => {
  const page = text('extension/monitor-script.js');
  const monitor = text('extension/monitor-background.js');
  assert.match(page, /promptRevision/);
  assert.match(page, /assistantRevision/);
  assert.match(page, /workStartSignal/);
  assert.match(page, /CHATGPT_MONITOR_STATE/);
  assert.match(page, /silentIdleConfirmations/);
  assert.match(page, /stableTerminal/);
  assert.match(monitor, /ENROLLMENT_STORE = 'enrollments'/);
  assert.match(monitor, /RUN_STORE = 'runs'/);
  assert.match(monitor, /runKey\(snapshot\)/);
  assert.match(monitor, /promptRevision:/);
  assert.match(monitor, /assistantRevision:/);
  assert.match(monitor, /workStartSignal:/);
  assert.doesNotMatch(monitor, /promptText\s*:/);
  assert.doesNotMatch(monitor, /assistantText\s*:/);
  assert.doesNotMatch(monitor, /responseText\s*:/);
});

test('monitor query compatibility preserves passive wrapper while exposing direct identity fields to recovery', () => {
  const compat = text('extension/monitor-query-compat-background.js');
  assert.match(compat, /message\?\.type !== 'CHATGPT_MONITOR_QUERY'/);
  assert.match(compat, /result\?\.snapshot/);
  assert.match(compat, /\{ \.\.\.result\.snapshot, \.\.\.result, snapshot: result\.snapshot \}/);
});

test('one authoritative automation state enables monitoring and recovery together with sticky operator Pause', () => {
  const monitor = text('extension/monitor-background.js');
  const recoveryControl = text('extension/recovery-control-background.js');
  const popup = text('extension/popup.js');
  const popupHtml = text('extension/popup.html');
  assert.match(monitor, /AUTOMATION_SCHEMA_VERSION = 2/);
  assert.match(monitor, /SET_BUILD_AUTOMATION_STATE/);
  assert.match(monitor, /recoveryEnabled:\s*isEnabled/);
  assert.match(monitor, /userPaused:\s*paused/);
  assert.match(monitor, /operator-pause/);
  assert.match(monitor, /expectedRevision/);
  assert.match(monitor, /state-revision-mismatch/);
  assert.match(monitor, /automationEnabled:\s*state\?\.enabled === true/);
  assert.match(recoveryControl, /legacyReadOnly:\s*true/);
  assert.match(recoveryControl, /sole writable owner/);
  assert.doesNotMatch(recoveryControl, /async function setConfig/);
  assert.match(popup, /GET_BUILD_AUTOMATION_OVERVIEW/);
  assert.match(popup, /SET_BUILD_AUTOMATION_STATE/);
  assert.match(popup, /expectedRevision:/);
  assert.match(popup, /requestId/);
  assert.match(popup, /state unconfirmed/);
  assert.match(popupHtml, />Build automation</);
  assert.match(popupHtml, /id="automationToggle"/);
  assert.doesNotMatch(popupHtml, /id="recoveryToggle"/);
  assert.doesNotMatch(popupHtml, /id="resumeRecovery"/);
  assert.doesNotMatch(monitor, /https:\/\/(?:api\.)?github\.com/i);
});

test('build START scope is exact, assistant-only, fresh-request-bound and terminal code remains fallback', () => {
  const parser = text('extension/status-code.js');
  const page = text('extension/monitor-script.js');
  const monitor = text('extension/monitor-background.js');
  assert.match(parser, /WORK_START_SIGNAL = '\[GITHUB_WORK: START\]'/);
  assert.match(parser, /WORK_START_LINE_PATTERN = \/\^\\\[GITHUB_WORK: START\\\]\$\//);
  assert.match(page, /assistantHasWorkStart/);
  assert.match(page, /ChatGPTNotifierStatusCode\?\.isWorkStartSignal/);
  assert.match(page, /pre, code, blockquote, ul, ol, li/);
  assert.match(page, /data-message-author-role="tool"/);
  assert.match(page, /parser\(line\) === true/);
  assert.doesNotMatch(page, /WORK_START_LINE\s*=/);
  assert.match(monitor, /freshRequestEvidence/);
  assert.match(monitor, /clean\.workStartSignal === true \|\| statusIsValid/);
  assert.match(monitor, /enrollment\?\.userPaused !== true/);
  assert.match(monitor, /'work-start-signal'\s*:\s*'coded-turn'/);
});

test('manual pre-conversation Monitor is provisional and binds only after the next observed request', () => {
  const monitor = text('extension/monitor-background.js');
  assert.match(monitor, /automation-provisional:/);
  assert.match(monitor, /armProvisionalForRequest/);
  assert.match(monitor, /armedRequestId/);
  assert.match(monitor, /armedAt/);
  assert.match(monitor, /migrateProvisionalIfReady/);
  assert.match(monitor, /Number\(provisional\.armedAt \|\| 0\) <= 0/);
});

test('closing a tab is quiet and duplicate conversation ownership is reconciled without foregrounding', () => {
  const monitor = text('extension/monitor-background.js');
  assert.match(monitor, /noteTabClosedQuiet/);
  assert.match(monitor, /owner-transferred-after-close/);
  assert.match(monitor, /owner-tab-closed-quiet/);
  assert.match(monitor, /state:\s*'detached'/);
  assert.match(monitor, /function closeDerivedReason/);
  assert.match(monitor, /includes\('owner-tab-closed'\)/);
  assert.match(monitor, /const conversationId = tabConversations\.get\(tabId\) \|\| '';\s*const provisional = await getProvisional\(tabId\)/);
  assert.doesNotMatch(monitor, /noteTabUnobservable\(tabId, 'owner-tab-closed'\)/);
  assert.doesNotMatch(monitor, /tabs\.update\([^)]*active:\s*true/);
  assert.doesNotMatch(monitor, /windows\.update\([^)]*focused:\s*true/);
});

test('Pause vetoes normal INCOMPLETE_LIMIT automatic continuation at final action admission', () => {
  const hook = text('extension/normal-continuation-budget-hook.js');
  assert.match(hook, /getEnrollment/);
  assert.match(hook, /enrollment\?\.enabled !== true/);
  assert.match(hook, /enrollment\?\.recoveryEnabled !== true/);
  assert.match(hook, /enrollment\?\.userPaused === true/);
  assert.match(hook, /build-automation-paused/);
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
  assert.match(monitor, /!closeDerivedReason\(item\.reason\)/);
  assert.match(monitor, /currentRun\?\.state === 'detached'/);
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

test('version-aware attachment re-arms stale listeners and wakes sleeping workers without foregrounding', () => {
  const attachment = text('extension/attachment-script.js');
  const boundedAttachment = text('extension/bounded-recovery-attachment-background.js');
  assert.match(attachment, /chrome\.runtime\.getManifest\(\)\.version/);
  assert.match(attachment, /__chatgptPromptBoundNotifierInstalled = false/);
  assert.match(attachment, /__chatgptNotifierStatusDomInstalled = false/);
  assert.match(attachment, /PING_NATIVE_HOST/);
  assert.match(attachment, /setInterval\(pingHelperVersion, 30000\)/);
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

test('logical-turn delivery dedupe coalesces rerendered revisions and settles generic titles', () => {
  const hook = text('extension/delivery-dedupe-hook.js');
  assert.match(hook, /logicalDeliveryKey/);
  assert.match(hook, /conversationId\}\|\$\{promptKey\}\|\$\{assistantKey/);
  assert.match(hook, /already-delivered-logical-turn/);
  assert.match(hook, /logical-turn-in-flight/);
  assert.match(hook, /PENDING_LEASE_MS = 30_000/);
  assert.match(hook, /meaningfulTitle/);
  assert.match(hook, /chrome\.tabs\.get\(owner\.tabId\)/);
  assert.match(hook, /notificationTitle:\s*title/);
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

test('DOM-observed terminal monitor state drives the durable coded-delivery path', () => {
  const hook = text('extension/normal-continuation-budget-hook.js');
  assert.match(hook, /CHATGPT_MONITOR_STATE/);
  assert.match(hook, /scheduleObservedStatusDelivery/);
  assert.match(hook, /snapshot\.statusCode/);
  assert.match(hook, /codedSnapshotObservations/);
  assert.match(hook, /observeCodedCompletion\(tabId, `monitor-status:/);
  assert.match(hook, /state\.claimTurn\(status, owner\)/);
  assert.match(hook, /queueDurableNotification\(record, 'coded-completion-status-observer'\)/);
});

test('coded delivery and background bootstrap failures persist sanitized helper diagnostics', () => {
  const wrapper = text('extension/background.js');
  const diagnostics = text('extension/delivery-diagnostics-hook.js');
  assert.match(wrapper, /reportBootstrapFailure/);
  assert.match(wrapper, /diagnostics\.event/);
  assert.match(wrapper, /import-scripts-failed/);
  assert.match(wrapper, /completion-binding-failed/);
  assert.match(diagnostics, /CHATGPT_MONITOR_STATE/);
  assert.match(diagnostics, /monitor-terminal-seen/);
  assert.match(diagnostics, /status-query-valid/);
  assert.match(diagnostics, /delivery-turn-missing/);
  assert.match(diagnostics, /delivery-outbox-pending/);
  assert.match(diagnostics, /conversationSuffix/);
  assert.doesNotMatch(diagnostics, /promptText|assistantText|responseText|responseBody/);
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

test('completion is bound to originating conversation, document and rendered response before claim', () => {
  const worker = text('extension/service-worker.js');
  assert.match(worker, /senderDocumentId = String\(sender\.documentId/);
  assert.match(worker, /queryTerminalStatus\(tabId, senderDocumentId\)/);
  assert.match(worker, /statusBoundToCompletion\(status, originIdentity, message\?\.response\)/);
  assert.match(worker, /upstream === observed/);
  assert.match(worker, /currentIdentity\.id !== originIdentity\.id/);
});

test('split-footer completion binding accepts exact detector body and stable turn identity while preserving identity checks', () => {
  const wrapper = text('extension/background.js');
  assert.match(wrapper, /statusBoundToCompletionSplitRenderCompat/);
  assert.match(wrapper, /String\(status\.conversationId \|\| ''\) !== originIdentity\.id/);
  assert.match(wrapper, /!status\.documentId \|\| !status\.promptKey \|\| !status\.assistantKey \|\| !status\.revision/);
  assert.match(wrapper, /upstream === fullObserved/);
  assert.match(wrapper, /upstream === parsedBody/);
  assert.match(wrapper, /parseCompletionFingerprint/);
  assert.match(wrapper, /context\.promptTurnId === promptTurnId/);
  assert.match(wrapper, /context\.assistantKey === String\(status\.assistantKey/);
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

test('split rendered assistant blocks preserve terminal footer evidence and suppress format repair', () => {
  const status = text('extension/status-script.js');
  const monitor = text('extension/monitor-script.js');
  for (const source of [status, monitor]) {
    assert.match(source, /function renderedBlocks/);
    assert.match(source, /querySelectorAll\?\.\('\.markdown'\)/);
    assert.match(source, /querySelectorAll\?\.\('\[class\*="prose"\]'\)/);
    assert.match(source, /new Set\(\[\.\.\.markdown, \.\.\.prose\]\)/);
    assert.match(source, /blocks\.map\(nodeText\)\.filter\(Boolean\)\.join\('\\n'\)/);
    assert.match(source, /function assistantStatusCodeFromDom/);
    assert.match(source, /pre, code, blockquote, ul, ol, li/);
    assert.match(source, /api\.isStatusCode\(match\[1\]\)/);
  }
  assert.match(monitor, /hasStatusEvidence:\s*Boolean\(domStatusCode/);
  assert.match(monitor, /current\.statusCode \|\| current\.hasStatusEvidence/);
  assert.match(monitor, /next\.statusCode \|\| next\.hasStatusEvidence/);
});

test('versioned updates self-activate helper and extension runtime without foregrounding Chrome', () => {
  const worker = text('extension/service-worker.js');
  const attachment = text('extension/attachment-script.js');
  const app = text('src/ChatGPTResponseNotifier.Host/NativeHostApplication.cs');
  const updater = text('src/ChatGPTResponseNotifier.Host/PublicUpdateService.cs');
  assert.match(worker, /function maybeReloadForInstalledVersion/);
  assert.match(worker, /chrome\.runtime\.reload\(\)/);
  assert.match(attachment, /PING_NATIVE_HOST/);
  assert.match(attachment, /activation-heartbeat/);
  assert.match(app, /StartupRegistration\.Register\(result\.InstalledBundle\.HostExecutablePath\)/);
  assert.match(app, /ScheduleReplacementIfNeeded/);
  assert.match(app, /CreateNoWindow = true/);
  assert.match(app, /--wait-for-pid/);
  assert.match(updater, /BundleInstaller\.InstallArchive/);
});

test('manifest adds only reviewed alarms permission for scheduled recovery wake', () => {
  const manifest = JSON.parse(text('extension/manifest.json'));
  assert.equal(manifest.version, '0.9.7');
  assert.deepEqual(manifest.permissions.sort(), ['alarms','scripting','tabs','webRequest'].sort());
  assert.deepEqual(manifest.host_permissions.sort(), ['https://chatgpt.com/*','ws://127.0.0.1/*'].sort());
  assert.deepEqual(manifest.content_scripts[0].js, [
    'attachment-script.js','content-script.js','persistence-script.js','status-code.js','status-policy.js','monitor-script.js','bounded-recovery-script.js','status-script.js','recovery-script.js'
  ]);
});

test('local JavaScript is syntactically valid', () => {
  for (const relative of [
    'extension/background.js','extension/service-worker.js','extension/attachment-script.js','extension/coordinator-background.js',
    'extension/delivery-dedupe-hook.js','extension/delivery-diagnostics-hook.js','extension/recovery-background.js','extension/recovery-script.js','extension/history-background.js','extension/status-code.js',
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

test('Glass release acceptance cannot stop or bind over the live notifier', () => {
  const setup = text('installer/Program.cs');
  const release = text('.github/workflows/release.yml');
  const bridge = text('src/ChatGPTResponseNotifier.Core/LocalBridgeConstants.cs');
  assert.match(setup, /InstallRootOverrideEnvironmentVariable/);
  assert.match(setup, /process\.MainModule\?\.FileName/);
  assert.match(setup, /processPath\.StartsWith\(isolatedRoot, StringComparison\.OrdinalIgnoreCase\)/);
  assert.match(setup, /if \(!isolatedInstall\)[\s\S]{0,160}StartupRegistration\.Unregister\(\)/);
  assert.match(release, /CHATGPT_RESPONSE_NOTIFIER_TEST_BRIDGE_PORT/);
  assert.match(release, /System\.Net\.Sockets\.TcpListener/);
  assert.match(release, /Remove-Item Env:CHATGPT_RESPONSE_NOTIFIER_TEST_BRIDGE_PORT/);
  assert.match(release, /\$testRootFull/);
  assert.doesNotMatch(release, /Get-Process -Name 'ChatGPTResponseNotifier\.Host'[^\r\n]*\|\s*Stop-Process/);
  assert.match(bridge, /CHATGPT_RESPONSE_NOTIFIER_INSTALL_ROOT/);
  assert.match(bridge, /CHATGPT_RESPONSE_NOTIFIER_TEST_BRIDGE_PORT/);
});

test('obsolete polling/action-button recovery files stay deleted and helper toast UX stays non-activating', () => {
  assert.equal(existsSync(new URL('extension/recovery-watchdog.js', root)), false);
  assert.equal(existsSync(new URL('extension/lib/server-capture.js', root)), false);
  const window = text('src/ChatGPTResponseNotifier.Host/ToastWindow.cs');
  assert.match(window, /ShowActivated\s*=\s*false/);
  assert.doesNotMatch(window, /Text\s*=\s*record\.Preview/);
});
