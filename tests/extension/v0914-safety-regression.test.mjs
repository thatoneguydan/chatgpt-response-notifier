import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../../extension/v0914-safety-background.js', import.meta.url), 'utf8');

function contextWithStubs() {
  const timers = [];
  const calls = [];
  const context = vm.createContext({
    URL,
    console,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    chrome: {
      tabs: {
        query: async () => [{ id: 12, windowId: 4, url: 'https://chatgpt.com/c/conversation-1' }],
        update: async (...args) => { calls.push(['tabs.update', ...args]); return {}; },
        create: async (...args) => { calls.push(['tabs.create', ...args]); return { id: 13, windowId: 5 }; }
      },
      windows: {
        update: async (...args) => { calls.push(['windows.update', ...args]); return {}; }
      }
    },
    sendNative: (message) => { calls.push(['sendNative', message]); return true; },
    ChatGPTNotifierContinuationPolicy: {
      runtimeVersion: 4,
      isAutoContinueStatusCode: (code) => ['INCOMPLETE_LIMIT', 'INCOMPLETE_TOOL_FAILURE'].includes(String(code || '')),
      normalizeBudget: (value = {}) => ({ ...value }),
      classifyObservation: (observation = {}) => {
        if (observation.statusCode) return { state: 'coded-terminal', reason: observation.statusCode, automaticActionAllowed: ['INCOMPLETE_LIMIT','INCOMPLETE_TOOL_FAILURE'].includes(observation.statusCode) };
        return { state: 'attention', reason: 'status-missing', automaticActionAllowed: false, formatRepairCandidate: true };
      },
      recoveryActionDecision: (kind, budget = {}) => ({ allowed: true, reason: 'allowed', budget: { ...budget }, kind }),
      beginRecoveryAction: (kind, budget = {}) => ({ allowed: true, reason: 'started', budget: { ...budget }, kind })
    },
    ChatGPTNotifierRecoveryModel: {
      recoveryCandidate: (classification) => classification.reason === 'status-missing' ? { kind: 'format-repair', reason: 'status-missing' } : { kind: '', reason: classification.reason },
      admissionDecision: () => ({ allowed: true, reason: 'allowed' }),
      claimAction: () => ({ allowed: true, reason: 'claimed' }),
      postReloadDecision: () => ({ kind: 'format-repair', state: 'scheduled', reason: 'status-missing' })
    },
    focusOrOpenConversation: async () => false,
    requestNativeChromeForeground: async () => true
  });
  vm.runInContext(source, context);
  return { context, timers, calls };
}

test('missing-footer classification is passive and cannot trigger format repair', () => {
  const { context } = contextWithStubs();
  const policy = context.ChatGPTNotifierContinuationPolicy;
  const model = context.ChatGPTNotifierRecoveryModel;
  const classification = policy.classifyObservation({});
  assert.equal(classification.state, 'waiting');
  assert.equal(classification.reason, 'status-missing-passive');
  assert.equal(classification.formatRepairCandidate, false);
  assert.deepEqual({ ...model.recoveryCandidate(classification, {}, {}) }, { kind: '', reason: 'work-resumed-after-reload' });
  assert.equal(policy.recoveryActionDecision('format-repair', {}).allowed, false);
  assert.equal(model.admissionDecision('format-repair').allowed, false);
  assert.equal(model.claimAction('format-repair').allowed, false);
  assert.deepEqual({ ...model.postReloadDecision({}, {}) }, { kind: '', state: 'resolved', reason: 'status-missing-passive' });
});

test('valid terminal codes outrank the passive missing-footer fallback', () => {
  const { context } = contextWithStubs();
  const policy = context.ChatGPTNotifierContinuationPolicy;
  const blocked = policy.classifyObservation({ statusCode: 'BLOCKED_HUMAN' });
  assert.equal(blocked.state, 'coded-terminal');
  assert.equal(blocked.reason, 'BLOCKED_HUMAN');
  assert.equal(blocked.automaticActionAllowed, false);
  for (const code of ['INCOMPLETE_LIMIT', 'INCOMPLETE_TOOL_FAILURE']) {
    const result = policy.classifyObservation({ statusCode: code });
    assert.equal(result.state, 'coded-terminal');
    assert.equal(result.automaticActionAllowed, true);
  }
});

test('toast click override uses Chrome APIs only and disables native foreground handoff', async () => {
  const { context, timers, calls } = contextWithStubs();
  for (const timer of timers.splice(0)) timer();
  assert.equal(await context.requestNativeChromeForeground(), false);
  assert.equal(await context.focusOrOpenConversation('conversation-1', 'https://chatgpt.com/c/conversation-1'), true);
  assert.equal(calls.some(([name]) => name === 'tabs.update'), true);
  assert.equal(calls.some(([name]) => name === 'windows.update'), true);
  assert.equal(calls.some(([name, message]) => name === 'sendNative' && message?.type === 'toast.dismissConversation'), true);
  assert.doesNotMatch(source, /window\.foreground/);
  assert.doesNotMatch(source, /SetForegroundWindow|BringWindowToTop/);
});
