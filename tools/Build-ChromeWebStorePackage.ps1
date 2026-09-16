param(
    [string]$ExtensionRoot = (Join-Path $PSScriptRoot '..\extension'),
    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$resolvedExtensionRoot = (Resolve-Path -LiteralPath $ExtensionRoot).Path
$manifestPath = Join-Path $resolvedExtensionRoot 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Extension manifest is missing: $manifestPath"
}

# Private signing keys must never enter a repository artifact or ordinary Web Store ZIP.
$pemFiles = @(Get-ChildItem -LiteralPath $resolvedExtensionRoot -File -Recurse -Filter '*.pem' -ErrorAction Stop)
if ($pemFiles.Count -gt 0) {
    throw 'Extension source contains a PEM file. Private signing keys must remain outside the repository and ordinary packaging workspace.'
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
$version = [string]$manifest.version
if ([string]::IsNullOrWhiteSpace($version)) { throw 'Extension manifest version is empty.' }

$outputFull = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $outputFull
if ([string]::IsNullOrWhiteSpace($outputDirectory)) { $outputDirectory = (Get-Location).Path }
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$workspace = Join-Path ([IO.Path]::GetTempPath()) ('chatgpt-notifier-cws-' + [Guid]::NewGuid().ToString('N'))
$packageRoot = Join-Path $workspace 'package'
try {
    New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
    Copy-Item -Path (Join-Path $resolvedExtensionRoot '*') -Destination $packageRoot -Recurse -Force

    $storeManifestPath = Join-Path $packageRoot 'manifest.json'
    $storeManifest = Get-Content -LiteralPath $storeManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    if ($null -ne $storeManifest.PSObject.Properties['key']) {
        $storeManifest.PSObject.Properties.Remove('key')
    }
    $storeManifest | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $storeManifestPath -Encoding UTF8

    if (@(Get-ChildItem -LiteralPath $packageRoot -File -Recurse -Filter '*.pem').Count -gt 0) {
        throw 'PEM file unexpectedly entered the ordinary Web Store packaging workspace.'
    }

    Remove-Item -LiteralPath $outputFull -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path (Join-Path $packageRoot '*') -DestinationPath $outputFull -CompressionLevel Optimal -Force

    if (-not (Test-Path -LiteralPath $outputFull -PathType Leaf)) { throw 'Chrome Web Store package was not created.' }
    $hash = (Get-FileHash -LiteralPath $outputFull -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host ("Chrome Web Store package built: version={0}; sha256={1}; output={2}" -f $version, $hash, $outputFull)
}
finally {
    Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
}
