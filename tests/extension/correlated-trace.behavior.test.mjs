import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const policySource = read('extension/status-policy.js');
const modelSource = read('extension/recovery-model.js');
const recoveryDiagnosticsSource = read('extension/recovery-decision-diagnostics-background.js');
const bootstrapSource = read('extension/diagnostics-bootstrap.js');
const hiddenSource = read('extension/hidden-window-diagnostics-background.js');
const retentionSource = read('src/ChatGPTResponseNotifier.Host/HiddenWindowIncidentRetention.cs');
const publisherSource = read('src/ChatGPTResponseNotifier.Host/RuntimeEvidencePublisher.cs');
const deliverySource = read('extension/delivery-reliability-background.js');

function recoveryHarness() {
  const nativeMessages = [];
  const context = vm.createContext({
    globalThis: null,
    Date,
    Number,
    String,
    Set,
    Object,
    Math,
    chrome: { runtime: { getManifest: () => ({ version: '0.9.29' }) } },
    sendNative: (message) => nativeMessages.push(structuredClone(message))
  });
  context.globalThis = context;
  vm.runInContext(policySource, context);
  vm.runInContext(modelSource, context);
  vm.runInContext(recoveryDiagnosticsSource, context);
  return { model: context.ChatGPTNotifierRecoveryModel, nativeMessages };
}

test('recovery diagnostics report only bounded identity suffixes and decision reasons', () => {
  const runtime = recoveryHarness();
  const observation = {
    conversationId: 'conversation-sensitive-full-id',
    documentId: 'document-sensitive-full-id',
    requestId: 'request-sensitive-full-id',
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
    explicitInterruption: true,
    interruptionKind: 'timed-out',
    interruptionAttribution: 'current-request-global',
    applicationStateIdentityMatched: true,
    promptText: 'must-not-leak',
    responseText: 'must-not-leak'
  };
  const incident = {
    incidentId: 'incident-sensitive-full-id',
    humanRunId: 'human-1',
    generationKey: 'generation-sensitive-full-id',
    reason: 'timed-out',
    state: 'scheduled',
    ordinal: 1,
    budget: {},
    nextEligibleAt: 0
  };
  const candidate = runtime.model.recoveryCandidate({ state: 'attention', reason: 'timed-out' }, observation, incident);
  assert.equal(candidate.kind, 'reload');

  const claim = runtime.model.claimAction(
    'reload',
    { humanRunId: 'human-1', conversationId: observation.conversationId, generationActions: 0, state: 'active' },
    incident,
    { breakerOpen: false, activeLease: null, nextProfileActionAt: 0 },
    observation,
    { now: 10_000, leaseId: 'lease-1', recoveryEnabled: true }
  );
  assert.equal(claim.allowed, true);

  const diagnostics = runtime.nativeMessages.map((item) => item.diagnostic);
  assert.deepEqual(diagnostics.map((item) => item.status), ['candidate', 'action-admitted']);
  assert.equal(diagnostics[0].reason, 'timed-out');
  assert.equal(diagnostics[0].actionKind, 'reload');
  assert.equal(diagnostics[0].chromeDocumentSuffix, observation.documentId.slice(-8));
  assert.equal(diagnostics[0].requestSuffix, observation.requestId.slice(-8));
  for (const diagnostic of diagnostics) {
    const serialized = JSON.stringify(diagnostic);
    assert.doesNotMatch(serialized, /must-not-leak/);
    assert.doesNotMatch(serialized, /conversation-sensitive-full-id/);
    assert.doesNotMatch(serialized, /document-sensitive-full-id/);
    assert.doesNotMatch(serialized, /request-sensitive-full-id/);
    assert.equal('promptText' in diagnostic, false);
    assert.equal('responseText' in diagnostic, false);
  }
});

test('blocked recovery admission retains the exact named veto reason', () => {
  const runtime = recoveryHarness();
  const observation = {
    conversationId: 'conversation-1',
    documentId: 'document-1',
    requestId: 'request-1',
    observable: true,
    online: true,
    manualStopped: false,
    authRequired: false,
    approvalRequired: false,
    rateLimited: false,
    hasDraft: true,
    hasUpload: false,
    stopGenerating: false,
    toolActivity: false
  };
  const result = runtime.model.claimAction(
    'reload',
    { humanRunId: 'human-1', conversationId: 'conversation-1', generationActions: 0, state: 'active' },
    { incidentId: 'incident-1', humanRunId: 'human-1', generationKey: 'generation-1', reason: 'timed-out', state: 'scheduled', ordinal: 1, budget: {} },
    { breakerOpen: false, activeLease: null, nextProfileActionAt: 0 },
    observation,
    { now: 10_000, leaseId: 'lease-1', recoveryEnabled: true }
  );
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'draft-present');
  const diagnostic = runtime.nativeMessages.at(-1)?.diagnostic;
  assert.equal(diagnostic.status, 'action-blocked');
  assert.equal(diagnostic.reason, 'draft-present');
  assert.equal(diagnostic.allowed, false);
});

test('bootstrap installs decision diagnostics without changing recovery authority ordering', () => {
  const backgroundIndex = bootstrapSource.indexOf("importScripts('background.js')");
  const recoveryIndex = bootstrapSource.indexOf("importScripts('recovery-decision-diagnostics-background.js')");
  const hiddenIndex = bootstrapSource.indexOf("importScripts('hidden-window-diagnostics-background.js')");
  assert.ok(backgroundIndex >= 0 && recoveryIndex > backgroundIndex && hiddenIndex > recoveryIndex);
  assert.doesNotMatch(recoveryDiagnosticsSource, /chrome\.tabs\.reload|CHATGPT_BOUNDED_RECOVERY_COMMAND|backend-api|\bfetch\s*\(/);
  assert.match(recoveryDiagnosticsSource, /const base = globalThis\.ChatGPTNotifierRecoveryModel/);
  assert.match(recoveryDiagnosticsSource, /return base\.claimAction/);
});

test('retained trace joins recovery and delivery onto request incidents with named boundary categories', () => {
  assert.match(retentionSource, /source == "recovery-decision"/);
  assert.match(retentionSource, /source == "delivery-pipeline"/);
  assert.match(retentionSource, /request-suffix-exact/);
  assert.match(retentionSource, /delivery-correlation/);
  assert.match(retentionSource, /document-time-nearest/);
  assert.match(retentionSource, /page-diagnostic-attachment-missing/);
  assert.match(retentionSource, /main-stream-observer-missing/);
  assert.match(retentionSource, /page-query-deadline/);
  assert.match(retentionSource, /tab-discarded/);
  assert.match(retentionSource, /tab-frozen/);
  assert.match(retentionSource, /page-frozen/);
  assert.match(retentionSource, /delivery-failure/);
  assert.match(retentionSource, /ActionState/);
  assert.match(retentionSource, /ActionReason/);
  assert.match(retentionSource, /DeliveryState/);
  assert.match(retentionSource, /FirstMissingBoundary/);
  assert.match(retentionSource, /uncorrelatedBoundaryEvents/);
  assert.doesNotMatch(retentionSource, /promptText|assistantText|responseText|responseBody/);
});

test('existing evidence distinguishes runtime, attachment, stale page, lifecycle and delivery boundaries without new traffic', () => {
  assert.match(publisherSource, /extensionConnectionLive/);
  assert.match(publisherSource, /bridgeConnected/);
  assert.match(hiddenSource, /main-observer-installed/);
  assert.match(hiddenSource, /page-bridge-installed/);
  assert.match(hiddenSource, /PAGE_QUERY_DEADLINE_MS = 2000/);
  assert.match(hiddenSource, /tabFrozen/);
  assert.match(hiddenSource, /tabDiscarded/);
  assert.match(deliverySource, /helper-ack-missing/);
  assert.match(deliverySource, /notification-queue-error/);
  assert.match(deliverySource, /helper-durable-accepted/);
  assert.doesNotMatch(recoveryDiagnosticsSource, /XMLHttpRequest|api\/auth\/session/i);
});
