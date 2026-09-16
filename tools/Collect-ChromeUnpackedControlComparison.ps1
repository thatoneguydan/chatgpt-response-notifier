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
        'profile','source','extensionId','role','stateValue','locationValue','creationFlagsValue','fromWebStore',
        'disableReasonCount','pathAvailable','pathIsAbsolute','pathCategory','pathMatchesForkRoot','pathExists',
        'manifestExists','manifestReadable','manifestName','manifestVersion','manifestKeyPresent','calculatedExtensionId',
        'calculatedIdMatchesRegistration','targetsChatGPT'
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
$snapshotPath = Join-Path $installRoot 'Evidence\chrome-unpacked-control-comparison.json'
$result = [ordered]@{
    schemaVersion = 1
    capability = 'chrome-unpacked-control-comparison-readonly-v1'
    source = 'helper-snapshot'
    observedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    readOnly = $true
    state = 'helper-snapshot-unavailable'
    targetExtensionId = $null
    lastUsedProfile = $null
    profilesDiscovered = 0
    profileFilesInspected = 0
    profileFilesUnavailable = 0
    targetRegistrationCount = 0
    controlCandidateCount = 0
    controlCandidateIds = @()
    records = @()
}

try {
    $raw = Get-Content -LiteralPath $snapshotPath -Raw -Encoding UTF8 -ErrorAction Stop
    $snapshot = $raw | ConvertFrom-Json -ErrorAction Stop
    if ([int](Get-PropertyValue -InputObject $snapshot -Name 'schemaVersion') -ne 1) { throw 'Unexpected helper snapshot schema.' }
    if ([string](Get-PropertyValue -InputObject $snapshot -Name 'capability') -cne 'chrome-unpacked-control-comparison-readonly-helper-v1') { throw 'Unexpected helper snapshot capability.' }
    if ((Get-PropertyValue -InputObject $snapshot -Name 'readOnly') -ne $true) { throw 'Helper snapshot is not marked read-only.' }

    $observedText = [string](Get-PropertyValue -InputObject $snapshot -Name 'observedAtUtc')
    $observed = [DateTimeOffset]::Parse($observedText)
    $age = ([DateTimeOffset]::UtcNow - $observed).TotalSeconds
    if ($age -lt -5 -or $age -gt 180) { throw 'Helper snapshot is stale.' }

    $result.observedAtUtc = $observed.ToString('o')
    foreach ($name in @(
        'state','targetExtensionId','lastUsedProfile','profilesDiscovered','profileFilesInspected',
        'profileFilesUnavailable','targetRegistrationCount','controlCandidateCount'
    )) {
        $value = Get-PropertyValue -InputObject $snapshot -Name $name
        if ($null -ne $value) { $result[$name] = $value }
    }

    $ids = @()
    foreach ($id in @(Get-PropertyValue -InputObject $snapshot -Name 'controlCandidateIds') | Select-Object -First 32) {
        $text = [string]$id
        if ($text -match '^[a-p]{32}$') { $ids += $text }
    }
    $result.controlCandidateIds = $ids

    $records = @()
    foreach ($record in @(Get-PropertyValue -InputObject $snapshot -Name 'records') | Select-Object -First 128) {
        $copy = Copy-SafeRecord -Record $record
        if ($null -ne $copy) { $records += $copy }
    }
    $result.records = $records
}
catch {
    # The helper may not contain this diagnostic publisher until the source is
    # merged and deployed. That pre-deployment state is intentional and safe.
    $result.state = 'helper-snapshot-unavailable'
}

$parent = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
[pscustomobject]$result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $OutputPath -Encoding UTF8

Write-Host ('Chrome unpacked comparison: source={0}; state={1}; target={2}; targetRegistrations={3}; controlCandidates={4}; profiles={5}; inspected={6}; unavailable={7}' -f `
    $result.source,
    $result.state,
    $result.targetExtensionId,
    $result.targetRegistrationCount,
    $result.controlCandidateCount,
    $result.profilesDiscovered,
    $result.profileFilesInspected,
    $result.profileFilesUnavailable)
