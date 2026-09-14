[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$manifestPath = Join-Path $repoRoot 'extension\manifest.json'
$constantsPath = Join-Path $repoRoot 'src\ChatGPTResponseNotifier.Core\LocalBridgeConstants.cs'
$bridgePath = Join-Path $repoRoot 'src\ChatGPTResponseNotifier.Host\LocalBridgeServer.cs'
$installerPath = Join-Path $repoRoot 'src\ChatGPTResponseNotifier.Core\BundleInstaller.cs'
$expectedId = 'lciedmoiiapbgemklkpoadimhffaaaah'
$expectedOrigin = "chrome-extension://$expectedId"
$unsafeLegacyId = 'pbbmmjcakamllfpcglbhcpmbpegapgih'
$unsafeLegacyOrigin = "chrome-extension://$unsafeLegacyId"

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$key = [string]$manifest.key
if ([string]::IsNullOrWhiteSpace($key)) { throw 'Extension manifest key is missing.' }

try {
    $keyBytes = [Convert]::FromBase64String($key)
}
catch {
    throw 'Extension manifest key is not valid base64.'
}

# The reviewed stable RSA public key is a 294-byte DER SubjectPublicKeyInfo.
# A shorter value previously changed Chrome's extension ID and caused the helper
# to reject every loopback WebSocket connection by Origin.
if ($keyBytes.Length -ne 294) {
    throw "Extension manifest public key length mismatch: expected 294 bytes, got $($keyBytes.Length)."
}

$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $digest = $sha256.ComputeHash($keyBytes)
}
finally {
    $sha256.Dispose()
}

$alphabet = 'abcdefghijklmnop'
$idBuilder = New-Object Text.StringBuilder 32
foreach ($byte in $digest[0..15]) {
    [void]$idBuilder.Append($alphabet[([int]$byte -shr 4) -band 0x0f])
    [void]$idBuilder.Append($alphabet[[int]$byte -band 0x0f])
}
$derivedId = $idBuilder.ToString()
if ($derivedId -cne $expectedId) {
    throw "Extension manifest key derives unexpected Chrome extension ID: expected $expectedId, got $derivedId."
}

$constantsText = Get-Content -LiteralPath $constantsPath -Raw -Encoding UTF8
$originMatch = [regex]::Match($constantsText, 'ExtensionOrigin\s*=\s*"(chrome-extension://[a-p]{32})"')
if (-not $originMatch.Success) { throw 'Could not resolve helper ExtensionOrigin constant.' }
$helperOrigin = $originMatch.Groups[1].Value
if ($helperOrigin -cne $expectedOrigin) {
    throw "Helper extension Origin mismatch: expected $expectedOrigin, got $helperOrigin."
}

$bridgeText = Get-Content -LiteralPath $bridgePath -Raw -Encoding UTF8
foreach ($pair in @(
    @{ Name = 'helper constants'; Text = $constantsText },
    @{ Name = 'bridge server'; Text = $bridgeText }
)) {
    if ($pair.Text.IndexOf($unsafeLegacyId, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $pair.Text.IndexOf($unsafeLegacyOrigin, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $pair.Text.IndexOf('LegacyIdentityMigrationOrigin', [StringComparison]::Ordinal) -ge 0) {
        throw "Unsafe legacy Chrome-ID migration remains in $($pair.Name)."
    }
}

if ($bridgeText.IndexOf('LocalBridgeConstants.ExtensionOrigin', [StringComparison]::Ordinal) -lt 0 -or
    $bridgeText.IndexOf('StatusCodes.Status403Forbidden', [StringComparison]::Ordinal) -lt 0) {
    throw 'Bridge server no longer structurally enforces the single stable extension Origin.'
}

$installerText = Get-Content -LiteralPath $installerPath -Raw -Encoding UTF8
if ($installerText.IndexOf('UpdateDirectoryPreservingRoot', [StringComparison]::Ordinal) -lt 0 -or
    $installerText.IndexOf('CopyExtensionDirectoryManifestLast', [StringComparison]::Ordinal) -lt 0) {
    throw 'Extension installer is missing the root-preserving manifest-last update contract.'
}
if ($installerText -match 'Directory\.Move\s*\(\s*destination\s*,') {
    throw 'Extension installer must never rename/move away the live unpacked extension root.'
}

Write-Host "Extension identity/update contract passed: stable=$derivedId; legacy-ID migration rejected; live root preserved"
