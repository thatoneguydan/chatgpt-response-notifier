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

test('bundled grammar fixture is self-consistent and runtime taxonomy matches it exactly', () => {
  const semantic = {
    contractId: contractFixture.contractId,
    statusLinePattern: contractFixture.statusLinePattern,
    finalSyntax: contractFixture.finalSyntax,
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
  assert.deepEqual(Array.from(api.validStatusCodes), contractFixture.validCodes);
  assert.deepEqual(contractFixture.autoContinuationCodes, ['INCOMPLETE_LIMIT']);
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
