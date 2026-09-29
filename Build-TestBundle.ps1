[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [string]$SourceCommit = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (& git -C $root rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($repoRoot)) { throw 'Could not resolve repository root.' }
$version = (Get-Content -LiteralPath (Join-Path $root 'VERSION.txt') -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($version)) { throw 'VERSION.txt is empty.' }

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\Test-ExtensionIdentity.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Extension identity contract validation failed.' }

if ([string]::IsNullOrWhiteSpace($SourceCommit)) {
    $SourceCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($SourceCommit)) {
        throw 'Could not resolve the exact source commit for the bundle.'
    }
}
if ($SourceCommit -notmatch '^[0-9a-fA-F]{40}$') {
    throw 'SourceCommit must be an exact 40-character Git commit SHA.'
}
$SourceCommit = $SourceCommit.ToLowerInvariant()

$bundleName = "ChatGPT-Response-Notifier-$version"
$bundleRoot = Join-Path $OutputDirectory $bundleName
$publishRoot = Join-Path $OutputDirectory '_native-publish'
Remove-Item -LiteralPath $bundleRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $publishRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null
New-Item -ItemType Directory -Path $publishRoot -Force | Out-Null

Write-Host "Publishing Windows helper for bundle $bundleName..."
& dotnet publish (Join-Path $root 'src\ChatGPTResponseNotifier.Host\ChatGPTResponseNotifier.Host.csproj') `
    --configuration Release `
    --runtime win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -o $publishRoot
if ($LASTEXITCODE -ne 0) { throw 'Windows helper publish failed while building the managed-update bundle.' }

$publishedExe = Join-Path $publishRoot 'ChatGPTResponseNotifier.Host.exe'
if (-not (Test-Path -LiteralPath $publishedExe -PathType Leaf)) {
    throw 'Published helper EXE is missing from the managed-update bundle build.'
}

$unexpectedRuntimeFiles = @(Get-ChildItem -LiteralPath $publishRoot -File | Where-Object { $_.Name -ne 'ChatGPTResponseNotifier.Host.exe' -and $_.Extension -in @('.dll', '.so', '.dylib') })
if ($unexpectedRuntimeFiles.Count -gt 0) {
    throw "Helper publish still depends on adjacent native/runtime libraries: $($unexpectedRuntimeFiles.Name -join ', ')"
}

Copy-Item -LiteralPath $publishedExe -Destination (Join-Path $bundleRoot 'ChatGPTResponseNotifier.Host.exe') -Force
$sourceExtensionRoot = Join-Path $root 'extension'
$bundleExtensionRoot = Join-Path $bundleRoot 'extension'
Copy-Item -LiteralPath $sourceExtensionRoot -Destination $bundleExtensionRoot -Recurse -Force
$runtimeIdentityPath = Join-Path $bundleExtensionRoot 'runtime-build-identity.js'
$runtimeIdentityText = @"
'use strict';

globalThis.__chatgptNotifierBuildIdentity = Object.freeze({
  schemaVersion: 1,
  sourceCommit: '$SourceCommit'
});
"@
Set-Content -LiteralPath $runtimeIdentityPath -Value $runtimeIdentityText -Encoding UTF8

# The protected Dan-session deployment adapter intentionally has a bounded bundle
# inventory. Keep development source modular, but coalesce the fixed fail-closed
# bootstrap sequence in the managed payload so normal candidate deployment does
# not require a privileged broker upgrade every time source modules grow.
$managedBootstrapSources = @(
    'page-runtime-compat-background.js',
    'background.js',
    'watchdog-sole-continuation-authority-background.js',
    'watchdog-request-lifecycle-fix-background.js',
    'terminal-watchdog-authority-background.js',
    'stream-terminal-snapshot-notification-background.js',
    'terminal-live-proof-background.js',
    'response-stream-terminal-durable-fallback-background.js',
    'quick-continue-monitor-bridge-background.js',
    'watchdog-authority-v3-background.js',
    'terminal-stop-post-update-recovery-background.js',
    'recovery-refresh-policy-background.js'
)
foreach ($name in $managedBootstrapSources) {
    if (-not (Test-Path -LiteralPath (Join-Path $bundleExtensionRoot $name) -PathType Leaf)) {
        throw "Managed bootstrap source is missing from the copied extension: $name"
    }
}

$bootstrapPath = Join-Path $bundleExtensionRoot 'diagnostics-bootstrap.js'
$bootstrapText = Get-Content -LiteralPath $bootstrapPath -Raw -Encoding UTF8
$bootstrapImportLines = $managedBootstrapSources | ForEach-Object { "importScripts('$_');" }
$bootstrapImportPattern = (($bootstrapImportLines | ForEach-Object { [regex]::Escape($_) }) -join '\r?\n') + '\r?\n'
$bootstrapMatch = [regex]::Match($bootstrapText, $bootstrapImportPattern)
if (-not $bootstrapMatch.Success -or $bootstrapMatch.Index -gt 64) {
    throw 'Diagnostics bootstrap no longer begins with the reviewed managed-bootstrap import sequence.'
}

$aggregatePath = Join-Path $bundleExtensionRoot 'managed-bootstrap-core.js'
$aggregateParts = New-Object Collections.Generic.List[string]
foreach ($name in $managedBootstrapSources) {
    $moduleText = Get-Content -LiteralPath (Join-Path $bundleExtensionRoot $name) -Raw -Encoding UTF8
    $aggregateParts.Add("// managed-source: $name`n$moduleText")
}
[IO.File]::WriteAllText(
    $aggregatePath,
    (($aggregateParts.ToArray() -join "`n;`n") + "`n"),
    (New-Object Text.UTF8Encoding($false)))

$rewrittenBootstrap = $bootstrapText.Substring(0, $bootstrapMatch.Index) + "importScripts('managed-bootstrap-core.js');`r`n" + $bootstrapText.Substring($bootstrapMatch.Index + $bootstrapMatch.Length)
[IO.File]::WriteAllText($bootstrapPath, $rewrittenBootstrap, (New-Object Text.UTF8Encoding($false)))
foreach ($name in $managedBootstrapSources) {
    Remove-Item -LiteralPath (Join-Path $bundleExtensionRoot $name) -Force
}

# These historical data contracts are retained in source for documentation/tests,
# but no production extension code names or loads them. Refuse to omit them if a
# future runtime starts referencing either file.
$sourceOnlyContracts = @(
    'github-work-status-contract.v1.json',
    'github-work-status-contract.v2.json'
)
$runtimeReferenceFiles = @(Get-ChildItem -LiteralPath $sourceExtensionRoot -File | Where-Object { $_.Extension -in @('.js', '.html', '.json') })
foreach ($contract in $sourceOnlyContracts) {
    $references = @($runtimeReferenceFiles | Where-Object {
        $_.Name -ne $contract -and (Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8).Contains($contract)
    })
    if ($references.Count -gt 0) {
        throw "Source-only contract became a production runtime dependency: $contract"
    }
    Remove-Item -LiteralPath (Join-Path $bundleExtensionRoot $contract) -Force
}

Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination (Join-Path $bundleRoot 'LICENSE') -Force

$installText = @"
ChatGPT Response Notifier $version
Source: $SourceCommit
Transport: localhost WebSocket

MANAGED-UPDATE PAYLOAD
This directory is the hash-verified payload consumed by an already-installed ChatGPT Response Notifier helper. It is not the user-facing bootstrap installer.

For a first install or transport migration, use the separately published ChatGPT-Response-Notifier-Setup-$version.exe release asset.
"@
Set-Content -LiteralPath (Join-Path $bundleRoot 'INSTALL.txt') -Value $installText -Encoding UTF8

$fileRecords = @()
Get-ChildItem -LiteralPath $bundleRoot -Recurse -File | Sort-Object FullName | ForEach-Object {
    $relativePath = $_.FullName.Substring($bundleRoot.Length).TrimStart('\')
    if ($relativePath -eq 'bundle-manifest.json') { return }
    $fileRecords += [ordered]@{
        path = $relativePath.Replace('\', '/')
        bytes = $_.Length
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
if ($fileRecords.Count -gt 64) {
    throw "Managed bundle inventory exceeds the installed protected-deployment contract: $($fileRecords.Count) > 64."
}
if (@($fileRecords | Where-Object { $_.path -eq 'extension/managed-bootstrap-core.js' }).Count -ne 1) {
    throw 'Managed bundle is missing the deterministic bootstrap aggregate.'
}
foreach ($removed in @($managedBootstrapSources + $sourceOnlyContracts)) {
    if (@($fileRecords | Where-Object { $_.path -eq "extension/$removed" }).Count -gt 0) {
        throw "Managed bundle unexpectedly retained a coalesced/source-only file: $removed"
    }
}

$manifest = [ordered]@{
    schemaVersion = 1
    project = 'ChatGPT Response Notifier'
    version = $version
    sourceCommit = $SourceCommit
    runtime = 'win-x64'
    transport = 'localhost-websocket'
    selfContained = $true
    nativeLibrariesEmbedded = $true
    extensionRootName = 'Extension-v2'
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    files = $fileRecords
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $bundleRoot 'bundle-manifest.json') -Encoding UTF8

Write-Host "Bundle ready: $bundleRoot ($($fileRecords.Count) managed files)"
Write-Output $bundleRoot
