param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
    [string]$ExpectedProfileRoot = 'C:\Users\dan'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-PropertyValue {
    param([object]$InputObject, [string]$Name)
    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Copy-SafeRecord {
    param([object]$Record)
    if ($null -eq $Record) { return $null }

    $safe = [ordered]@{}
    foreach ($name in @(
        'source','extensionId','role','locationValue','disableReasonCount','pathAvailable','pathIsAbsolute',
        'pathMatchesForkRoot','pathDerivedExtensionId','pathDerivedIdMatchesRegistration'
    )) {
        $value = Get-PropertyValue -InputObject $Record -Name $name
        if ($null -ne $value) { $safe[$name] = $value }
    }

    $codes = @()
    foreach ($value in @(Get-PropertyValue -InputObject $Record -Name 'disableReasonCodes') | Select-Object -First 16) {
        try { $codes += [int]$value } catch { }
    }
    $safe.disableReasonCodes = $codes
    return [pscustomobject]$safe
}

$installRoot = Join-Path $ExpectedProfileRoot 'AppData\Local\ChatGPTResponseNotifier'
$snapshotPath = Join-Path $installRoot 'Evidence\chrome-unpacked-path-identity.json'
$result = [ordered]@{
    schemaVersion = 1
    capability = 'chrome-unpacked-path-identity-readonly-v1'
    source = 'helper-snapshot'
    observedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    readOnly = $true
    state = 'helper-snapshot-unavailable'
    intendedExtensionId = $null
    knownStaleLegacyExtensionId = 'pbbmmjcakamllfpcglbhcpmbpegapgih'
    profile = 'Default'
    profileFilesInspected = 0
    profileFilesUnavailable = 0
    staleRegistrationPresent = $false
    intendedRegistrationPresent = $false
    stalePathDerivedIdMatchesRegistration = $null
    intendedPathDerivedIdMatchesRegistration = $null
    records = @()
}

try {
    $raw = Get-Content -LiteralPath $snapshotPath -Raw -Encoding UTF8 -ErrorAction Stop
    $snapshot = $raw | ConvertFrom-Json -ErrorAction Stop
    if ([int](Get-PropertyValue -InputObject $snapshot -Name 'schemaVersion') -ne 1) { throw 'Unexpected helper snapshot schema.' }
    if ([string](Get-PropertyValue -InputObject $snapshot -Name 'capability') -cne 'chrome-unpacked-path-identity-readonly-helper-v1') { throw 'Unexpected helper snapshot capability.' }
    if ((Get-PropertyValue -InputObject $snapshot -Name 'readOnly') -ne $true) { throw 'Helper snapshot is not marked read-only.' }

    $observed = [DateTimeOffset]::Parse([string](Get-PropertyValue -InputObject $snapshot -Name 'observedAtUtc'))
    $age = ([DateTimeOffset]::UtcNow - $observed).TotalSeconds
    if ($age -lt -5 -or $age -gt 180) { throw 'Helper snapshot is stale.' }

    $result.observedAtUtc = $observed.ToString('o')
    foreach ($name in @(
        'state','intendedExtensionId','knownStaleLegacyExtensionId','profile','profileFilesInspected','profileFilesUnavailable',
        'staleRegistrationPresent','intendedRegistrationPresent','stalePathDerivedIdMatchesRegistration',
        'intendedPathDerivedIdMatchesRegistration'
    )) {
        $value = Get-PropertyValue -InputObject $snapshot -Name $name
        if ($null -ne $value) { $result[$name] = $value }
    }

    $records = @()
    foreach ($record in @(Get-PropertyValue -InputObject $snapshot -Name 'records') | Select-Object -First 8) {
        $copy = Copy-SafeRecord -Record $record
        if ($null -ne $copy) { $records += $copy }
    }
    $result.records = $records
}
catch {
    # Expected before the diagnostic helper source is deployed.
    $result.state = 'helper-snapshot-unavailable'
}

$parent = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
[pscustomobject]$result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $OutputPath -Encoding UTF8

Write-Host ('Chrome unpacked path identity: state={0}; stalePresent={1}; stalePathIdMatch={2}; targetPresent={3}; targetPathIdMatch={4}; inspected={5}; unavailable={6}' -f `
    $result.state,
    $result.staleRegistrationPresent,
    $result.stalePathDerivedIdMatchesRegistration,
    $result.intendedRegistrationPresent,
    $result.intendedPathDerivedIdMatchesRegistration,
    $result.profileFilesInspected,
    $result.profileFilesUnavailable)
