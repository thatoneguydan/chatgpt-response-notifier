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

test('live acceptance uses only the pinned localhost bridge and explicit update request', () => {
  assert.match(script, /ws:\/\/127\.0\.0\.1:38473\/bridge/);
  assert.match(script, /chrome-extension:\/\/lciedmoiiapbgemklkpoadimhffaaaah/);
  assert.match(script, /SetRequestHeader\('Origin', \$BridgeOrigin\)/);
  assert.match(script, /type = 'update\.check'/);
  assert.match(script, /type -ne 'update\.result'/);
  assert.match(script, /installedExtensionVersion/);
  assert.doesNotMatch(script, /https?:\/\/(?!127\.0\.0\.1)/);
});

test('WebSocket factory bypasses the PowerShell output pipeline with a ref result', () => {
  assert.match(script, /function Open-BridgeSocket/);
  assert.match(script, /\[ref\]\$Socket/);
  assert.match(script, /\[void\]\$client\.Options\.SetRequestHeader\('Origin', \$BridgeOrigin\)/);
  assert.match(script, /\[void\]\$client\.ConnectAsync\([\s\S]*?\.GetResult\(\)/);
  assert.match(script, /\$Socket\.Value = \$client/);
  assert.match(script, /\$socket = \$null\s+Open-BridgeSocket -Socket \(\[ref\]\$socket\)/);
  assert.doesNotMatch(script, /Write-Output -NoEnumerate/);
  assert.doesNotMatch(script, /\$socket\s*=\s*New-BridgeSocket/);
});

test('live acceptance retries stale feed observations without replacing an already-current helper', () => {
  assert.match(script, /for \(\$attempt = 1; \$attempt -le \$Attempts; \$attempt \+= 1\)/);
  assert.match(script, /if \(\$installed -eq \$ExpectedVersion\) \{ break \}/);
  assert.match(script, /Start-Sleep -Seconds \$RetryDelaySeconds/);
  assert.match(script, /restarted Glass helper did not report that version/);
});
