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
    capability = 'chrome-startup-pref-readonly-helper-v1'
    observedAtUtc = $null
    state = 'unavailable'
    lastUsedProfile = $null
    developerMode = $null
    registrationPresent = $null
    creationFlagsStored = $null
    creationFlagsSource = $null
    effectiveCreationFlags = $null
    installedViaCdp = $null
    fromWebStore = $null
    wasInstalledByDefault = $null
    wasInstalledByOem = $null
    allowFileAccess = $null
}

$snapshotPath = Join-Path $ExpectedProfileRoot 'AppData\Local\ChatGPTResponseNotifier\Evidence\chrome-startup-pref-evidence.json'
try {
    $raw = Get-Content -LiteralPath $snapshotPath -Raw -Encoding UTF8 -ErrorAction Stop
    $snapshot = $raw | ConvertFrom-Json -ErrorAction Stop
    if ([int](Get-PropertyValue -InputObject $snapshot -Name 'schemaVersion') -ne 1) { throw 'Unexpected startup preference evidence schema.' }
    if ([string](Get-PropertyValue -InputObject $snapshot -Name 'capability') -cne 'chrome-startup-pref-readonly-helper-v1') { throw 'Unexpected startup preference evidence capability.' }

    $observedText = [string](Get-PropertyValue -InputObject $snapshot -Name 'observedAtUtc')
    $observed = [DateTimeOffset]::Parse($observedText)
    $age = ([DateTimeOffset]::UtcNow - $observed).TotalSeconds
    if ($age -lt -5 -or $age -gt 180) { throw 'Startup preference helper snapshot is stale.' }

    $result.observedAtUtc = $observed.ToString('o')
    foreach ($name in @(
        'state',
        'lastUsedProfile',
        'developerMode',
        'registrationPresent',
        'creationFlagsStored',
        'creationFlagsSource',
        'effectiveCreationFlags',
        'installedViaCdp',
        'fromWebStore',
        'wasInstalledByDefault',
        'wasInstalledByOem',
        'allowFileAccess'
    )) {
        $value = Get-PropertyValue -InputObject $snapshot -Name $name
        if ($null -ne $value) { $result[$name] = $value }
    }
}
catch {
    $result.state = 'unavailable'
}

$evidence = Get-Content -LiteralPath $EvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
$evidence.chrome | Add-Member -NotePropertyName startupPreferences -NotePropertyValue ([pscustomobject]$result) -Force
$evidence | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8

Write-Host ('Chrome startup preference evidence: state={0}; lastUsed={1}; developerMode={2}; registered={3}; creationFlags={4}; installedViaCdp={5}; fileAccess={6}' -f $result.state, $result.lastUsedProfile, $result.developerMode, $result.registrationPresent, $result.effectiveCreationFlags, $result.installedViaCdp, $result.allowFileAccess)
