[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ItemId,
    [Parameter(Mandatory = $true)]
    [string]$PublicKey,
    [string]$RepositoryRoot = (Join-Path $PSScriptRoot '..'),
    [switch]$ReplaceExistingBinding
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Normalize-PublicKey([string]$Value) {
    if ($null -eq $Value) { return '' }
    return ([regex]::Replace($Value, '\s+', ''))
}

function Get-ChromeExtensionId([string]$Value) {
    $normalized = Normalize-PublicKey $Value
    if ([string]::IsNullOrWhiteSpace($normalized)) { throw 'Chrome Web Store public key is empty.' }
    try { $bytes = [Convert]::FromBase64String($normalized) }
    catch { throw 'Chrome Web Store public key is not valid base64.' }

    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { $digest = $sha256.ComputeHash($bytes) }
    finally { $sha256.Dispose() }

    $alphabet = 'abcdefghijklmnop'
    $builder = New-Object Text.StringBuilder 32
    foreach ($byte in $digest[0..15]) {
        [void]$builder.Append($alphabet[([int]$byte -shr 4) -band 0x0f])
        [void]$builder.Append($alphabet[[int]$byte -band 0x0f])
    }
    return $builder.ToString()
}

function Replace-ExactlyOnce([string]$Text, [string]$Pattern, [string]$Replacement, [string]$Description) {
    $matches = [regex]::Matches($Text, $Pattern)
    if ($matches.Count -ne 1) { throw "$Description expected exactly one match; found $($matches.Count)." }
    return [regex]::Replace($Text, $Pattern, $Replacement, 1)
}

$root = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$normalizedKey = Normalize-PublicKey $PublicKey
$derivedId = Get-ChromeExtensionId $normalizedKey
if ($derivedId -cne $ItemId) {
    throw "Chrome Web Store identity mismatch: supplied item ID $ItemId but public key derives $derivedId."
}

$manifestPath = Join-Path $root 'extension\manifest.json'
$bridgeConstantsPath = Join-Path $root 'src\ChatGPTResponseNotifier.Core\LocalBridgeConstants.cs'
$nativeConstantsPath = Join-Path $root 'src\ChatGPTResponseNotifier.Core\NativeHostConstants.cs'
$identityTestPath = Join-Path $root 'tools\Test-ExtensionIdentity.ps1'
$identityDirectory = Join-Path $root 'store'
$identityPath = Join-Path $identityDirectory 'chrome-web-store.identity.json'

foreach ($required in @($manifestPath, $bridgeConstantsPath, $nativeConstantsPath, $identityTestPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required identity surface is missing: $required" }
}

if (Test-Path -LiteralPath $identityPath -PathType Leaf) {
    $existing = Get-Content -LiteralPath $identityPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    $existingId = [string]$existing.itemId
    $existingKey = Normalize-PublicKey ([string]$existing.publicKey)
    if (($existingId -cne $ItemId -or $existingKey -cne $normalizedKey) -and -not $ReplaceExistingBinding) {
        throw 'A different Chrome Web Store identity is already bound. Rebinding requires the explicit -ReplaceExistingBinding switch and a reviewed migration.'
    }
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
$currentKey = Normalize-PublicKey ([string]$manifest.key)
$currentId = if ([string]::IsNullOrWhiteSpace($currentKey)) { '' } else { Get-ChromeExtensionId $currentKey }
$manifest.key = $normalizedKey

$bridgeText = Get-Content -LiteralPath $bridgeConstantsPath -Raw -Encoding UTF8
$bridgeText = Replace-ExactlyOnce $bridgeText 'ExtensionOrigin\s*=\s*"chrome-extension://[a-p]{32}"' ('ExtensionOrigin = "chrome-extension://' + $ItemId + '"') 'Local bridge extension origin'

$nativeText = Get-Content -LiteralPath $nativeConstantsPath -Raw -Encoding UTF8
$nativeText = Replace-ExactlyOnce $nativeText 'ExtensionId\s*=\s*"[a-p]{32}"' ('ExtensionId = "' + $ItemId + '"') 'Native host extension ID'

$testText = Get-Content -LiteralPath $identityTestPath -Raw -Encoding UTF8
$testText = Replace-ExactlyOnce $testText '\$expectedId\s*=\s*''[a-p]{32}''' ('$expectedId = ''' + $ItemId + '''') 'Identity test expected ID'

$utf8NoBom = New-Object Text.UTF8Encoding -ArgumentList $false
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 32), $utf8NoBom)
[IO.File]::WriteAllText($bridgeConstantsPath, $bridgeText, $utf8NoBom)
[IO.File]::WriteAllText($nativeConstantsPath, $nativeText, $utf8NoBom)
[IO.File]::WriteAllText($identityTestPath, $testText, $utf8NoBom)

New-Item -ItemType Directory -Path $identityDirectory -Force | Out-Null
$metadata = [ordered]@{
    schemaVersion = 1
    itemId = $ItemId
    publicKey = $normalizedKey
    previousDevelopmentId = $currentId
    bindingSource = 'chrome-web-store-assigned-public-key'
}
[IO.File]::WriteAllText($identityPath, ($metadata | ConvertTo-Json -Depth 4), $utf8NoBom)

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $identityTestPath
if ($LASTEXITCODE -ne 0) { throw "Extension identity regression test failed after Store binding with exit code $LASTEXITCODE." }

Write-Host "Chrome Web Store identity bound: previous=$currentId; store=$ItemId. Review and commit all identity-surface changes together."
