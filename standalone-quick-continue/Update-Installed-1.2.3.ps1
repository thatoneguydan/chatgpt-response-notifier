$ErrorActionPreference = 'Stop'

$target = Join-Path $env:LOCALAPPDATA 'ChatGPTQuickContinue\Extension'
$commit = 'a305525f10e6798501538c8d7e4409576bb805a9'
$baseUrl = "https://raw.githubusercontent.com/thatoneguydan/chatgpt-response-notifier/$commit/standalone-quick-continue"
$temp = Join-Path $env:TEMP ("ChatGPTQuickContinue-1.2.3-" + [Guid]::NewGuid().ToString('N'))
$backupRoot = Join-Path $env:LOCALAPPDATA 'ChatGPTQuickContinue\Backups'
$backup = Join-Path $backupRoot ("pre-1.2.3-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))

if (-not (Test-Path -LiteralPath $target)) {
    throw "Quick Continue install path not found: $target"
}

$manifestPath = Join-Path $target 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Quick Continue manifest not found: $manifestPath"
}

$before = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

New-Item -ItemType Directory -Path $temp -Force | Out-Null
New-Item -ItemType Directory -Path $backup -Force | Out-Null

try {
    foreach ($name in @('manifest.json', 'content-script.js')) {
        $sourceUrl = "$baseUrl/$name"
        $downloadPath = Join-Path $temp $name
        Invoke-WebRequest -UseBasicParsing -Uri $sourceUrl -OutFile $downloadPath
    }

    $downloadedManifest = Get-Content -LiteralPath (Join-Path $temp 'manifest.json') -Raw | ConvertFrom-Json
    if ([string]$downloadedManifest.version -ne '1.2.3') {
        throw "Downloaded Quick Continue manifest is version $($downloadedManifest.version), expected 1.2.3."
    }

    foreach ($name in @('manifest.json', 'content-script.js')) {
        $existing = Join-Path $target $name
        if (Test-Path -LiteralPath $existing) {
            Copy-Item -LiteralPath $existing -Destination (Join-Path $backup $name) -Force
        }
        Copy-Item -LiteralPath (Join-Path $temp $name) -Destination $existing -Force

        $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $temp $name)).Hash
        $targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $existing).Hash
        if ($sourceHash -ne $targetHash) {
            throw "Verification failed after copying $name."
        }
    }

    $after = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ([string]$after.version -ne '1.2.3') {
        throw "Installed Quick Continue version is $($after.version), expected 1.2.3."
    }

    [pscustomobject]@{
        status = 'installed'
        previousVersion = [string]$before.version
        version = [string]$after.version
        backupPath = $backup
        targetPath = $target
    } | ConvertTo-Json -Compress | ForEach-Object { "QUICK_CONTINUE_UPDATE|$_" }
}
finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
