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

function runAcceptance(evidence, sourceCommit = expectedSourceCommit) {
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
      '-ExpectedSourceCommit', sourceCommit
    ], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('installed-profile acceptance requires all four definitive stops and four unique presented notifications', { skip: process.platform !== 'win32' }, () => {
  const result = runAcceptance(buildEvidence());
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /LIVE_TERMINAL_NOTIFICATION_ACCEPTANCE_PASS/);
  assert.match(result.stdout, /uniqueNotifications=4/);
});

test('installed-profile acceptance fails when one definitive watchdog stop is missing', { skip: process.platform !== 'win32' }, () => {
  const evidence = buildEvidence((value) => {
    value.safeRuntimeEvidence.diagnostics = value.safeRuntimeEvidence.diagnostics.filter((record) =>
      !(record.status === 'terminal-watchdog-stopped-observed' && record.statusCode === 'PLANNING_ACTIVE')
    );
  });
  const result = runAcceptance(evidence);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /PLANNING_ACTIVE/);
});

test('installed-profile acceptance fails when helper presentation acknowledgement is missing', { skip: process.platform !== 'win32' }, () => {
  const evidence = buildEvidence((value) => {
    const record = value.safeRuntimeEvidence.deliveryDiagnostics.find((item) =>
      item.source === 'delivery-pipeline' && item.conversationSuffix === 'conv02'
    );
    record.presented = false;
  });
  const result = runAcceptance(evidence);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /COMPLETE_NO_CHANGES/);
});

test('installed-profile acceptance rejects evidence from a different candidate commit', { skip: process.platform !== 'win32' }, () => {
  const result = runAcceptance(buildEvidence(), 'fedcba9876543210fedcba9876543210fedcba98');
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /source commit does not match exact candidate head/i);
});
