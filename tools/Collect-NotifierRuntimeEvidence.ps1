param(
    [string]$OutputPath = (Join-Path $PWD 'notifier-runtime-evidence.json'),
    [string]$ExpectedProfileRoot = 'C:\Users\dan',
    [int]$DiagnosticTail = 200
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function New-ReadResult {
    param(
        [string]$State,
        [object]$Value = $null,
        [System.Exception]$Error = $null
    )

    $result = [ordered]@{ state = $State }
    if ($null -ne $Value) { $result.value = $Value }
    if ($null -ne $Error) {
        $result.errorType = $Error.GetType().Name
        $result.errorCode = $Error.HResult
    }
    return [pscustomobject]$result
}

function Read-JsonFile {
    param([string]$Path)

    try {
        $item = Get-Item -LiteralPath $Path -ErrorAction Stop
        if ($item.PSIsContainer) { return New-ReadResult -State 'not-file' }
        $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction Stop
        return New-ReadResult -State 'read' -Value ($raw | ConvertFrom-Json -ErrorAction Stop)
    }
    catch [System.Management.Automation.ItemNotFoundException] {
        return New-ReadResult -State 'missing'
    }
    catch {
        return New-ReadResult -State 'unavailable' -Error $_.Exception
    }
}

function Get-PropertyValue {
    param([object]$InputObject, [string]$Name)
    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Test-PathWithinRoot {
    param([string]$Candidate, [string]$Root)
    if ([string]::IsNullOrWhiteSpace($Candidate) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
    try {
        $candidateFull = [IO.Path]::GetFullPath($Candidate)
        $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
        return $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
}

function Get-HostVersionFromPath {
    param([string]$Candidate, [string]$HostRoot)
    if (-not (Test-PathWithinRoot -Candidate $Candidate -Root $HostRoot)) { return $null }
    try {
        $hostRootFull = [IO.Path]::GetFullPath($HostRoot).TrimEnd('\') + '\'
        $relative = [IO.Path]::GetFullPath($Candidate).Substring($hostRootFull.Length)
        $first = ($relative -split '[\\/]')[0]
        if ($first -match '^\d+\.\d+(?:\.\d+){0,2}$') { return $first }
    }
    catch {}
    return $null
}

function Copy-SafeTerminalState {
    param([object]$TerminalState)
    if ($null -eq $TerminalState) { return $null }

    $safeAncestry = @()
    $ancestry = Get-PropertyValue -InputObject $TerminalState -Name 'ancestry'
    if ($null -ne $ancestry) {
        foreach ($node in @($ancestry) | Select-Object -First 12) {
            $safeNode = [ordered]@{}
            foreach ($name in @('idSuffix','parentSuffix','role','recipient','channel','endTurn','status','hidden','hasText','contentType')) {
                $value = Get-PropertyValue -InputObject $node -Name $name
                if ($null -ne $value) { $safeNode[$name] = $value }
            }
            $safeAncestry += [pscustomobject]$safeNode
        }
    }

    return [pscustomobject][ordered]@{
        messageCount = Get-PropertyValue -InputObject $TerminalState -Name 'messageCount'
        currentNodeSuffix = Get-PropertyValue -InputObject $TerminalState -Name 'currentNodeSuffix'
        currentNodePresent = Get-PropertyValue -InputObject $TerminalState -Name 'currentNodePresent'
        ancestry = $safeAncestry
    }
}

function Copy-SafeDiagnostic {
    param([object]$Envelope)
    $diagnostic = Get-PropertyValue -InputObject $Envelope -Name 'diagnostic'
    if ($null -eq $diagnostic) { return $null }

    $safe = [ordered]@{
        receivedAt = Get-PropertyValue -InputObject $Envelope -Name 'receivedAt'
    }
    foreach ($name in @(
        'source','status','observedAt','extensionVersion','correlationId','tabId','statusCode','attempt','elapsedMs',
        'queuedMessages','watchCount','requestContextCount','frozen','discarded','deliveredNow','presented','triggerPath',
        'reason','captureSource','presentationState','error','conversationSuffix','notificationSuffix','chromeDocumentSuffix',
        'statusRuntimeSuffix','monitorRuntimeSuffix'
    )) {
        $value = Get-PropertyValue -InputObject $diagnostic -Name $name
        if ($null -ne $value) { $safe[$name] = $value }
    }

    $terminal = Copy-SafeTerminalState -TerminalState (Get-PropertyValue -InputObject $diagnostic -Name 'terminalState')
    if ($null -ne $terminal) { $safe.terminalState = $terminal }
    return [pscustomobject]$safe
}

$diagnosticTailBound = [Math]::Max(1, [Math]::Min(400, $DiagnosticTail))
$installRoot = Join-Path $ExpectedProfileRoot 'AppData\Local\ChatGPTResponseNotifier'
$dataRoot = Join-Path $installRoot 'Data'
$hostRoot = Join-Path $installRoot 'Host'
$extensionRoot = Join-Path $installRoot 'Extension'
$installStatePath = Join-Path $dataRoot 'install-state.json'
$manifestPath = Join-Path $extensionRoot 'manifest.json'
$diagnosticsPath = Join-Path $dataRoot 'diagnostics.jsonl'

$installStateRead = Read-JsonFile -Path $installStatePath
$installState = [ordered]@{ state = $installStateRead.state }
if ($installStateRead.state -eq 'read') {
    $state = $installStateRead.value
    $hostPath = [string](Get-PropertyValue -InputObject $state -Name 'hostExecutablePath')
    $extensionPath = [string](Get-PropertyValue -InputObject $state -Name 'extensionPath')
    $installState.schemaVersion = Get-PropertyValue -InputObject $state -Name 'schemaVersion'
    $installState.version = Get-PropertyValue -InputObject $state -Name 'version'
    $installState.sourceCommit = Get-PropertyValue -InputObject $state -Name 'sourceCommit'
    $installState.installedAtUtc = Get-PropertyValue -InputObject $state -Name 'installedAtUtc'
    $installState.transport = Get-PropertyValue -InputObject $state -Name 'transport'
    $installState.hostPathMatchesExpectedRoot = Test-PathWithinRoot -Candidate $hostPath -Root $hostRoot
    $installState.extensionPathMatchesExpectedRoot = Test-PathWithinRoot -Candidate $extensionPath -Root $extensionRoot
}
elseif ($null -ne (Get-PropertyValue -InputObject $installStateRead -Name 'errorType')) {
    $installState.errorType = $installStateRead.errorType
    $installState.errorCode = $installStateRead.errorCode
}

$manifestRead = Read-JsonFile -Path $manifestPath
$installedManifest = [ordered]@{ state = $manifestRead.state }
if ($manifestRead.state -eq 'read') {
    $installedManifest.manifestVersion = Get-PropertyValue -InputObject $manifestRead.value -Name 'manifest_version'
    $installedManifest.version = Get-PropertyValue -InputObject $manifestRead.value -Name 'version'
    $installedManifest.nameMatches = ([string](Get-PropertyValue -InputObject $manifestRead.value -Name 'name') -eq 'ChatGPT Response Notifier')
}
elseif ($null -ne (Get-PropertyValue -InputObject $manifestRead -Name 'errorType')) {
    $installedManifest.errorType = $manifestRead.errorType
    $installedManifest.errorCode = $manifestRead.errorCode
}

$helperProcesses = @()
$helperProcessReadState = 'read'
$helperProcessError = $null
try {
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPTResponseNotifier.Host.exe'" -ErrorAction Stop)
    foreach ($process in $processes) {
        $executablePath = [string]$process.ExecutablePath
        $ownerMatchesExpectedInteractiveUser = $null
        try {
            $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwner -ErrorAction Stop
            if ($owner.ReturnValue -eq 0) { $ownerMatchesExpectedInteractiveUser = ([string]$owner.User -ieq 'dan') }
        }
        catch {}

        $helperProcesses += [pscustomobject][ordered]@{
            processId = [int]$process.ProcessId
            sessionId = [int]$process.SessionId
            executablePathAvailable = -not [string]::IsNullOrWhiteSpace($executablePath)
            executablePathMatchesExpectedRoot = Test-PathWithinRoot -Candidate $executablePath -Root $hostRoot
            versionFromExecutablePath = Get-HostVersionFromPath -Candidate $executablePath -HostRoot $hostRoot
            ownerMatchesExpectedInteractiveUser = $ownerMatchesExpectedInteractiveUser
        }
    }
}
catch {
    $helperProcessReadState = 'unavailable'
    $helperProcessError = $_.Exception
}

$listener = [ordered]@{ state = 'read'; port = 38473; listening = $false; owningProcessIds = @() }
try {
    $connections = @(Get-NetTCPConnection -LocalPort 38473 -State Listen -ErrorAction Stop)
    $listener.listening = $connections.Count -gt 0
    $listener.owningProcessIds = @($connections | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
}
catch {
    $listener.state = 'unavailable'
    $listener.errorType = $_.Exception.GetType().Name
    $listener.errorCode = $_.Exception.HResult
}

$safeDiagnostics = @()
$diagnostics = [ordered]@{ state = 'missing'; requestedTail = $diagnosticTailBound; acceptedRecords = 0; malformedOrRejectedRecords = 0; records = @() }
try {
    $item = Get-Item -LiteralPath $diagnosticsPath -ErrorAction Stop
    if ($item.PSIsContainer) { throw [IO.InvalidDataException]::new('Diagnostics path is not a file.') }
    $diagnostics.state = 'read'
    foreach ($line in @(Get-Content -LiteralPath $diagnosticsPath -Encoding UTF8 -Tail $diagnosticTailBound -ErrorAction Stop)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try {
            $envelope = $line | ConvertFrom-Json -ErrorAction Stop
            $safe = Copy-SafeDiagnostic -Envelope $envelope
            if ($null -ne $safe) { $safeDiagnostics += $safe }
            else { $diagnostics.malformedOrRejectedRecords++ }
        }
        catch { $diagnostics.malformedOrRejectedRecords++ }
    }
    $diagnostics.acceptedRecords = $safeDiagnostics.Count
    $diagnostics.records = $safeDiagnostics
}
catch [System.Management.Automation.ItemNotFoundException] {
    $diagnostics.state = 'missing'
}
catch {
    $diagnostics.state = 'unavailable'
    $diagnostics.errorType = $_.Exception.GetType().Name
    $diagnostics.errorCode = $_.Exception.HResult
}

$chrome = [ordered]@{
    processObservationState = 'read'
    processCount = 0
    loadedExtensionRuntimeIdentitySupported = $false
    workerErrorCaptureSupported = $false
    capabilityReason = 'No reviewed out-of-process observer is installed. Default-profile Chrome remote debugging is intentionally not enabled or modified by this collector.'
}
try {
    $chrome.processCount = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction Stop).Count
}
catch {
    $chrome.processObservationState = 'unavailable'
    $chrome.processErrorType = $_.Exception.GetType().Name
    $chrome.processErrorCode = $_.Exception.HResult
}

$principalClass = 'other'
try {
    $identityName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    if ($identityName -ieq 'NT AUTHORITY\NETWORK SERVICE') { $principalClass = 'network-service' }
    elseif ($identityName -ieq 'NT AUTHORITY\SYSTEM') { $principalClass = 'system' }
    elseif ($identityName -match '\\dan$') { $principalClass = 'interactive-user' }
}
catch {}

$evidence = [ordered]@{
    schemaVersion = 1
    collector = 'chatgpt-response-notifier-readonly-runtime-evidence'
    observedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    sourceCommit = [string]$env:GITHUB_SHA
    readOnly = $true
    runner = [ordered]@{
        principalClass = $principalClass
        sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    }
    installState = [pscustomobject]$installState
    installedManifest = [pscustomobject]$installedManifest
    helper = [ordered]@{
        processObservationState = $helperProcessReadState
        processErrorType = $(if ($null -ne $helperProcessError) { $helperProcessError.GetType().Name } else { $null })
        processErrorCode = $(if ($null -ne $helperProcessError) { $helperProcessError.HResult } else { $null })
        processCount = $helperProcesses.Count
        processes = $helperProcesses
        loopbackListener = [pscustomobject]$listener
        bridgeProtocolReadAttempted = $false
        bridgeProtocolReason = 'The production bridge accepts the fixed extension Origin. This collector does not impersonate that browser boundary.'
    }
    diagnostics = [pscustomobject]$diagnostics
    chrome = [pscustomobject]$chrome
}

$outputDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($OutputPath))
if (-not [string]::IsNullOrWhiteSpace($outputDirectory)) { New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null }
$evidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $OutputPath -Encoding UTF8

Write-Host ('Notifier runtime evidence written. InstallState={0}; Manifest={1}; Helpers={2}; Listener={3}; Diagnostics={4}; ChromeRuntimeCapture={5}' -f $installState.state, $installedManifest.state, $helperProcesses.Count, $listener.listening, $diagnostics.state, $chrome.loadedExtensionRuntimeIdentitySupported)
