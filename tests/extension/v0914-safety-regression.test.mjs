import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const readText = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const source = readText('extension/v0914-safety-background.js');

function contextWithSafePrimary() {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    indexedDB: {
      open: () => ({
        set onupgradeneeded(fn) { this._upgrade = fn; },
        set onerror(fn) { this._error = fn; },
        set onsuccess(fn) { this._success = fn; }
      })
    },
    ChatGPTNotifierContinuationPolicy: {
      runtimeVersion: 5,
      normalizeBudget: (value = {}) => ({ ...value }),
      classifyObservation: (observation = {}) => observation.statusCode
        ? { state: 'coded-terminal', reason: observation.statusCode, automaticActionAllowed: observation.statusCode === 'INCOMPLETE_LIMIT' }
        : { state: 'waiting', reason: 'status-missing-passive', automaticActionAllowed: false, formatRepairCandidate: false },
      recoveryActionDecision: (kind, budget = {}) => kind === 'format-repair'
        ? { allowed: false, reason: 'format-repair-retired', budget: { ...budget } }
        : { allowed: true, reason: 'allowed', budget: { ...budget } },
      beginRecoveryAction: (kind, budget = {}) => kind === 'format-repair'
        ? { allowed: false, reason: 'format-repair-retired', budget: { ...budget } }
        : { allowed: true, reason: 'started', budget: { ...budget } }
    },
    ChatGPTNotifierRecoveryModel: {
      actionKinds: ['reload', 'continue', 'normal-continue'],
      recoveryCandidate: (classification) => ({ kind: '', reason: classification.reason }),
      admissionDecision: (kind) => kind === 'format-repair' ? { allowed: false, reason: 'format-repair-retired' } : { allowed: true, reason: 'allowed' },
      claimAction: (kind) => kind === 'format-repair' ? { allowed: false, reason: 'format-repair-retired' } : { allowed: true, reason: 'claimed' },
      postReloadDecision: () => ({ kind: '', state: 'resolved', reason: 'status-missing-passive' })
    }
  });
  vm.runInContext(source, context);
  return context;
}

test('compatibility safety keeps missing footer passive and format repair retired', () => {
  const context = contextWithSafePrimary();
  const policy = context.ChatGPTNotifierContinuationPolicy;
  const model = context.ChatGPTNotifierRecoveryModel;
  const classification = policy.classifyObservation({});
  assert.equal(classification.state, 'waiting');
  assert.equal(classification.reason, 'status-missing-passive');
  assert.equal(classification.formatRepairCandidate, false);
  assert.deepEqual({ ...model.recoveryCandidate(classification, {}, {}) }, { kind: '', reason: 'status-missing-passive' });
  assert.equal(policy.recoveryActionDecision('format-repair', {}).reason, 'format-repair-retired');
  assert.equal(model.admissionDecision('format-repair').reason, 'format-repair-retired');
  assert.equal(model.claimAction('format-repair').reason, 'format-repair-retired');
});

test('valid terminal codes still outrank passive missing-footer fallback', () => {
  const context = contextWithSafePrimary();
  const policy = context.ChatGPTNotifierContinuationPolicy;
  assert.equal(policy.classifyObservation({ statusCode: 'BLOCKED_HUMAN' }).reason, 'BLOCKED_HUMAN');
  assert.equal(policy.classifyObservation({ statusCode: 'INCOMPLETE_LIMIT' }).automaticActionAllowed, true);
});

test('primary click path is Chrome-only and helper Win32 source is removed', () => {
  const worker = readText('extension/service-worker.js');
  const host = readText('src/ChatGPTResponseNotifier.Host/NativeHostApplication.cs');
  assert.doesNotMatch(worker, /window\.foreground/);
  assert.doesNotMatch(worker, /requestNativeChromeForeground/);
  assert.match(worker, /chrome\.tabs\.update/);
  assert.match(worker, /chrome\.windows\.update/);
  assert.match(worker, /state === 'minimized'/);
  assert.match(worker, /state: 'normal'/);
  assert.match(host, /native-foreground-retired/);
  assert.doesNotMatch(host, /ChromeWindowForeground\.TryForeground/);
  assert.throws(() => readText('src/ChatGPTResponseNotifier.Host/ChromeWindowForeground.cs'));
});

test('compatibility layer does not replace the primary click route', () => {
  assert.match(source, /primary service-worker now owns Chrome-only click navigation directly/);
  assert.doesNotMatch(source, /globalThis\.focusOrOpenConversation\s*=/);
  assert.doesNotMatch(source, /requestNativeChromeForeground\s*=/);
  assert.doesNotMatch(source, /window\.foreground/);
});

test('startup safety layer retires persisted status-missing attention and its stale toast only', () => {
  assert.match(source, /MONITOR_DB_NAME = 'chatgpt-response-notifier-monitor'/);
  assert.match(source, /String\(record\?\.reason \|\| ''\) !== 'status-missing'/);
  assert.match(source, /store\.delete\(id\)/);
  assert.match(source, /type: 'toast\.dismissEvent'/);
  assert.doesNotMatch(source, /store\.clear\(/);
});
