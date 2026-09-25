import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const workflow = read('.github/workflows/release.yml');
const script = read('tools/Invoke-NotifierManagedUpdateAcceptance.ps1');

test('notifier release requires live Glass managed-update acceptance', () => {
  assert.match(workflow, /Install and verify released notifier on Glass/);
  assert.match(workflow, /Invoke-NotifierManagedUpdateAcceptance\.ps1 -ExpectedVersion \$version/);
  assert.match(workflow, /Parser\]::ParseFile\([\s\S]*Invoke-NotifierManagedUpdateAcceptance\.ps1/);
});

test('release acceptance relies on verifier terminating errors instead of stale native LASTEXITCODE', () => {
  const acceptanceStep = workflow.match(/- name: Install and verify released notifier on Glass[\s\S]*$/)?.[0] ?? '';
  assert.match(acceptanceStep, /\$ErrorActionPreference = 'Stop'/);
  assert.match(acceptanceStep, /& \.\\tools\\Invoke-NotifierManagedUpdateAcceptance\.ps1 -ExpectedVersion \$version/);
  assert.doesNotMatch(acceptanceStep, /\$LASTEXITCODE/);
});

test('live acceptance uses only the pinned localhost bridge and explicit update request', () => {
  assert.match(script, /ws:\/\/127\.0\.0\.1:38473\/bridge/);
  assert.match(script, /chrome-extension:\/\/lciedmoiiapbgemklkpoadimhffaaaah/);
  assert.match(script, /SetRequestHeader\('Origin', \$BridgeOrigin\)/);
  assert.match(script, /type = 'update\.check'/);
  assert.match(script, /installedExtensionVersion/);
  assert.doesNotMatch(script, /type -ne 'update\.result'/);
  assert.doesNotMatch(script, /\.updateStatus/);
  assert.doesNotMatch(script, /https?:\/\/(?!127\.0\.0\.1)/);
});

test('WebSocket data handoff bypasses the PowerShell output pipeline', () => {
  assert.match(script, /function Open-BridgeSocket/);
  assert.match(script, /\[ref\]\$Socket/);
  assert.match(script, /\$Socket\.Value = \$client/);
  assert.match(script, /function Receive-BridgeJson[\s\S]*?\[ref\]\$Message/);
  assert.match(script, /\$Message\.Value = \(\$Utf8\.GetString/);
  assert.match(script, /\[void\]\$Socket\.SendAsync\([\s\S]*?\.GetResult\(\)/);
  assert.doesNotMatch(script, /Write-Output -NoEnumerate/);
  assert.doesNotMatch(script, /return \$message/);
});

test('live acceptance polls host.ready for the installed version and retries update requests at a bounded cadence', () => {
  assert.match(script, /function Read-BridgeReady/);
  assert.match(script, /function Request-ManagedUpdate/);
  assert.match(script, /\$installed = \[string\]\$ready\.installedExtensionVersion/);
  assert.match(script, /\(\(\$attempt - 1\) % 4 -eq 0\)/);
  assert.match(script, /if \(\$installed -eq \$ExpectedVersion\) \{ break \}/);
  assert.match(script, /Start-Sleep -Seconds \$RetryDelaySeconds/);
  assert.match(script, /fresh Glass helper connection did not report that version/);
});
