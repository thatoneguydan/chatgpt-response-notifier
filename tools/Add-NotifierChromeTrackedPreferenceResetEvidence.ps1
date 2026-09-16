param(
    [Parameter(Mandatory = $true)]
    [string]$EvidencePath,
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

$result = [ordered]@{
    source = 'helper-snapshot'
    capability = 'chrome-tracked-preference-reset-readonly-v1'
    observedAtUtc = $null
    state = 'unavailable'
    lastUsedProfile = $null
    registrationPresent = $null
    notifierTrackedResetRecorded = $null
    extensionsSettingsResetRecorded = $null
    trackedResetEntryCount = $null
    preferenceResetTimePresent = $null
    sourceProfileMutated = $null
}

$snapshotPath = Join-Path $ExpectedProfileRoot 'AppData\Local\ChatGPTResponseNotifier\Evidence\chrome-tracked-preference-reset-evidence.json'
try {
    $snapshot = Get-Content -LiteralPath $snapshotPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ([int](Get-PropertyValue -InputObject $snapshot -Name 'schemaVersion') -ne 1) { throw 'Unexpected tracked reset evidence schema.' }
    if ([string](Get-PropertyValue -InputObject $snapshot -Name 'capability') -cne 'chrome-tracked-preference-reset-readonly-v1') { throw 'Unexpected tracked reset evidence capability.' }

    $observed = [DateTimeOffset]::Parse([string](Get-PropertyValue -InputObject $snapshot -Name 'observedAtUtc'))
    $age = ([DateTimeOffset]::UtcNow - $observed).TotalSeconds
    if ($age -lt -5 -or $age -gt 180) { throw 'Tracked reset helper snapshot is stale.' }

    $result.observedAtUtc = $observed.ToString('o')
    foreach ($name in @('state','lastUsedProfile','registrationPresent','notifierTrackedResetRecorded','extensionsSettingsResetRecorded','trackedResetEntryCount','preferenceResetTimePresent','sourceProfileMutated')) {
        $value = Get-PropertyValue -InputObject $snapshot -Name $name
        if ($null -ne $value) { $result[$name] = $value }
    }
}
catch {
    $result.state = 'unavailable'
}

$evidence = Get-Content -LiteralPath $EvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
$evidence.chrome | Add-Member -NotePropertyName trackedPreferenceReset -NotePropertyValue ([pscustomobject]$result) -Force
$evidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8

Write-Host ('Chrome tracked reset: state={0}; profile={1}; registered={2}; notifierReset={3}; extensionsReset={4}; resetCount={5}; resetTime={6}' -f `
    $result.state,
    $result.lastUsedProfile,
    $result.registrationPresent,
    $result.notifierTrackedResetRecorded,
    $result.extensionsSettingsResetRecorded,
    $result.trackedResetEntryCount,
    $result.preferenceResetTimePresent)
