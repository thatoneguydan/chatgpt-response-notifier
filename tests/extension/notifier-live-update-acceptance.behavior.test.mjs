import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const workflow = read('.github/workflows/release.yml');
const script = read('tools/Invoke-NotifierManagedUpdateAcceptance.ps1');
const updateService = read('src/ChatGPTResponseNotifier.Host/PublicUpdateService.cs');
const application = read('src/ChatGPTResponseNotifier.Host/NativeHostApplication.cs');
const runningIdentity = read('src/ChatGPTResponseNotifier.Host/RunningHostIdentity.cs');

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
  assert.match(script, /runningHostVersion/);
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

test('live acceptance requires disk state and actual running helper generation to converge', () => {
  assert.match(script, /function Read-BridgeReady/);
  assert.match(script, /function Request-ManagedUpdate/);
  assert.match(script, /\$installed = \[string\]\$ready\.installedExtensionVersion/);
  assert.match(script, /\$runningHost = \[string\]\$ready\.runningHostVersion/);
  assert.match(script, /\$installed -ne \$ExpectedVersion -or \$runningHost -ne \$ExpectedVersion/);
  assert.match(script, /\(\(\$attempt - 1\) % 4 -eq 0\)/);
  assert.match(script, /\$installed -eq \$ExpectedVersion -and \$runningHost -eq \$ExpectedVersion/);
  assert.match(script, /Start-Sleep -Seconds \$RetryDelaySeconds/);
  assert.match(script, /confirmed as the running helper generation/);
});

test('running helper identity comes from the process executable generation, not mutable extension files', () => {
  assert.match(runningIdentity, /Environment\.ProcessPath/);
  assert.match(runningIdentity, /Path\.GetDirectoryName\(Path\.GetFullPath\(processPath\)\)/);
  assert.match(runningIdentity, /Path\.GetFileName\(directory\)/);
  assert.match(runningIdentity, /PublicUpdateFeed\.CompareVersions\(version, "0\.0\.0"\)/);
  assert.doesNotMatch(runningIdentity, /ReadInstalledExtensionVersion|InstallStatePath/);
  assert.match(application, /runningHostVersion = RunningHostIdentity\.ReadVersion\(\)/);
});

test('notifier update checks serialize and stale helper processes self-heal from installed host state', () => {
  assert.match(updateService, /await _gate\.WaitAsync\(cancellationToken\)\.ConfigureAwait\(false\)/);
  assert.doesNotMatch(updateService, /WaitAsync\(0, cancellationToken\)/);
  assert.match(application, /EnsureCurrentInstalledHostActivated\(\)/);
  assert.match(application, /NativeHostInstaller\.HostExecutablePath\(installedVersion\)/);
  assert.match(application, /StartupRegistration\.Register\(installedHostPath\)/);
  assert.match(application, /ScheduleReplacementIfNeeded\(installedHostPath\)/);
  assert.match(application, /startInfo\.ArgumentList\.Add\("--wait-for-pid"\)/);
  assert.match(application, /Dispatcher\.BeginInvoke\(\(\) => Shutdown\(\)\)/);
});
