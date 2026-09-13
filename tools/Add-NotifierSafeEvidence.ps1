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
        'source','status','observedAt','extensionVersion','correlationId','tabId','attempt','frozen','discarded',
        'presented','presentationState','conversationSuffix','notificationSuffix','chromeDocumentSuffix',
        'statusRuntimeSuffix','monitorRuntimeSuffix'
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
    loadedExtensionVersion = $null
    extensionRuntimeSuffix = $null
    diagnostics = @()
}

try {
    $raw = Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 -ErrorAction Stop
    $runtime = $raw | ConvertFrom-Json -ErrorAction Stop
    $result.state = 'read'
    foreach ($name in @(
        'schemaVersion','observedAtUtc','installedVersion','sourceCommit','installedManifestVersion','helperProcessId',
        'helperSessionId','transport','loadedExtensionVersion','extensionRuntimeSuffix'
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

$evidence = Get-Content -LiteralPath $EvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
$evidence | Add-Member -NotePropertyName safeRuntimeEvidence -NotePropertyValue ([pscustomobject]$result) -Force
if ($result.state -eq 'read' -and -not [string]::IsNullOrWhiteSpace([string]$result.loadedExtensionVersion)) {
    $evidence.chrome.loadedExtensionRuntimeIdentitySupported = $true
    $evidence.chrome | Add-Member -NotePropertyName loadedRuntimeIdentitySource -NotePropertyValue 'notifier-sanitized-self-report' -Force
}
$evidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8

Write-Host ('Notifier safe evidence: state={0}; installed={1}; source={2}; loadedExtension={3}; diagnostics={4}' -f `
    $result.state,
    $result.installedVersion,
    $result.sourceCommit,
    $result.loadedExtensionVersion,
    @($result.diagnostics).Count)
