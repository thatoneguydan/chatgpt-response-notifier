param(
    [Parameter(Mandatory = $true)]
    [string]$EvidencePath,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedSourceCommit,
    [int]$MaxStopLagSeconds = 8,
    [int]$MaxDeliveryLagSeconds = 180
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$DefinitiveStatusCodes = @(
    'COMPLETE_APPLIED',
    'COMPLETE_NO_CHANGES',
    'BLOCKED_HUMAN',
    'PLANNING_ACTIVE'
)

function Get-PropertyValue {
    param([object]$InputObject, [string]$Name)
    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Convert-ToDateTimeOffset {
    param([object]$Value)
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
    try { return [DateTimeOffset]::Parse([string]$Value) }
    catch { return $null }
}

function Get-Suffix {
    param([string]$Value, [int]$Length = 12)
    $text = ([string]$Value).Trim()
    if ($text.Length -le $Length) { return $text }
    return $text.Substring($text.Length - $Length)
}

function Test-ExactText {
    param([object]$Actual, [string]$Expected)
    return [string]::Equals([string]$Actual, $Expected, [StringComparison]::Ordinal)
}

function Test-SameOptionalIdentity {
    param([object]$Left, [object]$Right, [string]$Name)
    $leftValue = [string](Get-PropertyValue -InputObject $Left -Name $Name)
    $rightValue = [string](Get-PropertyValue -InputObject $Right -Name $Name)
    if ([string]::IsNullOrWhiteSpace($leftValue) -or [string]::IsNullOrWhiteSpace($rightValue)) { return $false }
    return [string]::Equals($leftValue, $rightValue, [StringComparison]::Ordinal)
}

function Test-WithinWindow {
    param(
        [object]$Candidate,
        [DateTimeOffset]$Start,
        [DateTimeOffset]$End
    )
    $observed = Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $Candidate -Name 'observedAt')
    if ($null -eq $observed) { return $false }
    return $observed -ge $Start -and $observed -le $End
}

if (-not (Test-Path -LiteralPath $EvidencePath -PathType Leaf)) {
    throw "Live acceptance evidence file does not exist: $EvidencePath"
}

$evidence = Get-Content -LiteralPath $EvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
$safe = Get-PropertyValue -InputObject $evidence -Name 'safeRuntimeEvidence'
if ($null -eq $safe -or -not (Test-ExactText (Get-PropertyValue -InputObject $safe -Name 'state') 'read')) {
    throw 'Live acceptance failed: bounded installed-profile runtime evidence is unavailable.'
}

$installedVersion = [string](Get-PropertyValue -InputObject $safe -Name 'installedVersion')
$currentExtensionVersion = [string](Get-PropertyValue -InputObject $safe -Name 'currentExtensionVersion')
$installedSourceCommit = [string](Get-PropertyValue -InputObject $safe -Name 'sourceCommit')
if (-not (Test-ExactText $installedVersion $ExpectedVersion)) {
    throw "Live acceptance failed: installed notifier is $installedVersion; exact candidate $ExpectedVersion is required."
}
if (-not (Test-ExactText $currentExtensionVersion $ExpectedVersion)) {
    throw "Live acceptance failed: live extension is $currentExtensionVersion; exact candidate $ExpectedVersion is required."
}
if (-not [string]::Equals($installedSourceCommit, $ExpectedSourceCommit, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Live acceptance failed: installed source commit does not match exact candidate head $ExpectedSourceCommit."
}

$chrome = Get-PropertyValue -InputObject $evidence -Name 'chrome'
if ($null -eq $chrome -or (Get-PropertyValue -InputObject $chrome -Name 'extensionConnectionLive') -ne $true) {
    throw 'Live acceptance failed: exact installed extension is not currently live on the normal Chrome bridge.'
}

$currentObserved = Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $safe -Name 'currentExtensionObservedAtUtc')
if ($null -eq $currentObserved -or ([DateTimeOffset]::UtcNow - $currentObserved.ToUniversalTime()).TotalSeconds -gt 120) {
    throw 'Live acceptance failed: live extension identity is stale; interact with the normal Chrome profile and retry.'
}

$expectedCommitSuffix = Get-Suffix -Value $ExpectedSourceCommit -Length 12
$diagnostics = @((Get-PropertyValue -InputObject $safe -Name 'diagnostics'))
$deliveryDiagnostics = @((Get-PropertyValue -InputObject $safe -Name 'deliveryDiagnostics'))
$allRecords = @($diagnostics + $deliveryDiagnostics)
$usedNotificationSuffixes = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$accepted = @()

foreach ($statusCode in $DefinitiveStatusCodes) {
    $terminalCandidates = @(
        $diagnostics |
            Where-Object {
                Test-ExactText (Get-PropertyValue -InputObject $_ -Name 'source') 'terminal-live-proof' -and
                Test-ExactText (Get-PropertyValue -InputObject $_ -Name 'status') 'terminal-message-received' -and
                Test-ExactText (Get-PropertyValue -InputObject $_ -Name 'statusCode') $statusCode -and
                Test-ExactText (Get-PropertyValue -InputObject $_ -Name 'extensionVersion') $ExpectedVersion -and
                Test-ExactText (Get-PropertyValue -InputObject $_ -Name 'buildCommitSuffix') $expectedCommitSuffix -and
                $null -ne (Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $_ -Name 'observedAt'))
            } |
            Sort-Object { Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $_ -Name 'observedAt') } -Descending
    )
    if ($terminalCandidates.Count -eq 0) {
        throw "Live acceptance failed: no exact-candidate rendered terminal observation exists for $statusCode."
    }

    $acceptedForCode = $null
    foreach ($terminal in $terminalCandidates) {
        $terminalAt = Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $terminal -Name 'observedAt')
        if ($null -eq $terminalAt) { continue }
        $stopDeadline = $terminalAt.AddSeconds([Math]::Max(1, $MaxStopLagSeconds))
        $deliveryStart = $terminalAt.AddSeconds(-2)
        $deliveryEnd = $terminalAt.AddSeconds([Math]::Max(1, $MaxDeliveryLagSeconds))

        $stop = @(
            $diagnostics |
                Where-Object {
                    Test-ExactText (Get-PropertyValue -InputObject $_ -Name 'source') 'terminal-live-proof' -and
                    Test-ExactText (Get-PropertyValue -InputObject $_ -Name 'status') 'terminal-watchdog-stopped-observed' -and
                    Test-ExactText (Get-PropertyValue -InputObject $_ -Name 'statusCode') $statusCode -and
                    Test-ExactText (Get-PropertyValue -InputObject $_ -Name 'extensionVersion') $ExpectedVersion -and
                    Test-ExactText (Get-PropertyValue -InputObject $_ -Name 'buildCommitSuffix') $expectedCommitSuffix -and
                    (Test-SameOptionalIdentity -Left $_ -Right $terminal -Name 'conversationSuffix') -and
                    (Test-SameOptionalIdentity -Left $_ -Right $terminal -Name 'assistantSuffix') -and
                    (Test-WithinWindow -Candidate $_ -Start $terminalAt -End $stopDeadline) -and
                    ([string](Get-PropertyValue -InputObject $_ -Name 'reason')) -match '(^|;)deadline=zero($|;)'
                } |
                Sort-Object { Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $_ -Name 'observedAt') } |
                Select-Object -First 1
        ) | Select-Object -First 1
        if ($null -eq $stop) { continue }

        $helperCandidates = @(
            $allRecords |
                Where-Object {
                    Test-ExactText (Get-PropertyValue -InputObject $_ -Name 'source') 'delivery-pipeline' -and
                    Test-ExactText (Get-PropertyValue -InputObject $_ -Name 'status') 'helper-durable-accepted' -and
                    Test-ExactText (Get-PropertyValue -InputObject $_ -Name 'extensionVersion') $ExpectedVersion -and
                    (Get-PropertyValue -InputObject $_ -Name 'presented') -eq $true -and
                    (Test-SameOptionalIdentity -Left $_ -Right $terminal -Name 'conversationSuffix') -and
                    -not [string]::IsNullOrWhiteSpace([string](Get-PropertyValue -InputObject $_ -Name 'notificationSuffix')) -and
                    (Test-WithinWindow -Candidate $_ -Start $deliveryStart -End $deliveryEnd)
                } |
                Sort-Object { Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $_ -Name 'observedAt') }
        )

        foreach ($helper in $helperCandidates) {
            $notificationSuffix = [string](Get-PropertyValue -InputObject $helper -Name 'notificationSuffix')
            if ($usedNotificationSuffixes.Contains($notificationSuffix)) { continue }
            $helperAt = Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $helper -Name 'observedAt')
            if ($null -eq $helperAt) { continue }
            $hostStart = $helperAt.AddSeconds(-10)
            $hostEnd = $helperAt.AddSeconds(2)
            $host = @(
                $allRecords |
                    Where-Object {
                        Test-ExactText (Get-PropertyValue -InputObject $_ -Name 'source') 'host' -and
                        Test-ExactText (Get-PropertyValue -InputObject $_ -Name 'status') 'toast-presented' -and
                        (Get-PropertyValue -InputObject $_ -Name 'presented') -eq $true -and
                        Test-ExactText (Get-PropertyValue -InputObject $_ -Name 'notificationSuffix') $notificationSuffix -and
                        (Test-SameOptionalIdentity -Left $_ -Right $terminal -Name 'conversationSuffix') -and
                        (Test-WithinWindow -Candidate $_ -Start $hostStart -End $hostEnd)
                    } |
                    Sort-Object { Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $_ -Name 'observedAt') } -Descending |
                    Select-Object -First 1
            ) | Select-Object -First 1
            if ($null -eq $host) { continue }

            [void]$usedNotificationSuffixes.Add($notificationSuffix)
            $acceptedForCode = [pscustomobject][ordered]@{
                statusCode = $statusCode
                conversationSuffix = [string](Get-PropertyValue -InputObject $terminal -Name 'conversationSuffix')
                assistantSuffix = [string](Get-PropertyValue -InputObject $terminal -Name 'assistantSuffix')
                notificationSuffix = $notificationSuffix
                terminalObservedAt = [string](Get-PropertyValue -InputObject $terminal -Name 'observedAt')
                watchdogStoppedAt = [string](Get-PropertyValue -InputObject $stop -Name 'observedAt')
                toastPresentedAt = [string](Get-PropertyValue -InputObject $host -Name 'observedAt')
                helperAcceptedAt = [string](Get-PropertyValue -InputObject $helper -Name 'observedAt')
                presentationState = [string](Get-PropertyValue -InputObject $helper -Name 'presentationState')
            }
            break
        }

        if ($null -ne $acceptedForCode) { break }
    }

    if ($null -eq $acceptedForCode) {
        throw "Live acceptance failed for $statusCode: terminal observation exists, but matching persisted watchdog stop + unique presented toast/helper acknowledgement evidence is incomplete."
    }
    $accepted += $acceptedForCode
}

if ($accepted.Count -ne $DefinitiveStatusCodes.Count) {
    throw "Live acceptance failed: expected $($DefinitiveStatusCodes.Count) definitive status proofs, found $($accepted.Count)."
}

Write-Host ("LIVE_TERMINAL_NOTIFICATION_ACCEPTANCE_PASS version={0}; source={1}; codes={2}; uniqueNotifications={3}" -f `
    $ExpectedVersion,
    $expectedCommitSuffix,
    ($DefinitiveStatusCodes -join ','),
    $usedNotificationSuffixes.Count)
$accepted | ConvertTo-Json -Depth 5 -Compress | Write-Host
