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
    capability = 'chrome-interactive-launch-policy-readonly-helper-v1'
    observedAtUtc = $null
    state = 'unavailable'
    chromeProcesses = [ordered]@{
        state = 'unavailable'
        totalCount = 0
        commandLinesReadable = 0
        browserProcessCount = 0
        browserCommandLinesReadable = 0
        anyBrowserDisableExtensions = $null
        anyBrowserDisableExtensionsExcept = $null
        anyBrowserLoadExtension = $null
        anyBrowserUserDataDirOverride = $null
        anyBrowserProfileDirectoryOverride = $null
        observedVersions = @()
    }
    currentUserPolicy = [ordered]@{
        state = 'unavailable'
        chromePolicyKeyPresent = $null
        extensionInstallBlocklistHasSpecific = $null
        extensionInstallBlocklistHasWildcard = $null
        extensionInstallAllowlistHasSpecific = $null
        extensionSettingsPresent = $null
        extensionSettingsSpecificPresent = $null
        extensionSettingsSpecificInstallationMode = $null
        extensionSettingsWildcardPresent = $null
        extensionSettingsWildcardInstallationMode = $null
        extensionDeveloperModeSettings = $null
    }
}

$snapshotPath = Join-Path $ExpectedProfileRoot 'AppData\Local\ChatGPTResponseNotifier\Evidence\chrome-interactive-launch-policy-evidence.json'
try {
    $raw = Get-Content -LiteralPath $snapshotPath -Raw -Encoding UTF8 -ErrorAction Stop
    $snapshot = $raw | ConvertFrom-Json -ErrorAction Stop
    if ([int](Get-PropertyValue -InputObject $snapshot -Name 'schemaVersion') -ne 1) { throw 'Unexpected interactive launch/policy evidence schema.' }
    if ([string](Get-PropertyValue -InputObject $snapshot -Name 'capability') -cne 'chrome-interactive-launch-policy-readonly-helper-v1') { throw 'Unexpected interactive launch/policy evidence capability.' }

    $observedText = [string](Get-PropertyValue -InputObject $snapshot -Name 'observedAtUtc')
    $observed = [DateTimeOffset]::Parse($observedText)
    $age = ([DateTimeOffset]::UtcNow - $observed).TotalSeconds
    if ($age -lt -5 -or $age -gt 180) { throw 'Interactive launch/policy helper snapshot is stale.' }

    $result.observedAtUtc = $observed.ToString('o')
    $result.state = 'read'

    $process = Get-PropertyValue -InputObject $snapshot -Name 'chromeProcesses'
    foreach ($name in @(
        'state','totalCount','commandLinesReadable','browserProcessCount','browserCommandLinesReadable',
        'anyBrowserDisableExtensions','anyBrowserDisableExtensionsExcept','anyBrowserLoadExtension',
        'anyBrowserUserDataDirOverride','anyBrowserProfileDirectoryOverride'
    )) {
        $value = Get-PropertyValue -InputObject $process -Name $name
        if ($null -ne $value) { $result.chromeProcesses[$name] = $value }
    }
    $result.chromeProcesses.observedVersions = @((Get-PropertyValue -InputObject $process -Name 'observedVersions') | Select-Object -First 4)

    $policy = Get-PropertyValue -InputObject $snapshot -Name 'currentUserPolicy'
    foreach ($name in @(
        'state','chromePolicyKeyPresent','extensionInstallBlocklistHasSpecific','extensionInstallBlocklistHasWildcard',
        'extensionInstallAllowlistHasSpecific','extensionSettingsPresent','extensionSettingsSpecificPresent',
        'extensionSettingsSpecificInstallationMode','extensionSettingsWildcardPresent','extensionSettingsWildcardInstallationMode',
        'extensionDeveloperModeSettings'
    )) {
        $value = Get-PropertyValue -InputObject $policy -Name $name
        if ($null -ne $value) { $result.currentUserPolicy[$name] = $value }
    }
}
catch {
    $result.state = 'unavailable'
}

$evidence = Get-Content -LiteralPath $EvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
$evidence.chrome | Add-Member -NotePropertyName interactiveLaunchPolicy -NotePropertyValue ([pscustomobject]$result) -Force
$evidence | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8

Write-Host ('Chrome interactive launch/policy evidence: state={0}; processState={1}; browserProcesses={2}; readable={3}; disableExtensions={4}; disableExtensionsExcept={5}; userDataDirOverride={6}; userPolicyState={7}; userPolicyKey={8}' -f `
    $result.state,
    $result.chromeProcesses.state,
    $result.chromeProcesses.browserProcessCount,
    $result.chromeProcesses.browserCommandLinesReadable,
    $result.chromeProcesses.anyBrowserDisableExtensions,
    $result.chromeProcesses.anyBrowserDisableExtensionsExcept,
    $result.chromeProcesses.anyBrowserUserDataDirOverride,
    $result.currentUserPolicy.state,
    $result.currentUserPolicy.chromePolicyKeyPresent)
