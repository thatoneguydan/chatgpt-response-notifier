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

if ([string]::IsNullOrWhiteSpace($SourceCommit)) {
    $SourceCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($SourceCommit)) {
        throw 'Could not resolve the exact source commit for the bundle.'
    }
}

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
Copy-Item -LiteralPath (Join-Path $root 'extension') -Destination (Join-Path $bundleRoot 'extension') -Recurse -Force

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

$manifest = [ordered]@{
    schemaVersion = 1
    project = 'ChatGPT Response Notifier'
    version = $version
    sourceCommit = $SourceCommit
    runtime = 'win-x64'
    transport = 'localhost-websocket'
    selfContained = $true
    nativeLibrariesEmbedded = $true
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    files = $fileRecords
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $bundleRoot 'bundle-manifest.json') -Encoding UTF8

Write-Host "Bundle ready: $bundleRoot"
Write-Output $bundleRoot
