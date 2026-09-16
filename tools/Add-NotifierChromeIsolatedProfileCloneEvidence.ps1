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
    capability = 'chrome-isolated-profile-clone-readonly-source-v1'
    observedAtUtc = $null
    state = 'unavailable'
    lastUsedProfile = $null
    chromeVersion = $null
    sourceProfileMutated = $null
    copiedFiles = $null
    copiedBrowsingDatabases = $null
    chatGptNavigationPerformed = $null
    repairAttempted = $null
    isolatedProfileUsesScopedDirPrefix = $null
    cloneRegistrationPresentBefore = $null
    cloneLegacyAuthenticatorPresentBefore = $null
    cloneEncryptedAuthenticatorPresentBefore = $null
    rawUnpackedRegistrationCountBefore = $null
    notifierListedByChrome = $null
    notifierEnabledByChrome = $null
    notifierVersionByChrome = $null
    loadedExtensionCount = $null
    cloneRegistrationPresentAfterStartup = $null
    cloneLegacyAuthenticatorPresentAfterStartup = $null
    cloneEncryptedAuthenticatorPresentAfterStartup = $null
    rawUnpackedRegistrationCountAfterStartup = $null
    recordKeysAddedByStartup = @()
    recordKeysRemovedByStartup = @()
    realExternalValidatorReadableBefore = $null
    realExternalValidatorKeyPresentBefore = $null
    realExternalValidatorValueCountBefore = $null
    realExternalNotifierValuePresentBefore = $null
    realExternalValidatorReadableAfter = $null
    realExternalValidatorKeyPresentAfter = $null
    realExternalValidatorValueCountAfter = $null
    realExternalNotifierValuePresentAfter = $null
    realExternalValidatorChangedByProbe = $null
    isolatedExternalValidatorReadableAfter = $null
    isolatedExternalValidatorPresentAfter = $null
    errorCode = $null
    temporaryCloneDeleted = $null
}

$snapshotPath = Join-Path $ExpectedProfileRoot 'AppData\Local\ChatGPTResponseNotifier\Evidence\chrome-isolated-profile-clone-evidence.json'
try {
    $raw = Get-Content -LiteralPath $snapshotPath -Raw -Encoding UTF8 -ErrorAction Stop
    $snapshot = $raw | ConvertFrom-Json -ErrorAction Stop
    if ([int](Get-PropertyValue -InputObject $snapshot -Name 'schemaVersion') -ne 1) { throw 'Unexpected isolated clone evidence schema.' }
    if ([string](Get-PropertyValue -InputObject $snapshot -Name 'capability') -cne 'chrome-isolated-profile-clone-readonly-source-v1') { throw 'Unexpected isolated clone evidence capability.' }

    $observedText = [string](Get-PropertyValue -InputObject $snapshot -Name 'observedAtUtc')
    $observed = [DateTimeOffset]::Parse($observedText)
    $age = ([DateTimeOffset]::UtcNow - $observed).TotalSeconds
    if ($age -lt -5 -or $age -gt 600) { throw 'Isolated clone helper snapshot is stale.' }

    $result.observedAtUtc = $observed.ToString('o')
    foreach ($name in @(
        'state','lastUsedProfile','chromeVersion','sourceProfileMutated','copiedFiles','copiedBrowsingDatabases',
        'chatGptNavigationPerformed','repairAttempted','isolatedProfileUsesScopedDirPrefix',
        'cloneRegistrationPresentBefore','cloneLegacyAuthenticatorPresentBefore','cloneEncryptedAuthenticatorPresentBefore',
        'rawUnpackedRegistrationCountBefore','notifierListedByChrome','notifierEnabledByChrome','notifierVersionByChrome',
        'loadedExtensionCount','cloneRegistrationPresentAfterStartup','cloneLegacyAuthenticatorPresentAfterStartup',
        'cloneEncryptedAuthenticatorPresentAfterStartup','rawUnpackedRegistrationCountAfterStartup',
        'realExternalValidatorReadableBefore','realExternalValidatorKeyPresentBefore','realExternalValidatorValueCountBefore',
        'realExternalNotifierValuePresentBefore','realExternalValidatorReadableAfter','realExternalValidatorKeyPresentAfter',
        'realExternalValidatorValueCountAfter','realExternalNotifierValuePresentAfter','realExternalValidatorChangedByProbe',
        'isolatedExternalValidatorReadableAfter','isolatedExternalValidatorPresentAfter','errorCode','temporaryCloneDeleted'
    )) {
        $value = Get-PropertyValue -InputObject $snapshot -Name $name
        if ($null -ne $value) { $result[$name] = $value }
    }

    foreach ($arrayName in @('recordKeysAddedByStartup','recordKeysRemovedByStartup')) {
        $values = @(Get-PropertyValue -InputObject $snapshot -Name $arrayName)
        $safe = @($values | Where-Object { $_ -is [string] -and $_ -cmatch '^[A-Za-z0-9_-]{1,96}$' } | Select-Object -First 96)
        $result[$arrayName] = $safe
    }
}
catch {
    $result.state = 'unavailable'
}

$evidence = Get-Content -LiteralPath $EvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
$evidence.chrome | Add-Member -NotePropertyName isolatedProfileClone -NotePropertyValue ([pscustomobject]$result) -Force
$evidence | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8

Write-Host ('Isolated Chrome clone: state={0}; chrome={1}; registeredBefore={2}; listed={3}; registeredAfter={4}; realExternalChanged={5}; isolatedExternalPresentAfter={6}; tempDeleted={7}; error={8}' -f `
    $result.state,
    $result.chromeVersion,
    $result.cloneRegistrationPresentBefore,
    $result.notifierListedByChrome,
    $result.cloneRegistrationPresentAfterStartup,
    $result.realExternalValidatorChangedByProbe,
    $result.isolatedExternalValidatorPresentAfter,
    $result.temporaryCloneDeleted,
    $result.errorCode)
