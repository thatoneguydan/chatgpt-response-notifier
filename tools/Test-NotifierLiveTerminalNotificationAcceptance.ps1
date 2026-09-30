param(
    [Parameter(Mandatory = $true)]
    [string]$EvidencePath,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedSourceCommit,
    [int]$MinimumLiveDefinitiveProofs = 1,
    [int]$MaxStopLagSeconds = 8,
    [int]$MaxDeliveryLagSeconds = 180,
    [int]$MaxDedupCarryForwardSeconds = 3600
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

function Test-BuildCommitIdentity {
    param([object]$Record, [string]$ExpectedSuffix)
    $field = [string](Get-PropertyValue -InputObject $Record -Name 'buildCommitSuffix')
    if (-not [string]::IsNullOrWhiteSpace($field) -and (Test-ExactText $field $ExpectedSuffix)) { return $true }
    $reason = [string](Get-PropertyValue -InputObject $Record -Name 'reason')
    if ([string]::IsNullOrWhiteSpace($reason)) { return $false }
    return $reason -match ('(^|;)build=' + [regex]::Escape($ExpectedSuffix) + '($|;)')
}

function Test-SameRequiredIdentity {
    param([object]$Left, [object]$Right, [string]$Name)
    $leftValue = [string](Get-PropertyValue -InputObject $Left -Name $Name)
    $rightValue = [string](Get-PropertyValue -InputObject $Right -Name $Name)
    if ([string]::IsNullOrWhiteSpace($leftValue) -or [string]::IsNullOrWhiteSpace($rightValue)) { return $false }
    return [string]::Equals($leftValue, $rightValue, [StringComparison]::Ordinal)
}

function Test-SameLogicalTurnIdentity {
    param([object]$Left, [object]$Right)
    foreach ($name in @('conversationSuffix', 'promptSuffix', 'assistantSuffix', 'revisionSuffix')) {
        if (-not (Test-SameRequiredIdentity -Left $Left -Right $Right -Name $name)) { return $false }
    }
    return $true
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

if ($MinimumLiveDefinitiveProofs -lt 1 -or $MinimumLiveDefinitiveProofs -gt $DefinitiveStatusCodes.Count) {
    throw "MinimumLiveDefinitiveProofs must be between 1 and $($DefinitiveStatusCodes.Count)."
}
if ($MaxDedupCarryForwardSeconds -lt 1 -or $MaxDedupCarryForwardSeconds -gt 86400) {
    throw 'MaxDedupCarryForwardSeconds must be between 1 and 86400.'
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
    throw "Live acceptance failed: installed source commit does not match exact candidate $ExpectedSourceCommit."
}

$chrome = Get-PropertyValue -InputObject $evidence -Name 'chrome'
if ($null -eq $chrome -or (Get-PropertyValue -InputObject $chrome -Name 'extensionConnectionLive') -ne $true) {
    throw 'Live acceptance failed: exact installed extension is not currently live on the normal Chrome bridge.'
}

$currentObserved = Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $safe -Name 'currentExtensionObservedAtUtc')
if ($null -eq $currentObserved) {
    throw 'Live acceptance failed: no fresh live extension identity timestamp is available.'
}
$identityAgeSeconds = ([DateTimeOffset]::UtcNow - $currentObserved.ToUniversalTime()).TotalSeconds
if ($identityAgeSeconds -lt -5 -or $identityAgeSeconds -gt 120) {
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
                ([string](Get-PropertyValue -InputObject $_ -Name 'source') -ceq 'terminal-live-proof') -and
                ([string](Get-PropertyValue -InputObject $_ -Name 'status') -ceq 'terminal-message-received') -and
                ([string](Get-PropertyValue -InputObject $_ -Name 'statusCode') -ceq $statusCode) -and
                ([string](Get-PropertyValue -InputObject $_ -Name 'extensionVersion') -ceq $ExpectedVersion) -and
                (Test-BuildCommitIdentity -Record $_ -ExpectedSuffix $expectedCommitSuffix) -and
                ($null -ne (Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $_ -Name 'observedAt')))
            } |
            Sort-Object { Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $_ -Name 'observedAt') } -Descending
    )
    if ($terminalCandidates.Count -eq 0) { continue }

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
                    ([string](Get-PropertyValue -InputObject $_ -Name 'source') -ceq 'terminal-live-proof') -and
                    ([string](Get-PropertyValue -InputObject $_ -Name 'status') -ceq 'terminal-watchdog-stopped-observed') -and
                    ([string](Get-PropertyValue -InputObject $_ -Name 'statusCode') -ceq $statusCode) -and
                    ([string](Get-PropertyValue -InputObject $_ -Name 'extensionVersion') -ceq $ExpectedVersion) -and
                    (Test-BuildCommitIdentity -Record $_ -ExpectedSuffix $expectedCommitSuffix) -and
                    (Test-SameRequiredIdentity -Left $_ -Right $terminal -Name 'conversationSuffix') -and
                    (Test-SameRequiredIdentity -Left $_ -Right $terminal -Name 'assistantSuffix') -and
                    (Test-WithinWindow -Candidate $_ -Start $terminalAt -End $stopDeadline) -and
                    (([string](Get-PropertyValue -InputObject $_ -Name 'reason')) -match '(^|;)deadline=zero($|;)')
                } |
                Sort-Object { Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $_ -Name 'observedAt') } |
                Select-Object -First 1
        ) | Select-Object -First 1
        if ($null -eq $stop) { continue }

        $helperCandidates = @(
            $allRecords |
                Where-Object {
                    ([string](Get-PropertyValue -InputObject $_ -Name 'source') -ceq 'delivery-pipeline') -and
                    ([string](Get-PropertyValue -InputObject $_ -Name 'status') -ceq 'helper-durable-accepted') -and
                    ([string](Get-PropertyValue -InputObject $_ -Name 'extensionVersion') -ceq $ExpectedVersion) -and
                    ((Get-PropertyValue -InputObject $_ -Name 'presented') -eq $true) -and
                    (Test-SameRequiredIdentity -Left $_ -Right $terminal -Name 'conversationSuffix') -and
                    (-not [string]::IsNullOrWhiteSpace([string](Get-PropertyValue -InputObject $_ -Name 'notificationSuffix'))) -and
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
            $hostRecord = @(
                $allRecords |
                    Where-Object {
                        ([string](Get-PropertyValue -InputObject $_ -Name 'source') -ceq 'host') -and
                        ([string](Get-PropertyValue -InputObject $_ -Name 'status') -ceq 'toast-presented') -and
                        ((Get-PropertyValue -InputObject $_ -Name 'presented') -eq $true) -and
                        ([string](Get-PropertyValue -InputObject $_ -Name 'notificationSuffix') -ceq $notificationSuffix) -and
                        (Test-SameRequiredIdentity -Left $_ -Right $terminal -Name 'conversationSuffix') -and
                        (Test-WithinWindow -Candidate $_ -Start $hostStart -End $hostEnd)
                    } |
                    Sort-Object { Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $_ -Name 'observedAt') } -Descending |
                    Select-Object -First 1
            ) | Select-Object -First 1
            if ($null -eq $hostRecord) { continue }

            [void]$usedNotificationSuffixes.Add($notificationSuffix)
            $acceptedForCode = [pscustomobject][ordered]@{
                statusCode = $statusCode
                conversationSuffix = [string](Get-PropertyValue -InputObject $terminal -Name 'conversationSuffix')
                assistantSuffix = [string](Get-PropertyValue -InputObject $terminal -Name 'assistantSuffix')
                notificationSuffix = $notificationSuffix
                deliveryProofMode = 'direct-window'
                terminalObservedAt = [string](Get-PropertyValue -InputObject $terminal -Name 'observedAt')
                watchdogStoppedAt = [string](Get-PropertyValue -InputObject $stop -Name 'observedAt')
                toastPresentedAt = [string](Get-PropertyValue -InputObject $hostRecord -Name 'observedAt')
                helperAcceptedAt = [string](Get-PropertyValue -InputObject $helper -Name 'observedAt')
                presentationState = [string](Get-PropertyValue -InputObject $helper -Name 'presentationState')
            }
            break
        }

        if ($null -eq $acceptedForCode) {
            $suppression = @(
                $allRecords |
                    Where-Object {
                        ([string](Get-PropertyValue -InputObject $_ -Name 'source') -ceq 'delivery-identity') -and
                        ([string](Get-PropertyValue -InputObject $_ -Name 'status') -ceq 'claim-suppressed') -and
                        ([string](Get-PropertyValue -InputObject $_ -Name 'reason') -ceq 'already-delivered-logical-turn') -and
                        ([string](Get-PropertyValue -InputObject $_ -Name 'extensionVersion') -ceq $ExpectedVersion) -and
                        (Test-SameLogicalTurnIdentity -Left $_ -Right $terminal) -and
                        (Test-SameRequiredIdentity -Left $_ -Right $terminal -Name 'tabId') -and
                        (Test-WithinWindow -Candidate $_ -Start $terminalAt -End $deliveryEnd)
                    } |
                    Sort-Object { Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $_ -Name 'observedAt') } |
                    Select-Object -First 1
            ) | Select-Object -First 1

            if ($null -ne $suppression) {
                $carryStart = $terminalAt.AddSeconds(-[Math]::Max(1, $MaxDedupCarryForwardSeconds))
                $priorClaims = @(
                    $allRecords |
                        Where-Object {
                            ([string](Get-PropertyValue -InputObject $_ -Name 'source') -ceq 'delivery-identity') -and
                            ([string](Get-PropertyValue -InputObject $_ -Name 'status') -ceq 'claim-accepted') -and
                            ([string](Get-PropertyValue -InputObject $_ -Name 'extensionVersion') -ceq $ExpectedVersion) -and
                            (Test-SameLogicalTurnIdentity -Left $_ -Right $terminal) -and
                            (Test-SameRequiredIdentity -Left $_ -Right $terminal -Name 'tabId') -and
                            (-not [string]::IsNullOrWhiteSpace([string](Get-PropertyValue -InputObject $_ -Name 'notificationSuffix'))) -and
                            (Test-WithinWindow -Candidate $_ -Start $carryStart -End $terminalAt)
                        } |
                        Sort-Object { Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $_ -Name 'observedAt') } -Descending
                )

                foreach ($claim in $priorClaims) {
                    $notificationSuffix = [string](Get-PropertyValue -InputObject $claim -Name 'notificationSuffix')
                    if ($usedNotificationSuffixes.Contains($notificationSuffix)) { continue }
                    $claimAt = Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $claim -Name 'observedAt')
                    if ($null -eq $claimAt) { continue }

                    $queueRecord = @(
                        $allRecords |
                            Where-Object {
                                ([string](Get-PropertyValue -InputObject $_ -Name 'source') -ceq 'delivery-pipeline') -and
                                ([string](Get-PropertyValue -InputObject $_ -Name 'status') -ceq 'rendered-terminal-notification-queued') -and
                                ([string](Get-PropertyValue -InputObject $_ -Name 'extensionVersion') -ceq $ExpectedVersion) -and
                                ([string](Get-PropertyValue -InputObject $_ -Name 'reason') -ceq 'rendered-terminal-authority') -and
                                ([string](Get-PropertyValue -InputObject $_ -Name 'notificationSuffix') -ceq $notificationSuffix) -and
                                (Test-SameRequiredIdentity -Left $_ -Right $terminal -Name 'conversationSuffix') -and
                                (Test-WithinWindow -Candidate $_ -Start $claimAt.AddSeconds(-2) -End $terminalAt)
                            } |
                            Sort-Object { Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $_ -Name 'observedAt') } |
                            Select-Object -First 1
                    ) | Select-Object -First 1
                    if ($null -eq $queueRecord) { continue }

                    $helper = @(
                        $allRecords |
                            Where-Object {
                                ([string](Get-PropertyValue -InputObject $_ -Name 'source') -ceq 'delivery-pipeline') -and
                                ([string](Get-PropertyValue -InputObject $_ -Name 'status') -ceq 'helper-durable-accepted') -and
                                ([string](Get-PropertyValue -InputObject $_ -Name 'extensionVersion') -ceq $ExpectedVersion) -and
                                ((Get-PropertyValue -InputObject $_ -Name 'presented') -eq $true) -and
                                ([string](Get-PropertyValue -InputObject $_ -Name 'notificationSuffix') -ceq $notificationSuffix) -and
                                (Test-SameRequiredIdentity -Left $_ -Right $terminal -Name 'conversationSuffix') -and
                                (Test-WithinWindow -Candidate $_ -Start $claimAt -End $terminalAt)
                            } |
                            Sort-Object { Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $_ -Name 'observedAt') } -Descending |
                            Select-Object -First 1
                    ) | Select-Object -First 1
                    if ($null -eq $helper) { continue }

                    $helperAt = Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $helper -Name 'observedAt')
                    if ($null -eq $helperAt) { continue }
                    $hostRecord = @(
                        $allRecords |
                            Where-Object {
                                ([string](Get-PropertyValue -InputObject $_ -Name 'source') -ceq 'host') -and
                                ([string](Get-PropertyValue -InputObject $_ -Name 'status') -ceq 'toast-presented') -and
                                ((Get-PropertyValue -InputObject $_ -Name 'presented') -eq $true) -and
                                ([string](Get-PropertyValue -InputObject $_ -Name 'notificationSuffix') -ceq $notificationSuffix) -and
                                (Test-SameRequiredIdentity -Left $_ -Right $terminal -Name 'conversationSuffix') -and
                                (Test-WithinWindow -Candidate $_ -Start $helperAt.AddSeconds(-10) -End $helperAt.AddSeconds(2))
                            } |
                            Sort-Object { Convert-ToDateTimeOffset (Get-PropertyValue -InputObject $_ -Name 'observedAt') } -Descending |
                            Select-Object -First 1
                    ) | Select-Object -First 1
                    if ($null -eq $hostRecord) { continue }

                    [void]$usedNotificationSuffixes.Add($notificationSuffix)
                    $acceptedForCode = [pscustomobject][ordered]@{
                        statusCode = $statusCode
                        conversationSuffix = [string](Get-PropertyValue -InputObject $terminal -Name 'conversationSuffix')
                        assistantSuffix = [string](Get-PropertyValue -InputObject $terminal -Name 'assistantSuffix')
                        notificationSuffix = $notificationSuffix
                        deliveryProofMode = 'prior-presented-dedup'
                        terminalObservedAt = [string](Get-PropertyValue -InputObject $terminal -Name 'observedAt')
                        watchdogStoppedAt = [string](Get-PropertyValue -InputObject $stop -Name 'observedAt')
                        dedupSuppressedAt = [string](Get-PropertyValue -InputObject $suppression -Name 'observedAt')
                        toastPresentedAt = [string](Get-PropertyValue -InputObject $hostRecord -Name 'observedAt')
                        helperAcceptedAt = [string](Get-PropertyValue -InputObject $helper -Name 'observedAt')
                        presentationState = [string](Get-PropertyValue -InputObject $helper -Name 'presentationState')
                    }
                    break
                }
            }
        }

        if ($null -ne $acceptedForCode) { break }
    }

    if ($null -eq $acceptedForCode) {
        throw "Live acceptance failed for ${statusCode}: exact-candidate terminal observation exists, but matching persisted watchdog stop + presented toast/helper acknowledgement evidence is incomplete."
    }
    $accepted += $acceptedForCode
}

if ($accepted.Count -lt $MinimumLiveDefinitiveProofs) {
    $observedCodes = @($accepted | ForEach-Object { $_.statusCode }) -join ','
    throw "Live acceptance failed: expected at least $MinimumLiveDefinitiveProofs complete definitive-status live proof(s), found $($accepted.Count). Accepted codes: $observedCodes"
}

$acceptedCodes = @($accepted | ForEach-Object { $_.statusCode })
Write-Host ("LIVE_TERMINAL_NOTIFICATION_ACCEPTANCE_PASS version={0}; source={1}; liveCodes={2}; liveProofs={3}; minimum={4}; uniqueNotifications={5}" -f `
    $ExpectedVersion,
    $expectedCommitSuffix,
    ($acceptedCodes -join ','),
    $accepted.Count,
    $MinimumLiveDefinitiveProofs,
    $usedNotificationSuffixes.Count)
$accepted | ConvertTo-Json -Depth 5 -Compress | Write-Host
