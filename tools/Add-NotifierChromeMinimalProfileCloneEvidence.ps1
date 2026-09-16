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
    capability = 'chrome-minimal-profile-clone-readonly-source-v1'
    observedAtUtc = $null
    state = 'unavailable'
    lastUsedProfile = $null
    chromeVersion = $null
    sourceProfileMutated = $null
    copiedFiles = $null
    copiedBrowsingDatabases = $null
    chatGptNavigationPerformed = $null
    cloneRegistrationPresentBefore = $null
    cloneNotifierAuthenticatorPresentBefore = $null
    rawUnpackedRegistrationCountBefore = $null
    extensionsQuerySucceeded = $null
    loadedUnpackedExtensionCountBefore = $null
    notifierListedBeforeRepair = $null
    notifierEnabledBeforeRepair = $null
    notifierVersionBeforeRepair = $null
    repairLoadAttempted = $null
    repairLoadSucceeded = $null
    notifierListedAfterRepair = $null
    notifierEnabledAfterRepair = $null
    notifierVersionAfterRepair = $null
    cloneRegistrationPresentAfter = $null
    cloneNotifierAuthenticatorPresentAfter = $null
    rawUnpackedRegistrationCountAfter = $null
    recordKeysAddedByRepair = @()
    recordKeysRemovedByRepair = @()
    errorClass = $null
    temporaryCloneDeleted = $null
}

$snapshotPath = Join-Path $ExpectedProfileRoot 'AppData\Local\ChatGPTResponseNotifier\Evidence\chrome-minimal-profile-clone-evidence.json'
try {
    $raw = Get-Content -LiteralPath $snapshotPath -Raw -Encoding UTF8 -ErrorAction Stop
    $snapshot = $raw | ConvertFrom-Json -ErrorAction Stop
    if ([int](Get-PropertyValue -InputObject $snapshot -Name 'schemaVersion') -ne 1) { throw 'Unexpected minimal profile clone evidence schema.' }
    if ([string](Get-PropertyValue -InputObject $snapshot -Name 'capability') -cne 'chrome-minimal-profile-clone-readonly-source-v1') { throw 'Unexpected minimal profile clone evidence capability.' }

    $observedText = [string](Get-PropertyValue -InputObject $snapshot -Name 'observedAtUtc')
    $observed = [DateTimeOffset]::Parse($observedText)
    $age = ([DateTimeOffset]::UtcNow - $observed).TotalSeconds
    if ($age -lt -5 -or $age -gt 600) { throw 'Minimal profile clone helper snapshot is stale.' }

    $result.observedAtUtc = $observed.ToString('o')
    foreach ($name in @(
        'state','lastUsedProfile','chromeVersion','sourceProfileMutated','copiedFiles','copiedBrowsingDatabases',
        'chatGptNavigationPerformed','cloneRegistrationPresentBefore','cloneNotifierAuthenticatorPresentBefore',
        'rawUnpackedRegistrationCountBefore','extensionsQuerySucceeded','loadedUnpackedExtensionCountBefore',
        'notifierListedBeforeRepair','notifierEnabledBeforeRepair','notifierVersionBeforeRepair','repairLoadAttempted',
        'repairLoadSucceeded','notifierListedAfterRepair','notifierEnabledAfterRepair','notifierVersionAfterRepair',
        'cloneRegistrationPresentAfter','cloneNotifierAuthenticatorPresentAfter','rawUnpackedRegistrationCountAfter',
        'errorClass','temporaryCloneDeleted'
    )) {
        $value = Get-PropertyValue -InputObject $snapshot -Name $name
        if ($null -ne $value) { $result[$name] = $value }
    }

    foreach ($arrayName in @('recordKeysAddedByRepair','recordKeysRemovedByRepair')) {
        $values = @(Get-PropertyValue -InputObject $snapshot -Name $arrayName)
        $safe = @($values | Where-Object { $_ -is [string] -and $_ -cmatch '^[A-Za-z0-9_-]{1,96}$' } | Select-Object -First 96)
        $result[$arrayName] = $safe
    }
}
catch {
    $result.state = 'unavailable'
}

$evidence = Get-Content -LiteralPath $EvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
$evidence.chrome | Add-Member -NotePropertyName minimalProfileClone -NotePropertyValue ([pscustomobject]$result) -Force
$evidence | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8

Write-Host ('Minimal Chrome clone: state={0}; chrome={1}; registeredBefore={2}; loadedBefore={3}; enabledBefore={4}; repairAttempted={5}; repairSucceeded={6}; loadedAfter={7}; registeredAfter={8}; tempDeleted={9}' -f `
    $result.state,
    $result.chromeVersion,
    $result.cloneRegistrationPresentBefore,
    $result.notifierListedBeforeRepair,
    $result.notifierEnabledBeforeRepair,
    $result.repairLoadAttempted,
    $result.repairLoadSucceeded,
    $result.notifierListedAfterRepair,
    $result.cloneRegistrationPresentAfter,
    $result.temporaryCloneDeleted)
