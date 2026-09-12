import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const policySource = readFileSync(new URL('extension/status-policy.js', root), 'utf8');
const statusCodeSource = readFileSync(new URL('extension/status-code.js', root), 'utf8');
const contractFixture = JSON.parse(readFileSync(new URL('extension/github-work-status-contract.v1.json', root), 'utf8'));
const evaluationFixture = JSON.parse(readFileSync(new URL('tests/fixtures/github-work-status-evaluation.v1.json', root), 'utf8'));

function loadPolicy() {
  const context = vm.createContext({ Date, Number, String });
  vm.runInContext(statusCodeSource, context);
  vm.runInContext(policySource, context);
  return context.ChatGPTNotifierContinuationPolicy;
}

function loadStatusCode() {
  const context = vm.createContext({});
  vm.runInContext(statusCodeSource, context);
  return context.ChatGPTNotifierStatusCode;
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const expected = {
  conversationId: 'conversation-1',
  documentId: 'document-1',
  promptKey: 'conversation-1|user-4',
  assistantKey: 'assistant-5',
  revision: '100:abc12345'
};

const current = { ...expected, statusCode: 'INCOMPLETE_LIMIT' };

test('identity match fails closed on every independently changing action boundary', () => {
  const policy = loadPolicy();
  assert.equal(policy.identityMatches(current, expected), true);
  for (const field of ['conversationId', 'documentId', 'promptKey', 'assistantKey', 'revision']) {
    assert.equal(
      policy.identityMatches({ ...current, [field]: `${current[field]}-changed` }, expected),
      false,
      `${field} change must cancel the action`
    );
  }
  assert.equal(policy.identityMatches({ ...current, statusCode: 'COMPLETE_APPLIED' }, expected), false);
});

test('drafts and recent trusted foreground activity block automation while idle/background pages do not', () => {
  const policy = loadPolicy();
  assert.equal(policy.userInteractionBlockReason({ composerText: 'my draft' }), 'composer-not-empty');
  assert.equal(policy.userInteractionBlockReason({
    composerText: '',
    documentFocused: true,
    documentVisible: true,
    lastTrustedInteractionAt: 9_000,
    now: 10_000,
    guardMs: 3_000
  }), 'active-user-interaction');
  assert.equal(policy.userInteractionBlockReason({
    documentFocused: true,
    documentVisible: true,
    lastTrustedInteractionAt: 5_000,
    now: 10_000,
    guardMs: 3_000
  }), '');
  assert.equal(policy.userInteractionBlockReason({
    documentFocused: false,
    documentVisible: false,
    lastTrustedInteractionAt: 9_900,
    now: 10_000,
    guardMs: 3_000
  }), '');
});

test('continuation acceptance requires both page-turn and request evidence in the same conversation', () => {
  const policy = loadPolicy();
  assert.deepEqual(
    { ...policy.continuationOutcome({ pageTurnConfirmed: true, requestAccepted: true, sameConversation: true }) },
    { accepted: true, reason: 'continuation-confirmed' }
  );
  assert.equal(policy.continuationOutcome({ pageTurnConfirmed: false, requestAccepted: true, sameConversation: true }).accepted, false);
  assert.equal(policy.continuationOutcome({ pageTurnConfirmed: true, requestAccepted: false, sameConversation: true }).accepted, false);
  assert.equal(policy.continuationOutcome({ pageTurnConfirmed: true, requestAccepted: true, sameConversation: false }).accepted, false);
});

test('bundled grammar fixture is self-consistent and runtime taxonomy plus START signal match it exactly', () => {
  const semantic = {
    contractId: contractFixture.contractId,
    statusLinePattern: contractFixture.statusLinePattern,
    finalSyntax: contractFixture.finalSyntax,
    workStartSignal: contractFixture.workStartSignal,
    workStartLinePattern: contractFixture.workStartLinePattern,
    workStartTerminal: contractFixture.workStartTerminal,
    validCodes: contractFixture.validCodes,
    autoContinuationCodes: contractFixture.autoContinuationCodes,
    formatRepairPrompt: contractFixture.formatRepairPrompt,
    capsuleRequiredFields: contractFixture.capsuleRequiredFields
  };
  const digest = createHash('sha256').update(canonicalize(semantic), 'utf8').digest('hex');
  assert.equal(digest, contractFixture.canonicalSemanticSha256);

  const api = loadStatusCode();
  assert.equal(api.contractId, contractFixture.contractId);
  assert.equal(api.contractSemanticSha256, contractFixture.canonicalSemanticSha256);
  assert.equal(api.workStartSignal, contractFixture.workStartSignal);
  assert.equal(api.isWorkStartSignal(contractFixture.workStartSignal), true);
  for (const nonExact of [
    ' [GITHUB_WORK: START]',
    '[GITHUB_WORK: START] ',
    '> [GITHUB_WORK: START]',
    '- [GITHUB_WORK: START]',
    '[GITHUB_WORK: STARTED]',
    '[GITHUB_STATUS: START]'
  ]) assert.equal(api.isWorkStartSignal(nonExact), false, nonExact);
  assert.equal(contractFixture.workStartTerminal, false);
  assert.deepEqual(Array.from(api.validStatusCodes), contractFixture.validCodes);
  assert.deepEqual(contractFixture.autoContinuationCodes, ['INCOMPLETE_LIMIT']);
  assert.equal(contractFixture.validCodes.includes('START'), false);
});

test('terminal grammar accepts one exact outside-fence final line and rejects ambiguous status-looking text', () => {
  const api = loadStatusCode();
  assert.equal(api.parseTerminalStatus('Done.\n[GITHUB_STATUS: COMPLETE_APPLIED]').statusCode, 'COMPLETE_APPLIED');
  assert.equal(api.parseTerminalStatus('Done.\n[GITHUB_STATUS: COMPLETE_APPLIED]\n\n').statusCode, 'COMPLETE_APPLIED');
  assert.equal(api.parseTerminalStatus('Example:\n```text\n[GITHUB_STATUS: BLOCKED_HUMAN]\n```\nDone.\n[GITHUB_STATUS: COMPLETE_APPLIED]').statusCode, 'COMPLETE_APPLIED');

  for (const response of [
    'Done.\n [GITHUB_STATUS: COMPLETE_APPLIED]',
    'Done.\n[GITHUB_STATUS: COMPLETE_APPLIED] ',
    'Done.\n> [GITHUB_STATUS: COMPLETE_APPLIED]',
    'Done.\n- [GITHUB_STATUS: COMPLETE_APPLIED]',
    'Done.\n[GITHUB_STATUS: SOMETHING_ELSE]',
    'Done.\n[GITHUB_STATUS: COMPLETE_APPLIED]\ntrailing text',
    'Done.\n[GITHUB_STATUS: COMPLETE_APPLIED]\n[GITHUB_STATUS: COMPLETE_APPLIED]',
    'Example:\n```text\n[GITHUB_STATUS: COMPLETE_APPLIED]'
  ]) {
    assert.equal(api.parseTerminalStatus(response).statusCode, '', `must reject: ${JSON.stringify(response)}`);
  }
});

test('long-chat evaluation keeps omission, wrong classification, and format failures distinct', () => {
  const api = loadStatusCode();
  assert.equal(evaluationFixture.contractId, contractFixture.contractId);

  const observedKinds = new Map();
  for (const item of evaluationFixture.cases) {
    const observed = api.parseTerminalStatus(item.response).statusCode;
    let failureKind = 'none';
    if (item.applicable) {
      if (!observed) failureKind = item.expectedFailureKind === 'format' ? 'format' : 'omission';
      else if (observed !== item.expectedCode) failureKind = 'wrong-classification';
    } else if (observed) {
      failureKind = 'format';
    }
    observedKinds.set(item.id, failureKind);
    assert.equal(failureKind, item.expectedFailureKind, item.id);
  }

  assert.equal(observedKinds.get('compaction-omitted-footer'), 'omission');
  assert.equal(observedKinds.get('wrong-valid-classification'), 'wrong-classification');
  assert.equal(observedKinds.get('duplicate-footer-rejected'), 'format');
  assert.equal(observedKinds.get('ordinary-progress-no-footer'), 'none');
});

test('observation classifier distinguishes active work, missing status, silent stop, blockers and coded results', () => {
  const policy = loadPolicy();
  assert.equal(policy.classifyObservation({ statusCode: 'COMPLETE_APPLIED' }).state, 'coded-terminal');
  assert.equal(policy.classifyObservation({ statusCode: 'COMPLETE_APPLIED' }).automaticActionAllowed, false);
  assert.equal(policy.classifyObservation({ statusCode: 'INCOMPLETE_LIMIT' }).automaticActionAllowed, true);
  assert.equal(policy.classifyObservation({ stopGenerating: true }).state, 'working');
  assert.equal(policy.classifyObservation({ toolActivity: true }).reason, 'tool-activity');
  assert.equal(policy.classifyObservation({ assistantKey: 'a1', stableTerminal: true }).reason, 'status-missing');
  assert.equal(policy.classifyObservation({ silentIdleConfirmations: 2 }).reason, 'silent-stop-confirmed');
  assert.equal(policy.classifyObservation({ explicitInterruption: true, interruptionKind: 'connection-interrupted' }).reason, 'connection-interrupted');
  assert.equal(policy.classifyObservation({ rateLimited: true }).openProfileBreaker, true);
  assert.equal(policy.classifyObservation({ authRequired: true }).reason, 'auth-required');
  assert.equal(policy.classifyObservation({ approvalRequired: true }).reason, 'approval-required');
  assert.equal(policy.classifyObservation({ manualStopped: true }).state, 'paused');
  assert.equal(policy.classifyObservation({ hasDraft: true }).reason, 'draft-present');
  assert.equal(policy.classifyObservation({ hasUpload: true }).reason, 'upload-present');
  assert.equal(policy.classifyObservation({ online: false }).reason, 'offline');
  assert.equal(policy.classifyObservation({ observable: false }).reason, 'page-unobservable');
  assert.equal(policy.classifyObservation({ workingDurationMs: 15 * 60_000 }).reason, 'long-thinking-diagnostic');
});

test('recovery budget permits at most three reloads, one continuation, one format repair and two automatic messages per incident', () => {
  const policy = loadPolicy();
  assert.equal(policy.thresholds.incidentReloadCap, 3);
  let budget = {};
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const started = policy.beginRecoveryAction('reload', budget, { now: 1_000 + ((attempt - 1) * 30_000) });
    assert.equal(started.allowed, true, `reload ${attempt}`);
    assert.equal(started.budget.reloads, attempt);
    assert.equal(started.budget.automaticMessages, 0);
    budget = started.budget;
  }
  assert.equal(policy.recoveryActionDecision('reload', budget, { now: 91_000 }).reason, 'incident-reload-cap-reached');

  const continued = policy.beginRecoveryAction('continue', budget, { now: 91_000 });
  assert.equal(continued.allowed, true);
  assert.equal(continued.budget.continuations, 1);
  assert.equal(continued.budget.automaticMessages, 1);
  assert.equal(continued.budget.runGenerationActions, 1);

  const repaired = policy.beginRecoveryAction('format-repair', continued.budget, { now: 121_000 });
  assert.equal(repaired.allowed, true);
  assert.equal(repaired.budget.formatRepairs, 1);
  assert.equal(repaired.budget.automaticMessages, 2);
  assert.equal(repaired.budget.runGenerationActions, 2);

  assert.equal(policy.recoveryActionDecision('continue', repaired.budget, { now: 151_000 }).allowed, false);
  assert.equal(policy.recoveryActionDecision('format-repair', repaired.budget, { now: 151_000 }).allowed, false);
});

test('uncertain action, profile breaker, spacing and whole-run cap fail closed', () => {
  const policy = loadPolicy();
  assert.equal(policy.recoveryActionDecision('continue', { uncertainAction: true }, { now: 100_000 }).reason, 'prior-action-uncertain');
  assert.equal(policy.recoveryActionDecision('continue', { breakerOpen: true }, { now: 100_000 }).reason, 'profile-breaker-open');
  assert.equal(policy.recoveryActionDecision('continue', { nextProfileActionAt: 120_000 }, { now: 100_000 }).reason, 'profile-action-spacing');
  assert.equal(policy.recoveryActionDecision('continue', { runGenerationActions: 12 }, { now: 100_000 }).reason, 'run-action-cap-reached');
  assert.equal(policy.recoveryActionDecision('unknown', {}, { now: 100_000 }).reason, 'unknown-recovery-action');
  assert.equal(policy.thresholds.runGenerationActionCap, 12);
  assert.equal(policy.thresholds.profileActionSpacingMs, 30_000);
});