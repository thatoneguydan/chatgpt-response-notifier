import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const acceptanceScript = fileURLToPath(new URL('tools/Test-NotifierLiveTerminalNotificationAcceptance.ps1', root));
const expectedVersion = '0.9.97';
const expectedSourceCommit = '0123456789abcdef0123456789abcdef01234567';
const expectedCommitSuffix = expectedSourceCommit.slice(-12);
const definitiveCodes = ['COMPLETE_APPLIED', 'COMPLETE_NO_CHANGES', 'BLOCKED_HUMAN', 'PLANNING_ACTIVE'];

function iso(baseMs, offsetMs) {
  return new Date(baseMs + offsetMs).toISOString();
}

function buildEvidence(mutator = null) {
  const now = Date.now();
  const base = now - 70_000;
  const diagnostics = [];
  const deliveryDiagnostics = [];

  definitiveCodes.forEach((statusCode, index) => {
    const offset = index * 15_000;
    const conversationSuffix = `conv0${index + 1}`;
    const assistantSuffix = `asst0${index + 1}`;
    const notificationSuffix = `toast0${index + 1}`;
    diagnostics.push({
      source: 'terminal-live-proof',
      status: 'terminal-message-received',
      observedAt: iso(base, offset),
      extensionVersion: expectedVersion,
      statusCode,
      reason: `build=${expectedCommitSuffix};CHATGPT_RENDERED_TERMINAL_STATUS`,
      conversationSuffix,
      assistantSuffix
    });
    diagnostics.push({
      source: 'terminal-live-proof',
      status: 'terminal-watchdog-stopped-observed',
      observedAt: iso(base, offset + 350),
      extensionVersion: expectedVersion,
      statusCode,
      reason: `build=${expectedCommitSuffix};delay=350;automation=on;watchdog=present;stopped=true;stopReason=status:${statusCode};deadline=zero`,
      conversationSuffix,
      assistantSuffix
    });
    deliveryDiagnostics.push({
      source: 'host',
      status: 'toast-presented',
      observedAt: iso(base, offset + 1_500),
      conversationSuffix,
      notificationSuffix,
      presented: true,
      presentationState: 'shown'
    });
    deliveryDiagnostics.push({
      source: 'delivery-pipeline',
      status: 'helper-durable-accepted',
      observedAt: iso(base, offset + 1_650),
      extensionVersion: expectedVersion,
      conversationSuffix,
      notificationSuffix,
      presented: true,
      presentationState: 'shown'
    });
  });

  const evidence = {
    schemaVersion: 2,
    readOnly: true,
    sourceCommit: expectedSourceCommit,
    chrome: { extensionConnectionLive: true },
    safeRuntimeEvidence: {
      state: 'read',
      installedVersion: expectedVersion,
      sourceCommit: expectedSourceCommit,
      currentExtensionVersion: expectedVersion,
      currentExtensionObservedAtUtc: new Date(now).toISOString(),
      diagnostics,
      deliveryDiagnostics
    }
  };
  if (typeof mutator === 'function') mutator(evidence);
  return evidence;
}

function keepOnlyCode(evidence, statusCode) {
  const conversationSuffix = `conv0${definitiveCodes.indexOf(statusCode) + 1}`;
  evidence.safeRuntimeEvidence.diagnostics = evidence.safeRuntimeEvidence.diagnostics.filter((record) => record.statusCode === statusCode);
  evidence.safeRuntimeEvidence.deliveryDiagnostics = evidence.safeRuntimeEvidence.deliveryDiagnostics.filter((record) => record.conversationSuffix === conversationSuffix);
  return evidence;
}

function runAcceptance(evidence, { sourceCommit = expectedSourceCommit, minimumProofs = 1 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'notifier-live-acceptance-'));
  const evidencePath = join(directory, 'evidence.json');
  try {
    writeFileSync(evidencePath, JSON.stringify(evidence), 'utf8');
    return spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', acceptanceScript,
      '-EvidencePath', evidencePath,
      '-ExpectedVersion', expectedVersion,
      '-ExpectedSourceCommit', sourceCommit,
      '-MinimumLiveDefinitiveProofs', String(minimumProofs)
    ], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('installed-profile acceptance can exhaustively prove all four definitive stops', { skip: process.platform !== 'win32' }, () => {
  const result = runAcceptance(buildEvidence(), { minimumProofs: 4 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /LIVE_TERMINAL_NOTIFICATION_ACCEPTANCE_PASS/);
  assert.match(result.stdout, /liveProofs=4/);
  assert.match(result.stdout, /uniqueNotifications=4/);
});

test('installed-profile acceptance supports one real live definitive proof when all four codes are deterministically covered elsewhere', { skip: process.platform !== 'win32' }, () => {
  const evidence = keepOnlyCode(buildEvidence(), 'BLOCKED_HUMAN');
  const result = runAcceptance(evidence, { minimumProofs: 1 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /liveCodes=BLOCKED_HUMAN/);
  assert.match(result.stdout, /liveProofs=1/);
  assert.match(result.stdout, /uniqueNotifications=1/);
});

test('installed-profile acceptance fails when an observed definitive code lacks its watchdog stop', { skip: process.platform !== 'win32' }, () => {
  const evidence = keepOnlyCode(buildEvidence(), 'PLANNING_ACTIVE');
  evidence.safeRuntimeEvidence.diagnostics = evidence.safeRuntimeEvidence.diagnostics.filter((record) => record.status !== 'terminal-watchdog-stopped-observed');
  const result = runAcceptance(evidence);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /PLANNING_ACTIVE/);
});

test('installed-profile acceptance fails when an observed definitive code lacks helper presentation acknowledgement', { skip: process.platform !== 'win32' }, () => {
  const evidence = keepOnlyCode(buildEvidence(), 'COMPLETE_NO_CHANGES');
  const record = evidence.safeRuntimeEvidence.deliveryDiagnostics.find((item) => item.source === 'delivery-pipeline');
  record.presented = false;
  const result = runAcceptance(evidence);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /COMPLETE_NO_CHANGES/);
});

test('installed-profile acceptance fails when no definitive live proof exists', { skip: process.platform !== 'win32' }, () => {
  const evidence = buildEvidence((value) => {
    value.safeRuntimeEvidence.diagnostics = [];
    value.safeRuntimeEvidence.deliveryDiagnostics = [];
  });
  const result = runAcceptance(evidence);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /expected at least 1 complete definitive-status live proof/i);
});

test('installed-profile acceptance rejects evidence from a different candidate commit', { skip: process.platform !== 'win32' }, () => {
  const evidence = keepOnlyCode(buildEvidence(), 'BLOCKED_HUMAN');
  const result = runAcceptance(evidence, { sourceCommit: 'fedcba9876543210fedcba9876543210fedcba98' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /source commit does not match exact candidate/i);
});
