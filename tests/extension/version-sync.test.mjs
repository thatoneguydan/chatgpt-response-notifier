import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'extension', 'manifest.json'), 'utf8'));
const version = fs.readFileSync(path.join(repoRoot, 'VERSION.txt'), 'utf8').trim();

await import('./architecture.test.mjs');
await import('./coordinator.behavior.test.mjs');
await import('./status-policy.behavior.test.mjs');
await import('./automation-control.behavior.test.mjs');
await import('./bounded-recovery.behavior.test.mjs');
await import('./hidden-tab-completion.behavior.test.mjs');
await import('./post-refresh-continuation.integration.test.mjs');
await import('./cross-desktop-click.behavior.test.mjs');
await import('./hidden-window-diagnostics.behavior.test.mjs');

test('manifest and VERSION stay synchronized at v0.9.28', () => {
  assert.equal(manifest.version, '0.9.28');
  assert.equal(version, '0.9.28');
});

test('Chrome registration diagnostic source is bounded and read-only', () => {
  const helperSource = fs.readFileSync(path.join(repoRoot, 'src', 'ChatGPTResponseNotifier.Host', 'ChromeRegistrationEvidencePublisher.cs'), 'utf8');
  const adapterSource = fs.readFileSync(path.join(repoRoot, 'tools', 'Add-NotifierChromeRegistrationEvidence.ps1'), 'utf8');

  assert.match(helperSource, /chrome-registration-readonly-helper-v2/);
  assert.match(helperSource, /referencedFilesMissing/);
  assert.match(helperSource, /referencedFilesUnreadable/);
  assert.match(helperSource, /calculatedExtensionId/);
  assert.match(adapterSource, /chrome-registration-readonly-helper-v2/);
  assert.doesNotMatch(helperSource, /Set-Content|SetValue|Registry\.SetValue|chrome\.exe/i);
});
