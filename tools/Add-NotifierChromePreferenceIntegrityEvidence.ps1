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
    capability = 'chrome-pref-integrity-readonly-helper-v1'
    observedAtUtc = $null
    state = 'unavailable'
    lastUsedProfile = $null
    registrationPresent = $null
    legacyHmacPresent = $null
    encryptedHashPresent = $null
    notifierAuthenticatorPresent = $null
    superMacPresent = $null
    superEncryptedHashPresent = $null
    legacyHmacEntryCount = $null
    encryptedHashEntryCount = $null
}

$snapshotPath = Join-Path $ExpectedProfileRoot 'AppData\Local\ChatGPTResponseNotifier\Evidence\chrome-pref-integrity-evidence.json'
try {
    $raw = Get-Content -LiteralPath $snapshotPath -Raw -Encoding UTF8 -ErrorAction Stop
    $snapshot = $raw | ConvertFrom-Json -ErrorAction Stop
    if ([int](Get-PropertyValue -InputObject $snapshot -Name 'schemaVersion') -ne 1) { throw 'Unexpected Chrome preference integrity evidence schema.' }
    if ([string](Get-PropertyValue -InputObject $snapshot -Name 'capability') -cne 'chrome-pref-integrity-readonly-helper-v1') { throw 'Unexpected Chrome preference integrity evidence capability.' }

    $observedText = [string](Get-PropertyValue -InputObject $snapshot -Name 'observedAtUtc')
    $observed = [DateTimeOffset]::Parse($observedText)
    $age = ([DateTimeOffset]::UtcNow - $observed).TotalSeconds
    if ($age -lt -5 -or $age -gt 240) { throw 'Chrome preference integrity helper snapshot is stale.' }

    $result.observedAtUtc = $observed.ToString('o')
    foreach ($name in @(
        'state',
        'lastUsedProfile',
        'registrationPresent',
        'legacyHmacPresent',
        'encryptedHashPresent',
        'notifierAuthenticatorPresent',
        'superMacPresent',
        'superEncryptedHashPresent',
        'legacyHmacEntryCount',
        'encryptedHashEntryCount'
    )) {
        $value = Get-PropertyValue -InputObject $snapshot -Name $name
        if ($null -ne $value) { $result[$name] = $value }
    }
}
catch {
    $result.state = 'unavailable'
}

$evidence = Get-Content -LiteralPath $EvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
$evidence.chrome | Add-Member -NotePropertyName preferenceIntegrity -NotePropertyValue ([pscustomobject]$result) -Force
$evidence | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8

Write-Host ('Chrome preference integrity evidence: state={0}; registered={1}; legacyHmac={2}; encryptedHash={3}; authenticator={4}; superMac={5}; superEncrypted={6}' -f $result.state, $result.registrationPresent, $result.legacyHmacPresent, $result.encryptedHashPresent, $result.notifierAuthenticatorPresent, $result.superMacPresent, $result.superEncryptedHashPresent)
