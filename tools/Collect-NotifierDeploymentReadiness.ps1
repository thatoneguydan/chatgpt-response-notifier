#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$OutputPath = (Join-Path $env:RUNNER_TEMP 'notifier-deployment-readiness.json')
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Read-JsonIfPresent {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function IsoOrNull {
    param($Value)
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
    try { return ([DateTimeOffset]::Parse([string]$Value)).ToString('o') } catch { return $null }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$brokerStatusPath = 'C:\ProgramData\GlassUserSessionDeployBroker\Outbox\broker-runtime-status.json'
$cpuRoot = 'C:\Users\dan\AppData\Local\Glass\Diagnostics\CPU-Activity'
$cpuReceiptPath = Join-Path $cpuRoot 'install-latest.json'
$cpuStatusPath = Join-Path $cpuRoot 'live-status.json'

$broker = Read-JsonIfPresent -Path $brokerStatusPath
$receipt = Read-JsonIfPresent -Path $cpuReceiptPath
$cpuStatus = Read-JsonIfPresent -Path $cpuStatusPath

$brokerTimestamp = if ($broker) { IsoOrNull $broker.timestampUtc } else { $null }
$brokerAgeSeconds = $null
if ($brokerTimestamp) {
    try { $brokerAgeSeconds = [Math]::Round(([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($brokerTimestamp)).TotalSeconds, 1) } catch {}
}

$result = [ordered]@{
    schemaVersion = 1
    collectedAt = [DateTimeOffset]::UtcNow.ToString('o')
    runnerIdentity = $identity
    broker = [ordered]@{
        statusPresent = ($null -ne $broker)
        result = if ($broker) { [string]$broker.result } else { $null }
        brokerVersion = if ($broker -and $broker.PSObject.Properties['brokerVersion']) { $broker.brokerVersion } else { $null }
        sessionId = if ($broker -and $broker.PSObject.Properties['sessionId']) { $broker.sessionId } else { $null }
        timestampUtc = $brokerTimestamp
        ageSeconds = $brokerAgeSeconds
    }
    cpuMonitorBootstrap = [ordered]@{
        receiptPresent = ($null -ne $receipt)
        success = if ($receipt -and $receipt.PSObject.Properties['success']) { [bool]$receipt.success } else { $null }
        glassCommit = if ($receipt -and $receipt.PSObject.Properties['glassCommit']) { [string]$receipt.glassCommit } else { $null }
        infrastructureCommit = if ($receipt -and $receipt.PSObject.Properties['infrastructureCommit']) { [string]$receipt.infrastructureCommit } else { $null }
        elevated = if ($receipt -and $receipt.PSObject.Properties['elevated']) { [bool]$receipt.elevated } else { $null }
        brokerUpgraded = if ($receipt -and $receipt.PSObject.Properties['broker'] -and $receipt.broker.PSObject.Properties['upgraded']) { [bool]$receipt.broker.upgraded } else { $null }
        brokerHeartbeatExists = if ($receipt -and $receipt.PSObject.Properties['broker'] -and $receipt.broker.PSObject.Properties['heartbeatExists']) { [bool]$receipt.broker.heartbeatExists } else { $null }
        appInstalled = if ($receipt -and $receipt.PSObject.Properties['app'] -and $receipt.app.PSObject.Properties['installed']) { [bool]$receipt.app.installed } else { $null }
        shortcutInstalled = if ($receipt -and $receipt.PSObject.Properties['app'] -and $receipt.app.PSObject.Properties['shortcutInstalled']) { [bool]$receipt.app.shortcutInstalled } else { $null }
        limitedUserLaunchStarted = if ($receipt -and $receipt.PSObject.Properties['app'] -and $receipt.app.PSObject.Properties['limitedUserLaunchStarted']) { [bool]$receipt.app.limitedUserLaunchStarted } else { $null }
        smokePassed = if ($receipt -and $receipt.PSObject.Properties['smoke'] -and $receipt.smoke -and $receipt.smoke.PSObject.Properties['passed']) { [bool]$receipt.smoke.passed } else { $null }
        smokeDeferred = if ($receipt -and $receipt.PSObject.Properties['smoke'] -and $receipt.smoke -and $receipt.smoke.PSObject.Properties['deferred']) { [bool]$receipt.smoke.deferred } else { $null }
        limitedUserTask = if ($receipt -and $receipt.PSObject.Properties['smoke'] -and $receipt.smoke -and $receipt.smoke.PSObject.Properties['limitedUserTask']) { [bool]$receipt.smoke.limitedUserTask } else { $null }
        errorPresent = if ($receipt -and $receipt.PSObject.Properties['error']) { -not [string]::IsNullOrWhiteSpace([string]$receipt.error) } else { $null }
    }
    cpuMonitorRuntime = [ordered]@{
        statusPresent = ($null -ne $cpuStatus)
        state = if ($cpuStatus -and $cpuStatus.PSObject.Properties['state']) { [string]$cpuStatus.state } else { $null }
        updatedAt = if ($cpuStatus -and $cpuStatus.PSObject.Properties['updatedAt']) { IsoOrNull $cpuStatus.updatedAt } else { $null }
        lastCheckpointAt = if ($cpuStatus -and $cpuStatus.PSObject.Properties['lastCheckpointAt']) { IsoOrNull $cpuStatus.lastCheckpointAt } else { $null }
        sampleCount = if ($cpuStatus -and $cpuStatus.PSObject.Properties['sampleCount']) { $cpuStatus.sampleCount } else { $null }
        runnerJobActive = if ($cpuStatus -and $cpuStatus.PSObject.Properties['runnerJobActive']) { [bool]$cpuStatus.runnerJobActive } else { $null }
    }
}

$parent = Split-Path -Parent $OutputPath
if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
$result | ConvertTo-Json -Depth 8
