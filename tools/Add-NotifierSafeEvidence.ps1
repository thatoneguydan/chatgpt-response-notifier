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

function Copy-SafeDiagnostic {
    param([object]$Record)
    if ($null -eq $Record) { return $null }
    $safe = [ordered]@{}
    foreach ($name in @(
        'source','status','observedAt','extensionVersion','correlationId','tabId','statusCode','attempt','elapsedMs','queuedMessages',
        'frozen','discarded','deliveredNow','presented','triggerPath','reason','captureSource','presentationState',
        'conversationSuffix','notificationSuffix','chromeDocumentSuffix','statusRuntimeSuffix','monitorRuntimeSuffix'
    )) {
        $value = Get-PropertyValue -InputObject $Record -Name $name
        if ($null -ne $value) { $safe[$name] = $value }
    }
    return [pscustomobject]$safe
}

$runtimePath = Join-Path $ExpectedProfileRoot 'AppData\Local\ChatGPTResponseNotifier\Evidence\runtime-evidence.json'
$result = [ordered]@{
    state = 'missing'
    schemaVersion = $null
    observedAtUtc = $null
    installedVersion = $null
    sourceCommit = $null
    installedManifestVersion = $null
    helperProcessId = $null
    helperSessionId = $null
    transport = $null
    observationCapability = $null
    livenessWindowSeconds = $null
    bridgeClientCount = $null
    bridgeConnected = $null
    bridgeLastSeenAtUtc = $null
    currentExtensionVersion = $null
    currentExtensionRuntimeSuffix = $null
    currentExtensionObservedAtUtc = $null
    extensionConnectionLive = $false
    historicalExtensionVersion = $null
    historicalExtensionRuntimeSuffix = $null
    historicalExtensionObservedAtUtc = $null
    loadedExtensionVersion = $null
    extensionRuntimeSuffix = $null
    diagnostics = @()
}

try {
    $raw = Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 -ErrorAction Stop
    $runtime = $raw | ConvertFrom-Json -ErrorAction Stop
    $result.state = 'read'
    foreach ($name in @(
        'schemaVersion','observedAtUtc','installedVersion','sourceCommit','installedManifestVersion','helperProcessId','helperSessionId','transport',
        'observationCapability','livenessWindowSeconds','bridgeClientCount','bridgeConnected','bridgeLastSeenAtUtc',
        'currentExtensionVersion','currentExtensionRuntimeSuffix','currentExtensionObservedAtUtc','extensionConnectionLive',
        'historicalExtensionVersion','historicalExtensionRuntimeSuffix','historicalExtensionObservedAtUtc',
        'loadedExtensionVersion','extensionRuntimeSuffix'
    )) {
        $value = Get-PropertyValue -InputObject $runtime -Name $name
        if ($null -ne $value) { $result[$name] = $value }
    }
    $safeDiagnostics = @()
    foreach ($record in @(Get-PropertyValue -InputObject $runtime -Name 'diagnostics') | Select-Object -Last 200) {
        $safe = Copy-SafeDiagnostic -Record $record
        if ($null -ne $safe) { $safeDiagnostics += $safe }
    }
    $result.diagnostics = $safeDiagnostics
}
catch [System.Management.Automation.ItemNotFoundException] {
    $result.state = 'missing'
}
catch {
    $result.state = 'unavailable'
    $result.errorType = $_.Exception.GetType().Name
    $result.errorCode = $_.Exception.HResult
}

$runtimeFresh = $false
try {
    if ($result.state -eq 'read' `
        -and [int]$result.schemaVersion -ge 2 `
        -and [string]$result.observationCapability -eq 'extension-bridge-runtime-self-report-v2' `
        -and $result.bridgeConnected -eq $true `
        -and $result.extensionConnectionLive -eq $true `
        -and -not [string]::IsNullOrWhiteSpace([string]$result.currentExtensionVersion) `
        -and -not [string]::IsNullOrWhiteSpace([string]$result.currentExtensionObservedAtUtc)) {
        $observed = [DateTimeOffset]::Parse([string]$result.currentExtensionObservedAtUtc)
        $ageSeconds = ([DateTimeOffset]::UtcNow - $observed).TotalSeconds
        $runtimeFresh = $ageSeconds -ge -5 -and $ageSeconds -le 90
    }
}
catch {
    $runtimeFresh = $false
}

$identitySource = 'not-live-or-not-fresh'
if ($runtimeFresh) { $identitySource = 'notifier-live-bridge-self-report-v2' }

$evidence = Get-Content -LiteralPath $EvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
$evidence | Add-Member -NotePropertyName safeRuntimeEvidence -NotePropertyValue ([pscustomobject]$result) -Force
$evidence.chrome.loadedExtensionRuntimeIdentitySupported = $runtimeFresh
$evidence.chrome | Add-Member -NotePropertyName loadedRuntimeIdentitySource -NotePropertyValue $identitySource -Force
$evidence.chrome | Add-Member -NotePropertyName historicalExtensionVersion -NotePropertyValue $result.historicalExtensionVersion -Force
$evidence.chrome | Add-Member -NotePropertyName currentExtensionVersion -NotePropertyValue $result.currentExtensionVersion -Force
$evidence.chrome | Add-Member -NotePropertyName extensionConnectionLive -NotePropertyValue $runtimeFresh -Force
$evidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8

Write-Host ('Notifier safe evidence: state={0}; installed={1}; source={2}; currentExtension={3}; historicalExtension={4}; live={5}; diagnostics={6}' -f `
    $result.state,
    $result.installedVersion,
    $result.sourceCommit,
    $result.currentExtensionVersion,
    $result.historicalExtensionVersion,
    $runtimeFresh,
    @($result.diagnostics).Count)
