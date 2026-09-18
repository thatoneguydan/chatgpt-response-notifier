import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import './hidden-window-diagnostics.behavior.test.mjs';
import './cross-desktop-click.behavior.test.mjs';

const worker = readFileSync(new URL('../../extension/service-worker.js', import.meta.url), 'utf8');
const readText = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

function loadVersionSync(currentVersion) {
  const start = worker.indexOf('function parseVersion(value)');
  const end = worker.indexOf('function conversationFromUrl(rawUrl)', start);
  assert.ok(start >= 0 && end > start, 'version-sync functions were not found in service-worker.js');

  const timers = [];
  let reloads = 0;
  const context = vm.createContext({
    chrome: {
      runtime: {
        getManifest: () => ({ version: currentVersion }),
        reload: () => { reloads += 1; }
      }
    },
    setTimeout: (fn, delay) => {
      timers.push({ fn, delay });
      return timers.length;
    }
  });
  vm.runInContext(worker.slice(start, end), context);
  return {
    maybeReload: context.maybeReloadForInstalledVersion,
    timers,
    reloads: () => reloads
  };
}

function loadRecoveryPolicyAndModel() {
  const context = vm.createContext({ console });
  vm.runInContext(readText('extension/status-code.js'), context);
  vm.runInContext(readText('extension/status-policy.js'), context);
  vm.runInContext(readText('extension/recovery-model.js'), context);
  return context;
}

function recoveryObservation(overrides = {}) {
  return {
    conversationId: 'conversation-1',
    promptKey: 'conversation-1|user-1',
    documentId: 'document-1',
    assistantKey: 'assistant-1',
    statusCode: '',
    observable: true,
    online: true,
    manualStopped: false,
    authRequired: false,
    approvalRequired: false,
    rateLimited: false,
    hasDraft: false,
    hasUpload: false,
    stopGenerating: false,
    toolActivity: false,
    stableTerminal: true,
    requestPhase: 'completed',
    silentIdleConfirmations: 0,
    explicitInterruption: false,
    interruptionKind: '',
    interruptionAttribution: '',
    applicationStateIdentityMatched: true,
    ...overrides
  };
}

test('installed extension version mismatch self-activates both upgrades and rollbacks', () => {
  for (const installedVersion of ['1.0.0', '0.9.7']) {
    const runtime = loadVersionSync('0.9.9');
    assert.equal(runtime.maybeReload(installedVersion), true);
    assert.equal(runtime.timers.length, 1);
    assert.equal(runtime.timers[0].delay, 250);
    assert.equal(runtime.reloads(), 0);
    runtime.timers[0].fn();
    assert.equal(runtime.reloads(), 1);
  }
});

test('same or invalid installed version does not reload the extension runtime', () => {
  for (const installedVersion of ['0.9.9', 'invalid']) {
    const runtime = loadVersionSync('0.9.9');
    assert.equal(runtime.maybeReload(installedVersion), false);
    assert.equal(runtime.timers.length, 0);
    assert.equal(runtime.reloads(), 0);
  }
});

test('both incomplete limit and tool failure are recoverable continuation codes', () => {
  const context = loadRecoveryPolicyAndModel();
  const policy = context.ChatGPTNotifierContinuationPolicy;
  assert.equal(policy.isAutoContinueStatusCode('INCOMPLETE_LIMIT'), true);
  assert.equal(policy.isAutoContinueStatusCode('INCOMPLETE_TOOL_FAILURE'), true);
  assert.equal(policy.isAutoContinueStatusCode('BLOCKED_HUMAN'), false);

  const expected = {
    statusCode: 'INCOMPLETE_TOOL_FAILURE',
    conversationId: 'conversation-1',
    documentId: 'document-1',
    promptKey: 'conversation-1|user-1',
    assistantKey: 'assistant-1',
    revision: 'rev-1'
  };
  assert.equal(policy.identityMatches({ ...expected }, expected), true);
  assert.equal(policy.identityMatches({ ...expected, statusCode: 'INCOMPLETE_LIMIT' }, expected), false);
});

test('explicit interruption outranks passive missing-footer classification on the same document', () => {
  const context = loadRecoveryPolicyAndModel();
  const policy = context.ChatGPTNotifierContinuationPolicy;
  assert.equal(policy.classifyObservation(recoveryObservation({ explicitInterruption: true, interruptionKind: 'timed-out', interruptionAttribution: 'current-request-global' })).reason, 'timed-out');
  assert.equal(policy.classifyObservation(recoveryObservation()).reason, 'timed-out');
  assert.equal(policy.classifyObservation(recoveryObservation({ documentId: 'document-2' })).reason, 'status-missing-passive');
});

test('missing footer stays passive after the ChatGPT request settles', () => {
  const context = loadRecoveryPolicyAndModel();
  const policy = context.ChatGPTNotifierContinuationPolicy;
  const active = policy.classifyObservation(recoveryObservation({ requestPhase: 'started' }));
  assert.equal(active.state, 'waiting');
  assert.equal(active.reason, 'awaiting-request-settlement');
  const done = policy.classifyObservation(recoveryObservation({ requestPhase: 'completed' }));
  assert.equal(done.state, 'waiting');
  assert.equal(done.reason, 'status-missing-passive');
  assert.equal(done.formatRepairCandidate, false);
});

test('explicit transport failures reload five times with five-minute surviving spacing, then continue once', () => {
  const context = loadRecoveryPolicyAndModel();
  const model = context.ChatGPTNotifierRecoveryModel;
  const policy = context.ChatGPTNotifierContinuationPolicy;
  const classification = { state: 'attention', reason: 'timed-out' };
  const broken = recoveryObservation({
    explicitInterruption: true,
    interruptionKind: 'timed-out',
    interruptionAttribution: 'current-request-global'
  });

  assert.equal(policy.thresholds.explicitInterruptionReloadCap, 5);
  assert.equal(policy.thresholds.explicitInterruptionRetryMs, 300_000);
  assert.equal(policy.thresholds.silentStopReloadCap, 3);
  assert.equal(model.firstEligibleAt('timed-out', 1234, 1), 1234);
  for (let reloads = 0; reloads < 5; reloads += 1) {
    assert.equal(model.recoveryCandidate(classification, broken, { reason: reloads ? model.postReloadExplicitReason : 'timed-out', budget: { reloads, continuations: 0 } }).kind, 'reload', `reload budget ${reloads}`);
  }
  assert.equal(model.recoveryCandidate(classification, broken, { reason: model.postReloadExplicitReason, budget: { reloads: 5, continuations: 0 } }).kind, 'continue');
  assert.equal(model.recoveryCandidate(classification, broken, { reason: model.postReloadExplicitReason, budget: { reloads: 5, continuations: 1 } }).kind, '');
  assert.equal(model.postReloadScheduleDelay(model.postReloadExplicitReason, { reason: model.postReloadExplicitReason, budget: { reloads: 1 } }), 300_000);
  assert.equal(model.postReloadScheduleDelay(model.postReloadExplicitReason, { reason: model.postReloadExplicitReason, budget: { reloads: 5 } }), 30_000);

  const postReload = model.postReloadDecision(
    recoveryObservation({ documentId: 'document-2', explicitInterruption: true, interruptionKind: 'timed-out', interruptionAttribution: 'current-request-global' }),
    { conversationId: 'conversation-1', promptKey: 'conversation-1|user-1', documentId: 'document-1' }
  );
  assert.equal(postReload.state, 'scheduled');
  assert.equal(postReload.kind, 'reload');
  assert.equal(postReload.reason, 'post-reload-explicit-interruption');
});

test('tool failure coded completion is routed through the existing continuation handler instead of notification', async () => {
  const source = readText('extension/recovery-live-fix-background.js');
  const runtimeListeners = [];
  const tabUpdateListeners = [];
  const queued = [];
  const continued = [];
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    chrome: {
      tabs: {
        sendMessage: async () => ({ ok: false }),
        query: async () => [],
        onUpdated: { addListener: (listener) => tabUpdateListeners.push(listener) }
      },
      scripting: { executeScript: async () => {} },
      runtime: { onMessage: { addListener: (listener) => runtimeListeners.push(listener) } }
    },
    ChatGPTNotifierContinuationPolicy: {
      isAutoContinueStatusCode: (code) => ['INCOMPLETE_LIMIT', 'INCOMPLETE_TOOL_FAILURE'].includes(String(code || ''))
    },
    queueDurableNotification: async (record, reason) => { queued.push({ record, reason }); return 'queued'; },
    handleContinuationClaim: async (record, status, tabId, documentId) => {
      continued.push({ record, status, tabId, documentId });
      return null;
    }
  });
  vm.runInContext(source, context);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const record = {
    statusCode: 'INCOMPLETE_TOOL_FAILURE',
    conversationId: 'conversation-1',
    conversationUrl: 'https://chatgpt.com/c/conversation-1',
    documentId: 'document-1',
    promptKey: 'conversation-1|user-1',
    assistantKey: 'assistant-1',
    revision: 'rev-1',
    ownerTabId: 7,
    ownerDocumentId: 'chrome-document-1'
  };
  await context.queueDurableNotification(record, 'coded-completion');
  assert.equal(continued.length, 1);
  assert.equal(continued[0].status.statusCode, 'INCOMPLETE_TOOL_FAILURE');
  assert.equal(queued.length, 0);

  await context.queueDurableNotification({ ...record, statusCode: 'BLOCKED_HUMAN' }, 'coded-completion');
  assert.equal(queued.length, 1);
});

test('compatibility repair keeps primary attribution and adds bounded global interruption fallback', () => {
  const background = readText('extension/recovery-live-fix-background.js');
  const content = readText('extension/recovery-live-fix-content.js');
  const monitor = readText('extension/monitor-script.js');
  const policy = readText('extension/status-policy.js');
  const control = readText('extension/recovery-control-background.js');

  assert.doesNotThrow(() => new vm.Script(background));
  assert.doesNotThrow(() => new vm.Script(content));
  assert.doesNotThrow(() => new vm.Script(monitor));

  assert.match(background, /SET_BUILD_AUTOMATION_STATE/);
  assert.match(background, /CHATGPT_RECOVERY_LIVE_REPUBLISH/);
  assert.match(background, /expected = \{/);
  assert.match(background, /documentId/);
  assert.match(background, /promptKey/);
  assert.match(background, /isAutoContinueStatusCode/);
  assert.match(background, /coded-completion-status-observer/);
  assert.match(content, /inspectCurrentRequestUi/);
  assert.match(content, /fallbackApplicationState/);
  assert.match(content, /MAX_FALLBACK_NODES/);
  assert.match(content, /current-request-global/);
  assert.match(content, /classifyApplicationText/);
  assert.match(content, /freshGlobalRequestError/);
  assert.match(content, /requestSettledAt/);
  assert.match(content, /EXCLUDED_FALLBACK_SELECTOR/);
  assert.match(monitor, /SEMANTIC_UI_SELECTOR/);
  assert.match(monitor, /classifyApplicationText/);
  assert.match(monitor, /current-request-global/);
  assert.match(monitor, /EXCLUDED_ERROR_CONTEXT_SELECTOR/);
  assert.match(policy, /our systems\?/);
  assert.match(policy, /response failed/);
  assert.match(policy, /disconnected/);
  assert.match(content, /CHATGPT_MONITOR_STATE/);
  assert.match(control, /recovery-live-fix-background\.js/);
});

test('quick prompt toolbar tracks the full composer, sits below native popups, and previews the real timestamp', () => {
  const quickPrompts = readText('extension/quick-prompts-script.js');
  const attachment = readText('extension/quick-prompts-attachment-background.js');
  const background = readText('extension/background.js');
  const manifest = JSON.parse(readText('extension/manifest.json'));

  assert.doesNotThrow(() => new vm.Script(quickPrompts));
  assert.doesNotThrow(() => new vm.Script(attachment));
  for (const label of ['Continue', 'Status', 'Checkpoint', 'Handoff']) {
    assert.match(quickPrompts, new RegExp(`label: '${label}'`));
  }
  assert.match(quickPrompts, /Intl\.DateTimeFormat/);
  assert.match(quickPrompts, /timestampedPrompt/);
  assert.match(quickPrompts, /presetTitle/);
  assert.match(quickPrompts, /function composerAnchor\(composer\)/);
  assert.match(quickPrompts, /composer\.closest\?\.\('form'\)/);
  assert.match(quickPrompts, /ResizeObserver/);
  assert.match(quickPrompts, /TOOLBAR_Z_INDEX = '40'/);
  assert.doesNotMatch(quickPrompts, /2147483646/);
  assert.doesNotMatch(quickPrompts, /Adds the current local timestamp/);
  assert.match(quickPrompts, /rect\.top - height - 8/);
  assert.match(quickPrompts, /if \(!composer \|\| composerText\(composer\)\) return;/);
  assert.match(quickPrompts, /button\.type = 'button'/);
  assert.doesNotMatch(quickPrompts, /sendButton\.click\s*\(/);
  assert.doesNotMatch(quickPrompts, /chrome\.runtime\.sendMessage/);
  assert.doesNotMatch(quickPrompts, /CHATGPT_BOUNDED_RECOVERY_COMMAND/);
  assert.match(attachment, /files: \['quick-prompts-script\.js'\]/);
  assert.match(attachment, /chrome\.tabs\.onUpdated\.addListener/);
  assert.match(attachment, /changeInfo\?\.status !== 'complete'/);
  assert.match(background, /quick-prompts-attachment-background\.js/);
  assert.ok(!manifest.content_scripts.some((entry) => Array.isArray(entry.js) && entry.js.includes('quick-prompts-script.js')));
});

test('native toast renders persisted completion time, keeps failed clicks retryable, and release versions stay aligned', () => {
  const toast = readText('src/ChatGPTResponseNotifier.Host/ToastWindow.cs');
  const manager = readText('src/ChatGPTResponseNotifier.Host/ToastManager.cs');
  const record = readText('src/ChatGPTResponseNotifier.Core/NotificationRecord.cs');
  const app = readText('src/ChatGPTResponseNotifier.Host/NativeHostApplication.cs');
  const manifest = JSON.parse(readText('extension/manifest.json'));
  const version = readText('VERSION.txt').trim();

  assert.match(toast, /FormatCompletedAt\(record\.CompletedAt\)/);
  assert.match(toast, /value\.ToLocalTime\(\)/);
  assert.match(toast, /local\.ToString\("t"\)/);
  assert.match(toast, /Content = "Move this tab here"/);
  assert.match(toast, /ToastMoveHereRequested/);
  assert.match(manager, /ReportClickResult/);
  assert.match(manager, /targetTabId = window\.TargetTabId/);
  assert.match(record, /public int\? TargetTabId/);
  assert.match(app, /case "toast\.clickResult"/);
  assert.doesNotMatch(app, /click-shell-fallback/);
  assert.equal(version, '0.9.29');
  assert.equal(manifest.version, version);
});

test('Chrome registration diagnostics v2 remain bounded and read-only', () => {
  const helperSource = readText('src/ChatGPTResponseNotifier.Host/ChromeRegistrationEvidencePublisher.cs');
  const adapterSource = readText('tools/Add-NotifierChromeRegistrationEvidence.ps1');

  assert.match(helperSource, /chrome-registration-readonly-helper-v2/);
  assert.match(helperSource, /referencedFilesMissing/);
  assert.match(helperSource, /referencedFilesUnreadable/);
  assert.match(helperSource, /calculatedExtensionId/);
  assert.match(adapterSource, /chrome-registration-readonly-helper-v2/);
  assert.doesNotMatch(helperSource, /Registry\.SetValue|Process\.Start|chrome\.exe/i);
});

test('unpacked control comparison stays bounded, read-only, and path-sanitized', () => {
  const helperSource = readText('src/ChatGPTResponseNotifier.Host/ChromeUnpackedControlComparisonEvidencePublisher.cs');
  const adapterSource = readText('tools/Collect-ChromeUnpackedControlComparison.ps1');

  assert.match(helperSource, /chrome-unpacked-control-comparison-readonly-helper-v1/);
  assert.match(helperSource, /SafePathCategory/);
  assert.match(helperSource, /calculatedIdMatchesRegistration/);
  assert.match(adapterSource, /chrome-unpacked-control-comparison-readonly-helper-v1/);
  assert.match(adapterSource, /helper-snapshot-unavailable/);
  assert.doesNotMatch(helperSource, /Registry\.SetValue|Process\.Start|chrome\.exe/i);
  assert.doesNotMatch(adapterSource, /Set-Content.*Preferences|Set-Content.*Secure Preferences/i);
});
