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
        throw 'Could not resolve exact source commit for the installer.'
    }
}

$workRoot = Join-Path $env:RUNNER_TEMP ('chatgpt-response-notifier-setup-' + [Guid]::NewGuid().ToString('N'))
$bundleOutput = Join-Path $workRoot 'bundle'
$payloadZip = Join-Path $workRoot 'payload.zip'
$publishRoot = Join-Path $workRoot 'setup-publish'
New-Item -ItemType Directory -Path $bundleOutput -Force | Out-Null
New-Item -ItemType Directory -Path $publishRoot -Force | Out-Null
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

try {
    Write-Host "Building verified payload for Setup.exe $version..."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'Build-TestBundle.ps1') `
        -OutputDirectory $bundleOutput `
        -SourceCommit $SourceCommit
    if ($LASTEXITCODE -ne 0) { throw 'Verified setup payload build failed.' }

    $bundleRoot = Join-Path $bundleOutput "ChatGPT-Response-Notifier-$version"
    if (-not (Test-Path -LiteralPath (Join-Path $bundleRoot 'bundle-manifest.json') -PathType Leaf)) {
        throw 'Verified setup payload manifest is missing.'
    }

    Compress-Archive -Path (Join-Path $bundleRoot '*') -DestinationPath $payloadZip -CompressionLevel Optimal -Force
    if (-not (Test-Path -LiteralPath $payloadZip -PathType Leaf)) { throw 'Setup payload ZIP was not created.' }

    $setupProject = Join-Path $root 'installer\ChatGPTResponseNotifier.Setup.csproj'
    Write-Host 'Publishing dedicated per-user Setup.exe...'
    & dotnet publish $setupProject `
        --configuration Release `
        --runtime win-x64 `
        --self-contained true `
        -p:PublishSingleFile=true `
        -p:IncludeNativeLibrariesForSelfExtract=true `
        "-p:PayloadZipPath=$payloadZip" `
        -o $publishRoot
    if ($LASTEXITCODE -ne 0) { throw 'Setup.exe publish failed.' }

    $builtSetup = Join-Path $publishRoot 'ChatGPTResponseNotifier.Setup.exe'
    if (-not (Test-Path -LiteralPath $builtSetup -PathType Leaf)) { throw 'Published Setup.exe is missing.' }

    $setupName = "ChatGPT-Response-Notifier-Setup-$version.exe"
    $setupPath = Join-Path $OutputDirectory $setupName
    Copy-Item -LiteralPath $builtSetup -Destination $setupPath -Force

    $manifest = [ordered]@{
        schemaVersion = 2
        project = 'ChatGPT Response Notifier'
        packageType = 'per-user-self-contained-setup-exe'
        version = $version
        sourceCommit = $SourceCommit
        transport = 'localhost-websocket'
        setup = $setupName
        bytes = (Get-Item -LiteralPath $setupPath).Length
        sha256 = (Get-FileHash -LiteralPath $setupPath -Algorithm SHA256).Hash.ToLowerInvariant()
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'installer-manifest.json') -Encoding UTF8

    $installText = @"
ChatGPT Response Notifier $version
Source: $SourceCommit

INSTALL
Double-click $setupName.

This is a dedicated per-user Setup.exe. It verifies its embedded payload, installs under LocalAppData, updates the stable unpacked-extension folder, registers the helper at Windows sign-in, starts the helper immediately, and performs a localhost WebSocket ping/pong before reporting success.
"@
    Set-Content -LiteralPath (Join-Path $OutputDirectory 'INSTALL.txt') -Value $installText -Encoding UTF8

    Write-Host "Setup ready: $setupPath"
    Write-Output $setupPath
}
finally {
    Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
}
