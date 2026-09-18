[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'ChatGPTQuickContinue\Extension')
)

$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$requiredFiles = @(
    'manifest.json',
    'prompt-format.js',
    'content-script.js'
)

foreach ($file in $requiredFiles) {
    $sourcePath = Join-Path $sourceRoot $file
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Required extension file is missing: $sourcePath"
    }
}

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null

$managedFiles = @(
    'manifest.json',
    'prompt-format.js',
    'content-script.js',
    'README.md'
)

foreach ($file in $managedFiles) {
    $sourcePath = Join-Path $sourceRoot $file
    if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
        Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $InstallRoot $file) -Force
    }
}

$manifest = Get-Content -LiteralPath (Join-Path $InstallRoot 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.name -ne 'ChatGPT Quick Continue') {
    throw 'Installed manifest identity did not match ChatGPT Quick Continue.'
}

Write-Host ''
Write-Host "ChatGPT Quick Continue $($manifest.version) copied to:"
Write-Host "  $InstallRoot"
Write-Host ''
Write-Host 'Chrome one-time setup:'
Write-Host '  1. Open chrome://extensions'
Write-Host '  2. Enable Developer mode'
Write-Host '  3. Choose Load unpacked'
Write-Host "  4. Select: $InstallRoot"
Write-Host ''
Write-Host 'Future updates can reuse this installer; the stable install path does not change.'
