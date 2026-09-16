[CmdletBinding()]
param(
    [string]$ExtensionRoot = '',
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
    [ValidateSet('Seed', 'Bound')]
    [string]$IdentityMode = 'Seed',
    [string]$IdentityMetadataPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Drawing

if ([string]::IsNullOrWhiteSpace($ExtensionRoot)) {
    $ExtensionRoot = Join-Path $PSScriptRoot '..\extension'
}
if ([string]::IsNullOrWhiteSpace($IdentityMetadataPath)) {
    $IdentityMetadataPath = Join-Path $PSScriptRoot '..\store\chrome-web-store.identity.json'
}

function Normalize-PublicKey([string]$Value) {
    if ($null -eq $Value) { return '' }
    return ([regex]::Replace($Value, '\s+', ''))
}

function Get-ChromeExtensionId([string]$PublicKey) {
    $normalized = Normalize-PublicKey $PublicKey
    if ([string]::IsNullOrWhiteSpace($normalized)) { throw 'Chrome extension public key is empty.' }
    try { $keyBytes = [Convert]::FromBase64String($normalized) }
    catch { throw 'Chrome extension public key is not valid base64.' }

    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { $digest = $sha256.ComputeHash($keyBytes) }
    finally { $sha256.Dispose() }

    $alphabet = 'abcdefghijklmnop'
    $builder = New-Object Text.StringBuilder 32
    foreach ($byte in $digest[0..15]) {
        [void]$builder.Append($alphabet[([int]$byte -shr 4) -band 0x0f])
        [void]$builder.Append($alphabet[[int]$byte -band 0x0f])
    }
    return $builder.ToString()
}

function Write-StoreIcon([int]$Size, [string]$Path) {
    $bitmap = New-Object System.Drawing.Bitmap -ArgumentList $Size, $Size
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $background = $null
    $foreground = $null
    $accent = $null
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.Clear([System.Drawing.Color]::Transparent)

        $scale = $Size / 128.0
        $backgroundColor = [System.Drawing.Color]::FromArgb(255, 28, 32, 40)
        $foregroundColor = [System.Drawing.Color]::FromArgb(255, 248, 250, 252)
        $accentColor = [System.Drawing.Color]::FromArgb(255, 70, 164, 255)
        $background = New-Object System.Drawing.SolidBrush -ArgumentList $backgroundColor
        $foreground = New-Object System.Drawing.SolidBrush -ArgumentList $foregroundColor
        $accent = New-Object System.Drawing.SolidBrush -ArgumentList $accentColor

        # Keep the primary mark inside a 96x96 box so the 128px Store icon has
        # Chrome's recommended 16px transparent padding on every side.
        $graphics.FillEllipse($background, 16 * $scale, 16 * $scale, 96 * $scale, 96 * $scale)
        $graphics.FillRectangle($foreground, 38 * $scale, 43 * $scale, 52 * $scale, 35 * $scale)
        $tail = [System.Drawing.PointF[]]@(
            (New-Object System.Drawing.PointF -ArgumentList (45 * $scale), (77 * $scale)),
            (New-Object System.Drawing.PointF -ArgumentList (45 * $scale), (91 * $scale)),
            (New-Object System.Drawing.PointF -ArgumentList (59 * $scale), (77 * $scale))
        )
        $graphics.FillPolygon($foreground, $tail)
        foreach ($x in @(48, 62, 76)) {
            $graphics.FillEllipse($background, $x * $scale, 57 * $scale, 5 * $scale, 5 * $scale)
        }
        $graphics.FillEllipse($accent, 83 * $scale, 30 * $scale, 18 * $scale, 18 * $scale)

        $directory = Split-Path -Parent $Path
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        if ($null -ne $accent) { $accent.Dispose() }
        if ($null -ne $foreground) { $foreground.Dispose() }
        if ($null -ne $background) { $background.Dispose() }
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

$resolvedExtensionRoot = (Resolve-Path -LiteralPath $ExtensionRoot).Path
$manifestPath = Join-Path $resolvedExtensionRoot 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Extension manifest is missing: $manifestPath"
}

# Signing material must never enter source, a workflow artifact, or a Store ZIP.
$pemFiles = @(Get-ChildItem -LiteralPath $resolvedExtensionRoot -File -Recurse -Filter '*.pem' -ErrorAction Stop)
if ($pemFiles.Count -gt 0) {
    throw 'Extension source contains a PEM file. Private signing keys must remain outside the repository and packaging workspace.'
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
$version = [string]$manifest.version
if ([string]::IsNullOrWhiteSpace($version)) { throw 'Extension manifest version is empty.' }
$sourceKey = Normalize-PublicKey ([string]$manifest.key)
if ([string]::IsNullOrWhiteSpace($sourceKey)) { throw 'Development manifest is missing its stable public key.' }
$sourceId = Get-ChromeExtensionId $sourceKey

if ($IdentityMode -eq 'Bound') {
    if (-not (Test-Path -LiteralPath $IdentityMetadataPath -PathType Leaf)) {
        throw 'Bound Store packaging requires store/chrome-web-store.identity.json created from the Chrome Web Store assigned item ID/public key.'
    }
    $identity = Get-Content -LiteralPath $IdentityMetadataPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    if ([int]$identity.schemaVersion -ne 1) { throw 'Unsupported Chrome Web Store identity metadata schema.' }
    $storeItemId = [string]$identity.itemId
    $storePublicKey = Normalize-PublicKey ([string]$identity.publicKey)
    if ($storeItemId -notmatch '^[a-p]{32}$') { throw 'Chrome Web Store item ID is invalid.' }
    if ($storePublicKey -cne $sourceKey) { throw 'Development manifest public key does not match the bound Chrome Web Store public key.' }
    $derivedStoreId = Get-ChromeExtensionId $storePublicKey
    if ($derivedStoreId -cne $storeItemId -or $sourceId -cne $storeItemId) {
        throw "Bound Store identity mismatch: item=$storeItemId; source=$sourceId; derived=$derivedStoreId."
    }
}

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

    # A Seed package is only for creating the initial Store item. Chrome Web Store
    # assigns that item a public key/ID; after the assigned identity is recorded in
    # source, Bound packages fail closed unless all identity surfaces match it.
    if ($IdentityMode -eq 'Seed') {
        if ($null -ne $storeManifest.PSObject.Properties['key']) {
            $storeManifest.PSObject.Properties.Remove('key')
        }
    }

    $iconPaths = [ordered]@{
        '16' = 'images/store-icon-16.png'
        '32' = 'images/store-icon-32.png'
        '48' = 'images/store-icon-48.png'
        '128' = 'images/store-icon-128.png'
    }
    foreach ($entry in $iconPaths.GetEnumerator()) {
        Write-StoreIcon -Size ([int]$entry.Key) -Path (Join-Path $packageRoot $entry.Value)
    }

    $iconObject = [pscustomobject]$iconPaths
    $storeManifest | Add-Member -NotePropertyName icons -NotePropertyValue $iconObject -Force
    if ($null -ne $storeManifest.PSObject.Properties['action']) {
        $storeManifest.action | Add-Member -NotePropertyName default_icon -NotePropertyValue $iconObject -Force
    }

    $utf8NoBom = New-Object Text.UTF8Encoding -ArgumentList $false
    [IO.File]::WriteAllText($storeManifestPath, ($storeManifest | ConvertTo-Json -Depth 32), $utf8NoBom)

    if (@(Get-ChildItem -LiteralPath $packageRoot -File -Recurse -Filter '*.pem').Count -gt 0) {
        throw 'PEM file unexpectedly entered the Chrome Web Store packaging workspace.'
    }

    Remove-Item -LiteralPath $outputFull -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path (Join-Path $packageRoot '*') -DestinationPath $outputFull -CompressionLevel Optimal -Force
    if (-not (Test-Path -LiteralPath $outputFull -PathType Leaf)) { throw 'Chrome Web Store package was not created.' }

    $hash = (Get-FileHash -LiteralPath $outputFull -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host ("Chrome Web Store package built: mode={0}; sourceId={1}; version={2}; sha256={3}; output={4}" -f $IdentityMode, $sourceId, $version, $hash, $outputFull)
}
finally {
    Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
}
