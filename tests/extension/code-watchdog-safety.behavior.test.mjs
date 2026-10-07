import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const monitorSource = readFileSync(new URL('extension/monitor-background.js', root), 'utf8');
const monitorPageSource = readFileSync(new URL('extension/monitor-script.js', root), 'utf8');
const statusSource = readFileSync(new URL('extension/status-script.js', root), 'utf8');
const attachmentSource = readFileSync(new URL('extension/attachment-script.js', root), 'utf8');

function loadEligibility() {
  const start = monitorSource.indexOf('function codeWatchdogNoCodeEligibility');
  const end = monitorSource.indexOf('async function handleCodeWatchdogAlarm', start);
  assert.ok(start >= 0 && end > start, 'watchdog no-code eligibility helper must exist');
  const context = vm.createContext({ String, Number, Array, globalThis: null });
  context.globalThis = context;
  vm.runInContext(`${monitorSource.slice(start, end)}\nglobalThis.__eligibility = codeWatchdogNoCodeEligibility;`, context);
  return context.__eligibility;
}

test('Monitor indicator freshness is keyed only to conversation and automation revision after legacy timer retirement', () => {
  const start = attachmentSource.indexOf('function automationOverviewIsFresh');
  const end = attachmentSource.indexOf('function publishPrimaryWatchdogAuthority', start);
  assert.ok(start >= 0 && end > start, 'automation overview freshness helper must exist');
  const context = vm.createContext({ String, Number, Math, globalThis: null });
  context.globalThis = context;
  vm.runInContext(`${attachmentSource.slice(start, end)}\nglobalThis.__fresh = automationOverviewIsFresh;`, context);
  const fresh = context.__fresh;

  const current = {
    activeConversationId: 'conversation-1',
    stateRevision: 4,
    automationEnabled: true
  };
  assert.equal(fresh({ activeConversationId: 'conversation-1', stateRevision: 4, automationEnabled: true }, current), true);
  assert.equal(fresh({ activeConversationId: 'conversation-1', stateRevision: 3, automationEnabled: true }, current), false);
  assert.equal(fresh({ activeConversationId: 'conversation-1', stateRevision: 5, automationEnabled: false }, current), true);
  assert.equal(fresh({ activeConversationId: 'conversation-2', stateRevision: 1, automationEnabled: true }, current), true);
});

test('all watchdog state mutations share one per-conversation queue and records have logical revisions', () => {
  assert.match(monitorSource, /const codeWatchdogMutationQueues = new Map\(\)/);
  assert.match(monitorSource, /function queueCodeWatchdogMutation\(conversationIdValue, operation\)/);
  assert.match(monitorSource, /function reconcileCodeWatchdog\(clean, sender\)[\s\S]*queueCodeWatchdogMutation/);
  assert.match(monitorSource, /function handleCodeWatchdogAlarm\(conversationId\)[\s\S]*queueCodeWatchdogMutation/);
  assert.match(monitorSource, /queueCodeWatchdogMutation\(identity\.id, \(\) => clearCodeWatchdog\(identity\.id\)\)/);
  assert.match(monitorSource, /queueCodeWatchdogMutation\(target\.id, async \(\) =>/);
  assert.match(monitorSource, /watchdogRevision: Math\.max\(0, Number\(existing\?\.watchdogRevision \|\| 0\)\) \+ 1/);
  assert.match(monitorSource, /async function reconcileCodeWatchdogState/);
  assert.match(monitorSource, /async function handleCodeWatchdogAlarmState/);
});

test('terminal watchdog state is prompt-scoped across request/DOM ordering races', () => {
  const statusStart = monitorSource.indexOf('function statusSnapshotBelongsToCurrentWatchdog');
  const statusEnd = monitorSource.indexOf('function stoppedWatchdogStillOwnsSnapshot', statusStart);
  const stoppedStart = statusEnd;
  const stoppedEnd = monitorSource.indexOf('async function reconcileCodeWatchdogState', stoppedStart);
  assert.ok(statusStart >= 0 && statusEnd > statusStart && stoppedEnd > stoppedStart, 'prompt-scoped watchdog helpers must exist');

  const context = vm.createContext({
    String,
    Number,
    Math,
    Boolean,
    globalThis: null,
    CODE_WATCHDOG_AUTOMATIC_REQUEST_WINDOW_MS: 15_000
  });
  context.globalThis = context;
  vm.runInContext(
    `${monitorSource.slice(statusStart, stoppedEnd)}\nglobalThis.__statusBelongs = statusSnapshotBelongsToCurrentWatchdog;\nglobalThis.__stoppedOwns = stoppedWatchdogStillOwnsSnapshot;`,
    context
  );

  const statusBelongs = context.__statusBelongs;
  const stoppedOwns = context.__stoppedOwns;
  const currentActive = {
    lastPromptKey: 'conversation-1|user-new',
    lastRequestStartedAt: 200_000,
    stopped: false
  };

  assert.equal(statusBelongs({ promptKey: 'conversation-1|user-old', requestStartedAt: 200_000 }, currentActive), false);
  assert.equal(statusBelongs({ promptKey: 'conversation-1|user-new', requestStartedAt: 200_000 }, currentActive), true);
  assert.equal(statusBelongs({ promptKey: 'conversation-1|user-later', requestStartedAt: 200_001 }, currentActive), true);
  assert.equal(statusBelongs({
    promptKey: 'conversation-1|user-parent',
    requestStartedAt: 200_000
  }, {
    lastPromptKey: 'conversation-1|user-auto-child',
    lastRequestStartedAt: 200_000,
    lastAutomaticPromptKey: 'conversation-1|user-auto-child',
    lastAutomaticParentPromptKey: 'conversation-1|user-parent'
  }), true);

  const stopped = {
    stopped: true,
    lastPromptKey: 'conversation-1|user-old',
    lastRequestStartedAt: 100_000,
    lastAutomaticSentAt: 0,
    lastAutomaticPromptKey: ''
  };
  assert.equal(stoppedOwns({ promptKey: 'conversation-1|user-old', requestStartedAt: 200_000 }, stopped), true);
  assert.equal(stopped.lastRequestStartedAt, 100_000);
  assert.equal(stoppedOwns({ promptKey: 'conversation-1|user-new', requestStartedAt: 200_000 }, stopped), false);
});

test('watchdog no-code path preserves explicit blockers while observation uncertainty fails open', () => {
  const eligibility = loadEligibility();
  const blockers = [
    ['online', false, 'offline'],
    ['authRequired', true, 'auth-required'],
    ['approvalRequired', true, 'approval-required'],
    ['rateLimited', true, 'rate-limited'],
    ['hasDraft', true, 'draft-present'],
    ['hasUpload', true, 'upload-present']
  ];
  for (const [field, value, reason] of blockers) {
    assert.deepEqual(
      { ...eligibility({ requestPhase: 'completed', assistantKey: 'assistant-1', stableTerminal: true, [field]: value }) },
      { eligible: false, reason },
      field
    );
  }

  for (const snapshot of [
    { observable: false },
    { applicationStateIdentityMatched: false }
  ]) {
    assert.deepEqual(
      { ...eligibility({ requestPhase: 'completed', assistantKey: 'assistant-1', stableTerminal: true, ...snapshot }) },
      { eligible: true, reason: 'deadline-no-code-fail-open' }
    );
  }
});

test('watchdog no-code deadline remains authoritative even while generation is active or unsettled', () => {
  const eligibility = loadEligibility();
  const cases = [
    { requestPhase: 'started', stopGenerating: true, toolActivity: true, assistantKey: 'assistant-1', stableTerminal: false },
    { requestPhase: 'unknown', stopGenerating: false, toolActivity: false, assistantKey: 'assistant-1', stableTerminal: false },
    { requestPhase: 'completed', manualStopped: true, assistantKey: '', silentIdleConfirmations: 0 },
    { requestPhase: 'completed', assistantKey: '', silentIdleConfirmations: 1 }
  ];
  for (const snapshot of cases) {
    assert.deepEqual({ ...eligibility(snapshot) }, { eligible: true, reason: 'deadline-no-code-fail-open' });
  }
});

test('status runtime generation advances for the semantic-turn page behavior', () => {
  assert.match(statusSource, /const RUNTIME_VERSION = 17/);
  assert.match(monitorPageSource, /const RUNTIME_VERSION = 14/);
});

test('rendered status fallback accepts duplicate copies of one terminal footer but rejects conflicts', () => {
  const start = statusSource.indexOf('function terminalStatusCodeFromRenderedText');
  const end = statusSource.indexOf('function assistantStatusCodeFromDom', start);
  assert.ok(start >= 0 && end > start, 'strict rendered-status helper must exist');
  const context = vm.createContext({
    String,
    globalThis: null,
    ChatGPTNotifierStatusCode: {
      isStatusCode(value) {
        return ['COMPLETE_APPLIED', 'COMPLETE_NO_CHANGES', 'INCOMPLETE_CONTINUE', 'BLOCKED_HUMAN'].includes(String(value || ''));
      }
    }
  });
  context.globalThis = context;
  vm.runInContext(`${statusSource.slice(start, end)}\nglobalThis.__parseRenderedStatus = terminalStatusCodeFromRenderedText;`, context);
  const parse = context.__parseRenderedStatus;

  assert.equal(parse('Work finished.\n[GITHUB_STATUS: COMPLETE_APPLIED]'), 'COMPLETE_APPLIED');
  assert.equal(parse('Work finished.\n[GITHUB_STATUS: COMPLETE_APPLIED]\n[GITHUB_STATUS: COMPLETE_APPLIED]'), 'COMPLETE_APPLIED');
  assert.equal(parse('Nothing remains.\n[GITHUB_STATUS: COMPLETE_NO_CHANGES]\n[GITHUB_STATUS: COMPLETE_NO_CHANGES]'), 'COMPLETE_NO_CHANGES');
  assert.equal(parse('[GITHUB_STATUS: COMPLETE_APPLIED]\nMore work remains.'), '');
  assert.equal(parse('Previous footer: [GITHUB_STATUS: COMPLETE_APPLIED]'), '');
  assert.equal(parse('[GITHUB_STATUS: COMPLETE_APPLIED]\n[GITHUB_STATUS: INCOMPLETE_CONTINUE]'), '');
});

test('terminal footer fallback covers the whole assistant turn and trailing UI metadata', () => {
  const helperStart = statusSource.indexOf('function terminalStatusCodeAnywhereInRenderedText');
  const helperEnd = statusSource.indexOf('function assistantStatusCodeFromDom', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'turn-scoped terminal helper must exist');
  const context = vm.createContext({
    String,
    Set,
    globalThis: null,
    ChatGPTNotifierStatusCode: {
      isStatusCode(value) {
        return ['COMPLETE_APPLIED', 'COMPLETE_NO_CHANGES', 'INCOMPLETE_CONTINUE'].includes(String(value || ''));
      }
    }
  });
  context.globalThis = context;
  vm.runInContext(`${statusSource.slice(helperStart, helperEnd)}\nglobalThis.__parseTurnStatus = terminalStatusCodeAnywhereInRenderedText;`, context);
  const parse = context.__parseTurnStatus;

  assert.equal(parse('Finished.\n[GITHUB_STATUS: COMPLETE_NO_CHANGES]\nWorked for 21s'), 'COMPLETE_NO_CHANGES');
  assert.equal(parse('[GITHUB_STATUS: COMPLETE_APPLIED]\nCopy\n[GITHUB_STATUS: COMPLETE_APPLIED]'), 'COMPLETE_APPLIED');
  assert.equal(parse('[GITHUB_STATUS: COMPLETE_APPLIED]\n[GITHUB_STATUS: INCOMPLETE_CONTINUE]'), '');

  for (const source of [statusSource, monitorPageSource]) {
    assert.match(source, /roleRoot\(turn, 'assistant'\),\s*\.\.\.renderedBlocks\(turn\),\s*turn/);
    assert.match(source, /terminalStatusCodeAnywhereInRenderedText/);
  }
});

test('unconfirmed extension-generated sends clean up only their own composer text', () => {
  const normalStart = statusSource.indexOf('async function performContinuation');
  const watchdogStart = statusSource.indexOf('async function performWatchdogContinuation');
  const watchdogEnd = statusSource.indexOf('async function waitForTerminalStatus', watchdogStart);
  assert.ok(normalStart >= 0 && watchdogStart > normalStart && watchdogEnd > watchdogStart);

  const normal = statusSource.slice(normalStart, watchdogStart);
  const watchdog = statusSource.slice(watchdogStart, watchdogEnd);
  for (const source of [normal, watchdog]) {
    assert.match(source, /continuation-user-turn-not-confirmed/);
    assert.match(source, /composerText\(composer\) === cleanComposer\(text\)\) writeComposer\(composer, ''\)/);
    assert.match(source, /page-send-error/);
  }
});

test('alarm re-reads the exact prompt terminal status before watchdog Send', () => {
  const helperStart = monitorSource.indexOf('async function queryTerminalStatusForPrompt');
  const helperEnd = monitorSource.indexOf('async function sendCodeWatchdogContinuation', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'exact-prompt status query helper must exist');
  const helper = monitorSource.slice(helperStart, helperEnd);
  assert.match(helper, /CHATGPT_STATUS_FOR_PROMPT_QUERY/);
  assert.match(helper, /expectedPromptKey/);

  const alarmStart = monitorSource.indexOf('async function handleCodeWatchdogAlarm');
  const alarmEnd = monitorSource.indexOf('function closeDerivedReason', alarmStart);
  const alarm = monitorSource.slice(alarmStart, alarmEnd);
  const queryIndex = alarm.indexOf('queryTerminalStatusForPrompt');
  const sendIndex = alarm.indexOf('sendCodeWatchdogContinuation');
  assert.ok(queryIndex >= 0 && sendIndex > queryIndex, 'exact-prompt terminal re-read must happen before watchdog Send');
  assert.match(alarm, /statusSnapshot/);
  assert.match(alarm, /parkCodeWatchdogForTerminalStatus\(statusSnapshot/);
});

test('page-side watchdog can queue the deadline Continue while generation is active', () => {
  const waitStart = statusSource.indexOf('function waitForWatchdogSendButton');
  const waitEnd = statusSource.indexOf('function matchesExpected', waitStart);
  const waitSource = statusSource.slice(waitStart, waitEnd);
  assert.match(waitSource, /enabledSend\(node\)/);
  assert.doesNotMatch(waitSource, /stopPresent\(\)/);

  const start = statusSource.indexOf('async function performWatchdogContinuation');
  const end = statusSource.indexOf('async function waitForTerminalStatus', start);
  const watchdog = statusSource.slice(start, end);
  assert.doesNotMatch(watchdog, /response-still-generating/);
  assert.match(watchdog, /beforeSendStatusCode/);
});

test('recoverable status codes use the same immediate watchdog follow-up path', () => {
  const start = statusSource.indexOf('async function performWatchdogContinuation');
  const end = statusSource.indexOf('async function waitForTerminalStatus', start);
  const watchdog = statusSource.slice(start, end);
  assert.doesNotMatch(watchdog, /performContinuation\(observed\)/);
  assert.match(watchdog, /watchdogStatusCode = observedStatusCode/);
  assert.match(watchdog, /watchdogStatusCode = beforeSendStatusCode/);
  assert.match(watchdog, /watchdogDisposition: terminalAfterSend \? 'stop' : \(watchdogStatusCode \? 'incomplete-reset' : 'retry-sent'\)/);
});

test('watchdog re-checks the original prompt after send so late terminal status wins the race', () => {
  const helperStart = statusSource.indexOf('function terminalStatusForPromptKey');
  const helperEnd = statusSource.indexOf('function revisionOf', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'prompt-scoped terminal lookup must exist');
  const helper = statusSource.slice(helperStart, helperEnd);
  assert.match(helper, /candidatePromptKey === expectedPrompt/);
  assert.match(helper, /if \(role === 'user'\) break/);
  assert.match(helper, /parseTerminalStatus\(responseText\)/);
  assert.match(helper, /assistantStatusCodeFromDom\(nodes\[index\]\)/);

  const start = statusSource.indexOf('async function performWatchdogContinuation');
  const end = statusSource.indexOf('async function waitForTerminalStatus', start);
  const watchdog = statusSource.slice(start, end);
  assert.match(watchdog, /terminalStatusForPromptKey\(expectedPrompt\)/);
  assert.match(watchdog, /terminal-status-observed-after-send/);
  assert.match(watchdog, /watchdogDisposition: terminalAfterSend \? 'stop'/);
  assert.match(watchdog, /continuationUserKey: sent\.userTurn\.key/);
});

test('watchdog command is bound to the exact prompt at both send boundaries', () => {
  assert.match(monitorSource, /promptKey:\s*String\(promptKey \|\| ''\)/);
  assert.match(monitorSource, /sendCodeWatchdogContinuation\(tab\.id, conversationId, String\(live\.promptKey \|\| ''\)\)/);

  const start = statusSource.indexOf('async function performWatchdogContinuation');
  const end = statusSource.indexOf('async function waitForTerminalStatus', start);
  const watchdog = statusSource.slice(start, end);
  assert.match(watchdog, /expectedPromptKey/);
  assert.match(watchdog, /watchdog-prompt-changed/);
  assert.match(watchdog, /watchdog-prompt-changed-before-send/);
  assert.match(statusSource, /performWatchdogContinuation\(message\?\.conversationId \|\| '', message\?\.promptKey \|\| ''\)/);
});

test('configurable watchdog preserves the default 30-minute deadline and three-send cap', () => {
  assert.match(monitorSource, /DEFAULT_CODE_WATCHDOG_DELAY_MS = 30 \* 60_000/);
  assert.match(monitorSource, /CODE_WATCHDOG_RETRY_MS = 60_000/);
  assert.match(monitorSource, /DEFAULT_CODE_WATCHDOG_MAX_SENDS = 3/);
  assert.match(monitorSource, /function codeWatchdogDelayMs\(\)/);
  assert.match(monitorSource, /function codeWatchdogMaxSends\(\)/);
  assert.match(monitorSource, /const noCodeEligibility = codeWatchdogNoCodeEligibility\(live\)/);
  assert.match(monitorSource, /if \(noCodeEligibility\.eligible !== true\)/);
});

test('overdue watchdog observation retries do not replace the continuation deadline', () => {
  const retryStart = monitorSource.indexOf('async function scheduleCodeWatchdogRetry');
  const retryEnd = monitorSource.indexOf('async function parkCodeWatchdog', retryStart);
  assert.ok(retryStart >= 0 && retryEnd > retryStart, 'watchdog retry scheduler must exist');
  const retrySource = monitorSource.slice(retryStart, retryEnd);

  assert.match(retrySource, /retryAt/);
  assert.match(retrySource, /retryReason/);
  assert.doesNotMatch(retrySource, /deadlineAt\s*:/);
  assert.match(monitorSource, /scheduleCodeWatchdogRetry\(record, noCodeEligibility\.reason\)/);
  assert.match(monitorSource, /scheduleCodeWatchdogRetry\(record, 'page-unavailable'\)/);
  assert.match(monitorSource, /scheduleCodeWatchdogRetry\(record, 'runtime-unavailable'\)/);
  assert.match(monitorSource, /deadlineAt,[\s\S]*retryAt: 0,[\s\S]*retryReason: ''/);
});

test('worker startup restores settings before rearming an overdue persisted deadline', () => {
  const start = monitorSource.indexOf('async function restoreCodeWatchdogAlarms');
  const end = monitorSource.indexOf('async function pruneOldRuns', start);
  assert.ok(start >= 0 && end > start, 'watchdog alarm restore helper must exist');
  const restore = monitorSource.slice(start, end);
  assert.match(restore, /if \(deadlineAt > 0\) when = deadlineAt <= now \? now \+ 1000 : deadlineAt/);
  assert.match(restore, /else if \(retryAt > 0\)/);
  assert.match(monitorSource, /codeWatchdogSettingsReady = restoreCodeWatchdogSettings\(\)/);
  assert.match(monitorSource, /codeWatchdogSettingsReady\.then\(\(\) => restoreCodeWatchdogAlarms\(\)\)/);
});

test('watchdog state cannot regress to an older request snapshot', () => {
  const start = monitorSource.indexOf('async function reconcileCodeWatchdog');
  const end = monitorSource.indexOf('async function tabForCodeWatchdog', start);
  assert.ok(start >= 0 && end > start, 'watchdog reconcile function must exist');
  const reconcile = monitorSource.slice(start, end);
  assert.match(reconcile, /persistedRequestStartedAt/);
  assert.match(reconcile, /requestStartedAt < persistedRequestStartedAt/);
  assert.match(reconcile, /return current/);
  assert.match(reconcile, /waitingForRequestStart === true[\s\S]*lastAutomaticSentAt[\s\S]*lastStatusCode[\s\S]*requestStartedAt === persistedRequestStartedAt/);
});

test('successful watchdog send persists only the configured next deadline, not a visible zero-deadline intermediate state', () => {
  const start = monitorSource.indexOf('async function handleCodeWatchdogAlarm');
  const end = monitorSource.indexOf('function closeDerivedReason', start);
  assert.ok(start >= 0 && end > start, 'watchdog alarm handler must exist');
  const handler = monitorSource.slice(start, end);
  assert.match(handler, /const nextDeadlineAt = sentAt \+ codeWatchdogDelayMs\(\)/);
  assert.match(handler, /deadlineAt: nextDeadlineAt/);
  assert.match(handler, /scheduleCodeWatchdog\(record, nextDeadlineAt\)/);
  assert.doesNotMatch(handler, /putCodeWatchdog\(conversationId,[\s\S]{0,500}deadlineAt: 0/);
});

test('successful recoverable-code watchdog sends atomically receive the configured next deadline', () => {
  const resetStart = monitorSource.indexOf('async function resetCodeWatchdogForIncomplete');
  const resetEnd = monitorSource.indexOf('async function reconcileCodeWatchdog', resetStart);
  const reset = monitorSource.slice(resetStart, resetEnd);
  assert.match(reset, /deadlineAt: Math\.max\(0, Number\(automaticSentAt \|\| 0\)\) > 0/);
  assert.match(reset, /codeWatchdogDelayMs\(\)/);

  const start = monitorSource.indexOf('async function handleCodeWatchdogAlarm');
  const end = monitorSource.indexOf('function closeDerivedReason', start);
  const handler = monitorSource.slice(start, end);
  assert.match(handler, /scheduleCodeWatchdog\(record, automaticSentAt \+ codeWatchdogDelayMs\(\)\)/);
});
