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

test('completion detector matches the reviewed hidden-tab-safe source', () => {
  assert.equal(normalizedBlobSha('extension/content-script.js'), '4c8a571e62689cd2ce20eb5db05a91f6852f2b2a');
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
    text('extension/delivery-diagnostics-hook.js'),
    text('extension/delivery-reliability-background.js')
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
  assert.match(status, /AUTO_CONTINUE_PROMPT\s*=\s*'Continue until you finish or need something from me\.'/);
  assert.match(status, /function timestampedContinueText/);
  assert.match(status, /Intl\.DateTimeFormat/);
  assert.doesNotMatch(status, /composerText\([^)]*\)\s*===\s*''[^\n]*return\s*\{[^}]*ok:\s*true/);
  assert.match(worker, /state\.claimTurn\(status, claimOwner\)/);
  assert.match(worker, /processCodedCompletion\(status, owner/);
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
  assert.match(monitor, /interruptionAttribution:/);
  assert.match(monitor, /applicationStateIdentityMatched:/);
  assert.match(monitor, /applicationStateReason:/);
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


test('monitored chats use a 30-minute local code watchdog with a three-send cap and incomplete-code reset', () => {
  const status = text('extension/status-script.js');
  const monitor = text('extension/monitor-background.js');
  const policy = text('extension/status-policy.js');
  assert.match(monitor, /CODE_WATCHDOG_DELAY_MS = 30 \* 60_000/);
  assert.match(monitor, /CODE_WATCHDOG_MAX_SENDS = 3/);
  assert.match(monitor, /chatgpt-notifier-code-watchdog:/);
  assert.match(monitor, /chrome\.alarms\.create\(codeWatchdogAlarmName/);
  assert.match(monitor, /CHATGPT_WATCHDOG_CONTINUE_COMMAND/);
  assert.match(monitor, /retry-cap-reached/);
  assert.match(monitor, /resetCodeWatchdogForIncomplete/);
  assert.match(monitor, /isAutoContinueStatusCode/);
  assert.match(status, /performWatchdogContinuation/);
  assert.match(status, /function waitForWatchdogSendButton/);
  const watchdogWaitStart = status.indexOf('function waitForWatchdogSendButton');
  const watchdogWaitEnd = status.indexOf('function matchesExpected', watchdogWaitStart);
  const watchdogWait = status.slice(watchdogWaitStart, watchdogWaitEnd);
  assert.match(watchdogWait, /waitUntil\(\(\) => enabledSend\(node\)/);
  assert.doesNotMatch(watchdogWait, /stopPresent\(\)/);
  assert.match(monitor, /lastAutomaticPromptKey/);
  assert.match(monitor, /!requestChanged[\s\S]*Number\(current\.deadlineAt \|\| 0\) > 0[\s\S]*return current/);
  assert.match(status, /terminal-status-observed/);
  assert.match(status, /watchdog-continuation-user-turn-confirmed/);
  assert.match(policy, /'INCOMPLETE_LIMIT'/);
  assert.match(policy, /'INCOMPLETE_TOOL_FAILURE'/);
  assert.match(policy, /'INCOMPLETE_CONTINUE'/);
  assert.match(policy, /'INCOMPLETE_HANDOFF'/);
  assert.doesNotMatch(monitor, /\bfetch\s*\(/);
});

test('in-page auto-continue status is an opaque allowance-reset control scoped to its sender conversation', () => {
  const attachment = text('extension/attachment-script.js');
  const monitor = text('extension/monitor-background.js');

  assert.match(attachment, /document\.createElement\('button'\)/);
  assert.match(attachment, /RESET_CODE_WATCHDOG_BUDGET_FOR_SENDER/);
  assert.match(attachment, /resetAutomationBudget/);
  assert.match(attachment, /pointerEvents: 'auto'/);
  assert.match(attachment, /cursor: 'pointer'/);
  assert.match(attachment, /opacity: '1'/);
  assert.doesNotMatch(attachment, /opacity: '\.78'/);
  assert.match(attachment, /mouseenter/);
  assert.match(attachment, /border: '1px solid transparent'/);
  assert.match(attachment, /status\.style\.borderColor = 'currentColor'/);
  assert.match(attachment, /status\.style\.borderColor = 'transparent'/);
  assert.doesNotMatch(attachment, /0 0 0 1px var\(--border-light/);

  assert.match(monitor, /function codeWatchdogBudgetReset/);
  assert.match(monitor, /sendCount: 0/);
  assert.match(monitor, /stopReason \|\| ''\) === 'retry-cap-reached'/);
  assert.match(monitor, /deadlineAt: resetAt \+ CODE_WATCHDOG_DELAY_MS/);
  assert.match(monitor, /RESET_CODE_WATCHDOG_BUDGET_FOR_SENDER/);
  assert.match(monitor, /resetSenderCodeWatchdogBudget/);
  assert.match(monitor, /target-conversation-changed/);
  assert.match(monitor, /automation-not-active/);
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
  const policy = text('extension/status-policy.js');
  assert.match(page, /\[role="alert"\]/);
  assert.match(page, /node\.closest\?\.\(TURN_SELECTOR\)/);
  assert.match(page, /classifyApplicationText/);
  assert.match(page, /EXCLUDED_ERROR_CONTEXT_SELECTOR/);
  assert.match(policy, /connection interrupted/);
  assert.match(policy, /taking longer than expected/);
  assert.match(policy, /timed out/);
  assert.match(policy, /rate limit/);
  assert.match(policy, /response failed/);
  assert.match(policy, /disconnected/);
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

test('guarded recovery adapter sends only timestamped continuation after class-specific identity checks', () => {
  const page = text('extension/bounded-recovery-script.js');
  const contract = JSON.parse(text('extension/github-work-status-contract.v1.json'));
  assert.ok(page.includes(contract.formatRepairPrompt));
  assert.match(page, /AUTO_CONTINUE_PROMPT = 'Continue until you finish or need something from me\.'/);
  assert.match(page, /function timestampedContinueText/);
  assert.match(page, /current\.conversationId !== expected\.conversationId/);
  assert.match(page, /current\.documentId !== expected\.documentId/);
  assert.match(page, /current\.promptKey !== expected\.promptKey/);
  assert.match(page, /current\.promptRevision/);
  assert.match(page, /recoveryClass === 'explicit-interruption'/);
  assert.match(page, /currentExplicitInterruption/);
  assert.match(page, /silentIdleConfirmations/);
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
  const reliability = text('extension/delivery-reliability-background.js');
  assert.match(hook, /CHATGPT_MONITOR_STATE/);
  assert.match(hook, /scheduleObservedStatusDelivery/);
  assert.match(hook, /snapshot\.statusCode/);
  assert.match(hook, /sender\?\.documentId/);
  assert.match(hook, /enqueueObservation/);
  assert.match(hook, /processObservation/);
  assert.match(hook, /queryTerminalStatus\(observation\.tabId, observation\.chromeDocumentId, 10_000\)/);
  assert.match(hook, /state\.claimTurn\(status, owner\)/);
  assert.match(hook, /queueDurableNotification\(claimedRecord, 'coded-completion-status-observer'\)/);
  assert.doesNotMatch(hook, /codedSnapshotObservations/);
  assert.match(reliability, /OBSERVATION_STORE = 'terminal-observations'/);
  assert.match(reliability, /state: 'pending'/);
  assert.match(reliability, /state: 'in-flight'/);
  assert.match(reliability, /state: 'resolved'/);
});

test('coded delivery and background bootstrap failures persist sanitized helper diagnostics', () => {
  const wrapper = text('extension/background.js');
  const hook = text('extension/normal-continuation-budget-hook.js');
  const diagnostics = text('extension/delivery-diagnostics-hook.js');
  const reliability = text('extension/delivery-reliability-background.js');
  const app = text('src/ChatGPTResponseNotifier.Host/NativeHostApplication.cs');
  assert.match(wrapper, /reportBootstrapFailure/);
  assert.match(wrapper, /diagnostics\.event/);
  assert.match(wrapper, /import-scripts-failed/);
  assert.match(wrapper, /completion-binding-failed/);
  assert.match(diagnostics, /stage-events-are-authoritative/);
  assert.doesNotMatch(diagnostics, /queryTerminalStatus/);
  assert.match(hook, /monitor-terminal-seen/);
  assert.match(hook, /turn-claimed/);
  assert.match(reliability, /notification-durable-queued/);
  assert.match(reliability, /outbox-send-attempt/);
  assert.match(reliability, /helper-durable-accepted/);
  assert.match(reliability, /correlationId/);
  assert.match(reliability, /presentationState/);
  assert.match(app, /toast-presented/);
  assert.match(app, /toast-idempotent-accepted/);
  assert.match(app, /presentationState = showResult\.PresentationState/);
  for (const source of [diagnostics, reliability]) {
    assert.doesNotMatch(source, /promptText|assistantText/);
  }
});

test('continuation acceptance requires matching timestamped user turn plus passive accepted request evidence', () => {
  const status = text('extension/status-script.js');
  const worker = text('extension/service-worker.js');
  assert.match(status, /matchingContinuationUserTurn/);
  assert.match(status, /cleanComposer\(user\.text\) === cleanComposer\(expectedText\)/);
  assert.match(status, /timestampedContinueText/);
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
  assert.match(worker, /currentIdentity\.id !== String\(status\?\.conversationId \|\| ''\)/);
  assert.match(worker, /statusBoundToCompletion\(status, originIdentity, message\?\.response\)/);
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
  assert.equal(manifest.version, text('VERSION.txt').trim());
  assert.deepEqual(manifest.permissions.sort(), ['alarms','scripting','tabs','webRequest'].sort());
  assert.deepEqual(manifest.host_permissions.sort(), ['https://chatgpt.com/*','ws://127.0.0.1/*'].sort());
  assert.deepEqual(manifest.content_scripts[0].js, [
    'attachment-script.js','content-script.js','persistence-script.js','status-code.js','status-policy.js','monitor-script.js','bounded-recovery-script.js','status-script.js','recovery-script.js'
  ]);
});

test('local JavaScript is syntactically valid', () => {
  for (const relative of [
    'extension/background.js','extension/service-worker.js','extension/cross-desktop-click-fallback-background.js','extension/attachment-script.js','extension/coordinator-background.js',
    'extension/delivery-dedupe-hook.js','extension/delivery-reliability-background.js','extension/delivery-diagnostics-hook.js','extension/recovery-background.js','extension/recovery-script.js','extension/history-background.js','extension/status-code.js',
    'extension/status-policy.js','extension/status-script.js','extension/monitor-background.js','extension/monitor-script.js',
    'extension/recovery-model.js','extension/monitor-query-compat-background.js','extension/recovery-control-background.js',
    'extension/recovery-live-fix-background.js','extension/recovery-live-fix-content.js',
    'extension/bounded-recovery-background.js','extension/bounded-recovery-attachment-background.js','extension/bounded-recovery-script.js',
    'extension/normal-continuation-budget-hook.js','extension/persistence-script.js','extension/popup.js'
  ]) {
    const path = fileURLToPath(new URL(relative, root));
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${relative} failed syntax check:\n${result.stderr || result.stdout}`);
  }
});

test('notifier-owned Quick Continue light mirrors popup automation states without ChatGPT network traffic', () => {
  const attachment = text('extension/attachment-script.js');
  const monitor = text('extension/monitor-background.js');
  assert.match(attachment, /chatgpt-quick-continue-toolbar/);
  assert.match(attachment, /chatgpt-notifier-automation-indicator/);
  assert.match(attachment, /GET_BUILD_AUTOMATION_OVERVIEW_FOR_SENDER/);
  assert.match(attachment, /SET_BUILD_AUTOMATION_STATE_FOR_SENDER/);
  assert.match(attachment, /continueButton\.insertAdjacentElement\('beforebegin', indicator\)/);
  assert.match(attachment, /key: 'ready'[\s\S]*label: 'Monitor'/);
  assert.match(attachment, /key: 'enabled'[\s\S]*label: 'Pause'/);
  assert.match(attachment, /key: 'warning'[\s\S]*label: 'Resume'/);
  assert.doesNotMatch(attachment, /#3b82f6/);
  assert.match(attachment, /#22c55e/);
  assert.doesNotMatch(attachment, /#f59e0b/);
  assert.match(attachment, /#888888/);
  assert.match(attachment, /chatgpt-notifier-automation-status/);
  assert.match(attachment, /Next auto-continue/);
  assert.match(attachment, /Auto-continue due · waiting for/);
  assert.match(attachment, /Retrying auto-continue/);
  assert.match(attachment, /connection/);
  assert.doesNotMatch(attachment, /response to settle/);
  assert.doesNotMatch(attachment, /generation to finish/);
  assert.match(attachment, /Auto-continues exhausted/);
  assert.match(attachment, /setInterval\(tickAutomationStatus, 1000\)/);
  assert.match(attachment, /function automationOverviewIsFresh/);
  assert.match(attachment, /nextWatchdogRevision < currentWatchdogRevision/);
  assert.match(attachment, /nextWatchdogRevision === 0[\s\S]*currentWatchdogRevision === 0[\s\S]*nextWatchdogUpdatedAt < currentWatchdogUpdatedAt/);
  assert.match(attachment, /currentWatchdogUpdatedAt > 0[\s\S]*nextWatchdogUpdatedAt === 0/);
  assert.match(attachment, /current\.automationEnabled === true[\s\S]*next\.automationEnabled === true/);
  assert.match(attachment, /function applyAutomationOverview/);
  assert.match(attachment, /return applyAutomationOverview\(overview\)/);
  assert.match(monitor, /codeWatchdogMaxSends: CODE_WATCHDOG_MAX_SENDS/);
  assert.match(monitor, /function codeWatchdogOverviewSignature\(record\)/);
  assert.match(monitor, /const codeWatchdogMutationQueues = new Map\(\)/);
  assert.match(monitor, /function queueCodeWatchdogMutation\(conversationIdValue, operation\)/);
  assert.match(monitor, /function reconcileCodeWatchdog\(clean, sender\)[\s\S]*queueCodeWatchdogMutation/);
  assert.match(monitor, /function handleCodeWatchdogAlarm\(conversationId\)[\s\S]*queueCodeWatchdogMutation/);
  assert.match(monitor, /watchdogRevision: Math\.max\(0, Number\(existing\?\.watchdogRevision \|\| 0\)\) \+ 1/);
  assert.match(monitor, /queueCodeWatchdogMutation\(identity\.id, \(\) => clearCodeWatchdog\(identity\.id\)\)/);
  assert.match(monitor, /queueCodeWatchdogMutation\(target\.id, async \(\) =>/);
  assert.match(monitor, /watchdogChanged[\s\S]*publishAutomationOverview\(senderTarget\)/);
  assert.doesNotMatch(attachment, /automationBusy \? '\\.62'/);
  assert.doesNotMatch(attachment, /AUTOMATION_REFRESH_MS/);
  assert.doesNotMatch(attachment, /setInterval\(maintainAutomationIndicator/);
  assert.match(attachment, /if \(!overview\) return automationOverview/);
  assert.match(attachment, /visibility = 'hidden'/);
  assert.match(attachment, /boxShadow = 'none'/);
  assert.match(attachment, /new MutationObserver/);
  assert.doesNotMatch(attachment, /transition\s*:/);
  assert.doesNotMatch(attachment, /animation\s*:/);
  assert.doesNotMatch(attachment, /@keyframes/);
  assert.doesNotMatch(attachment, /\bfetch\s*\(/);
  assert.doesNotMatch(attachment, /XMLHttpRequest/);
  assert.match(monitor, /function senderChatTarget\(sender\)/);
  assert.match(monitor, /async function setSenderAutomation\(message, sender\)/);
  assert.match(monitor, /BUILD_AUTOMATION_STATE_CHANGED/);
});

test('canonical project continuation prompts are fresh enrollment evidence without weakening explicit Pause', () => {
  const monitorPage = text('extension/monitor-script.js');
  const monitorWorker = text('extension/monitor-background.js');

  assert.match(monitorPage, /RUNTIME_VERSION = 11/);
  assert.match(monitorPage, /function userHasCanonicalProjectStart/);
  assert.match(monitorPage, /from canonical GitHub state/);
  assert.match(monitorPage, /projectStartSignal: userHasCanonicalProjectStart\(userText\)/);
  assert.match(monitorPage, /projectStartSignal: turnState\.projectStartSignal === true/);

  assert.match(monitorWorker, /projectStartSignal: snapshot\.projectStartSignal === true/);
  assert.match(monitorWorker, /clean\.projectStartSignal === true \|\| clean\.workStartSignal === true \|\| statusIsValid/);
  assert.match(monitorWorker, /'project-start-signal'/);
  assert.match(monitorWorker, /enrollment\?\.enabled !== true && enrollment\?\.userPaused !== true/);

  const provisionalMigrationStart = monitorWorker.indexOf('async function migrateProvisionalIfReady');
  const provisionalMigrationEnd = monitorWorker.indexOf('async function handleSnapshot', provisionalMigrationStart);
  const provisionalMigration = monitorWorker.slice(provisionalMigrationStart, provisionalMigrationEnd);
  assert.match(provisionalMigration, /if \(Number\(provisional\.armedAt \|\| 0\) <= 0\) \{\s*return null;/);
  assert.doesNotMatch(provisionalMigration, /deleteRecord\(PROFILE_STORE, provisionalKey\(tabId\)\)[\s\S]{0,120}return null/);
});

test('terminal watchdog state is sticky and stale attachment generations cannot repaint the current timer', () => {
  const monitorPage = text('extension/monitor-script.js');
  const statusPage = text('extension/status-script.js');
  const monitorWorker = text('extension/monitor-background.js');
  const attachment = text('extension/attachment-script.js');

  assert.match(monitorPage, /stickyTerminalPromptKey/);
  assert.match(monitorPage, /stickyTerminalStatusCode/);
  assert.match(statusPage, /RUNTIME_VERSION = 13/);
  assert.match(statusPage, /stickyTerminalPromptKey/);
  assert.match(statusPage, /stickyTerminalStatusCode/);

  assert.match(monitorWorker, /async function parkCodeWatchdogForTerminalStatus/);
  assert.match(monitorWorker, /stopReason: `status:\$\{String\(clean\?\.statusCode/);
  assert.match(monitorWorker, /return await parkCodeWatchdogForTerminalStatus\(clean, sender, current\)/);
  assert.match(monitorWorker, /await parkCodeWatchdogForTerminalStatus\(statusSnapshot, \{ tab \}, record\)/);
  assert.match(monitorWorker, /await parkCodeWatchdogForTerminalStatus\(\s*\{ \.\.\.live, statusCode: racedStatusCode \}/);
  assert.match(monitorWorker, /lastAutomaticParentPromptKey/);
  assert.match(monitorWorker, /previousStatusCode/);
  assert.match(monitorWorker, /isAutomaticFollowup/);
  assert.match(monitorPage, /previousPromptTerminalState/);
  assert.match(monitorPage, /previousStatusCode: previousPromptTerminal\.statusCode/);

  assert.match(attachment, /chatgpt-notifier-automation-indicator-v\$\{ATTACHMENT_RUNTIME_VERSION\}/);
  assert.match(attachment, /chatgpt-notifier-automation-status-v\$\{ATTACHMENT_RUNTIME_VERSION\}/);
  assert.match(attachment, /AUTOMATION_RUNTIME_STYLE_ID/);
  assert.match(attachment, /display: none !important/);
  assert.match(attachment, /\[id\^="chatgpt-notifier-automation-indicator-v"\]:not/);
  assert.match(attachment, /\[id\^="chatgpt-notifier-automation-status-v"\]:not/);
});

test('extension update hot-activates reload-safe watchdog page runtimes in already-open chats', () => {
  const attachment = text('extension/attachment-script.js');
  const monitor = text('extension/monitor-background.js');

  assert.match(attachment, /ATTACHMENT_RUNTIME_VERSION = 12/);
  assert.match(attachment, /CHATGPT_NOTIFIER_ATTACHMENT_PING/);
  assert.match(attachment, /runtimeVersion: ATTACHMENT_RUNTIME_VERSION/);
  assert.match(attachment, /extensionVersion/);

  assert.match(monitor, /HOT_PAGE_ATTACHMENT_RUNTIME_VERSION = 12/);
  assert.match(monitor, /HOT_PAGE_MONITOR_RUNTIME_VERSION = 11/);
  assert.match(monitor, /HOT_PAGE_STATUS_RUNTIME_VERSION = 13/);
  assert.match(monitor, /HOT_PAGE_BOUNDED_RECOVERY_RUNTIME_VERSION = 3/);
  assert.match(monitor, /async function queryHotPageRuntime/);
  assert.match(monitor, /async function ensureHotPageRuntime/);
  assert.match(monitor, /CHATGPT_NOTIFIER_ATTACHMENT_PING/);
  assert.match(monitor, /CHATGPT_STATUS_RUNTIME_PING/);
  assert.match(monitor, /CHATGPT_BOUNDED_RECOVERY_PING/);
  assert.match(monitor, /CHATGPT_MONITOR_QUERY/);
  assert.match(monitor, /String\(attachment\.extensionVersion \|\| ''\) === expectedExtensionVersion/);
  assert.match(monitor, /files: \[\.\.\.HOT_PAGE_RUNTIME_FILES\]/);
  assert.match(monitor, /await ensureHotPageRuntime\(tab\.id\)/);
  assert.doesNotMatch(monitor, /HOT_PAGE_RUNTIME_FILES[\s\S]{0,400}'content-script\.js'/);
  assert.doesNotMatch(monitor, /HOT_PAGE_RUNTIME_FILES[\s\S]{0,400}'persistence-script\.js'/);
  assert.doesNotMatch(monitor, /HOT_PAGE_RUNTIME_FILES[\s\S]{0,400}'recovery-script\.js'/);
  assert.doesNotMatch(monitor, /ensureHotPageRuntime[\s\S]{0,1400}tabs\.reload/);
  assert.doesNotMatch(monitor, /ensureHotPageRuntime[\s\S]{0,1400}tabs\.update\([^)]*active:\s*true/);
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
