param(
    [string]$ExtensionRoot = (Join-Path $PSScriptRoot '..\extension'),
    [Parameter(Mandatory = $true)]
    [string]$PrivateKeyPath,
    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$resolvedExtensionRoot = (Resolve-Path -LiteralPath $ExtensionRoot).Path
$resolvedPrivateKey = (Resolve-Path -LiteralPath $PrivateKeyPath).Path
$manifestPath = Join-Path $resolvedExtensionRoot 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Extension manifest is missing.' }
if (-not (Test-Path -LiteralPath $resolvedPrivateKey -PathType Leaf)) { throw 'Private key file is missing.' }

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
$manifestKey = [string]$manifest.key
if ([string]::IsNullOrWhiteSpace($manifestKey)) { throw 'Development manifest does not contain the stable public identity key.' }

# Verify the supplied private key actually owns the public key that determines the
# current unpacked extension ID. Never print, copy to the repository, or persist
# derived private-key material.
$rsa = [System.Security.Cryptography.RSA]::Create()
try {
    $pem = [IO.File]::ReadAllText($resolvedPrivateKey)
    $rsa.ImportFromPem($pem)
    $derivedPublicKey = [Convert]::ToBase64String($rsa.ExportSubjectPublicKeyInfo())
    if ($derivedPublicKey -cne $manifestKey) {
        throw 'Supplied private key does not match the notifier manifest public key. Refusing to build an ID-preserving first-upload package.'
    }
}
finally {
    $rsa.Dispose()
}

$outputFull = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $outputFull
if ([string]::IsNullOrWhiteSpace($outputDirectory)) { $outputDirectory = (Get-Location).Path }
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$workspace = Join-Path ([IO.Path]::GetTempPath()) ('chatgpt-notifier-cws-first-' + [Guid]::NewGuid().ToString('N'))
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

    Copy-Item -LiteralPath $resolvedPrivateKey -Destination (Join-Path $packageRoot 'key.pem') -Force

    Remove-Item -LiteralPath $outputFull -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path (Join-Path $packageRoot '*') -DestinationPath $outputFull -CompressionLevel Optimal -Force
    if (-not (Test-Path -LiteralPath $outputFull -PathType Leaf)) { throw 'Chrome Web Store first-upload package was not created.' }

    $hash = (Get-FileHash -LiteralPath $outputFull -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host ("ID-preserving Chrome Web Store first-upload package built: version={0}; sha256={1}" -f [string]$manifest.version, $hash)
}
finally {
    Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
}
