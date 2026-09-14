[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$manifestPath = Join-Path $repoRoot 'extension\manifest.json'
$constantsPath = Join-Path $repoRoot 'src\ChatGPTResponseNotifier.Core\LocalBridgeConstants.cs'
$expectedId = 'lciedmoiiapbgemklkpoadimhffaaaah'
$expectedOrigin = "chrome-extension://$expectedId"

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

Write-Host "Extension identity contract passed: $derivedId"
