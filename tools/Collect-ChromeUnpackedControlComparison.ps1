param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
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

function Get-ExtensionIdFromKey {
    param([string]$Key)
    if ([string]::IsNullOrWhiteSpace($Key)) { return $null }
    $sha = $null
    try {
        $bytes = [Convert]::FromBase64String($Key)
        $sha = [Security.Cryptography.SHA256]::Create()
        $hash = $sha.ComputeHash($bytes)
        $alphabet = 'abcdefghijklmnop'
        $builder = New-Object Text.StringBuilder
        foreach ($byte in $hash[0..15]) {
            [void]$builder.Append($alphabet[[int]($byte -shr 4)])
            [void]$builder.Append($alphabet[[int]($byte -band 0x0f)])
        }
        return $builder.ToString()
    }
    catch { return $null }
    finally { if ($null -ne $sha) { $sha.Dispose() } }
}

function Test-PathEquals {
    param([string]$Left, [string]$Right)
    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
    try {
        return [IO.Path]::GetFullPath($Left).TrimEnd('\') -ieq [IO.Path]::GetFullPath($Right).TrimEnd('\')
    }
    catch { return $false }
}

function Test-PathUnder {
    param([string]$Candidate, [string]$Root)
    if ([string]::IsNullOrWhiteSpace($Candidate) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
    try {
        $candidateFull = [IO.Path]::GetFullPath($Candidate).TrimEnd('\') + '\'
        $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
        return $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
}

function Test-ManifestTargetsChatGPT {
    param([object]$Manifest)
    if ($null -eq $Manifest) { return $false }

    foreach ($permission in @(Get-PropertyValue -InputObject $Manifest -Name 'host_permissions')) {
        if ([string]$permission -match '^https://chatgpt\.com/') { return $true }
    }

    foreach ($script in @(Get-PropertyValue -InputObject $Manifest -Name 'content_scripts')) {
        foreach ($match in @(Get-PropertyValue -InputObject $script -Name 'matches')) {
            if ([string]$match -match '^https://chatgpt\.com/') { return $true }
        }
    }

    $name = [string](Get-PropertyValue -InputObject $Manifest -Name 'name')
    $description = [string](Get-PropertyValue -InputObject $Manifest -Name 'description')
    return (($name + ' ' + $description) -match '(?i)chatgpt.*notif|notif.*chatgpt')
}

function Get-SafePathCategory {
    param(
        [string]$Candidate,
        [string]$ForkRoot,
        [string]$ProfileRoot,
        [string]$ChromeUserDataRoot
    )
    if ([string]::IsNullOrWhiteSpace($Candidate)) { return 'unavailable' }
    if (Test-PathEquals -Left $Candidate -Right $ForkRoot) { return 'fork-stable-root' }
    if (Test-PathUnder -Candidate $Candidate -Root $ChromeUserDataRoot) { return 'chrome-user-data' }
    if (Test-PathUnder -Candidate $Candidate -Root $ProfileRoot) { return 'user-profile-other' }
    return 'outside-user-profile'
}

function Get-ManifestSnapshot {
    param([string]$ExtensionPath)

    $snapshot = [ordered]@{
        pathExists = $false
        manifestExists = $false
        manifestReadable = $false
        manifestName = $null
        manifestVersion = $null
        manifestKeyPresent = $false
        calculatedExtensionId = $null
        targetsChatGPT = $false
    }

    if ([string]::IsNullOrWhiteSpace($ExtensionPath)) { return [pscustomobject]$snapshot }
    try { $snapshot.pathExists = Test-Path -LiteralPath $ExtensionPath -PathType Container } catch { }
    if (-not $snapshot.pathExists) { return [pscustomobject]$snapshot }

    $manifestPath = Join-Path $ExtensionPath 'manifest.json'
    try { $snapshot.manifestExists = Test-Path -LiteralPath $manifestPath -PathType Leaf } catch { }
    if (-not $snapshot.manifestExists) { return [pscustomobject]$snapshot }

    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        $snapshot.manifestReadable = $true
        $snapshot.manifestName = [string](Get-PropertyValue -InputObject $manifest -Name 'name')
        $snapshot.manifestVersion = [string](Get-PropertyValue -InputObject $manifest -Name 'version')
        $key = [string](Get-PropertyValue -InputObject $manifest -Name 'key')
        $snapshot.manifestKeyPresent = -not [string]::IsNullOrWhiteSpace($key)
        if ($snapshot.manifestKeyPresent) { $snapshot.calculatedExtensionId = Get-ExtensionIdFromKey -Key $key }
        $snapshot.targetsChatGPT = Test-ManifestTargetsChatGPT -Manifest $manifest
    }
    catch { }

    return [pscustomobject]$snapshot
}

$forkRoot = Join-Path $ExpectedProfileRoot 'AppData\Local\ChatGPTResponseNotifier\Extension'
$chromeUserDataRoot = Join-Path $ExpectedProfileRoot 'AppData\Local\Google\Chrome\User Data'
$repoManifestPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'extension\manifest.json'
$forkManifestPath = Join-Path $forkRoot 'manifest.json'

$targetExtensionId = $null
foreach ($candidateManifestPath in @($forkManifestPath, $repoManifestPath)) {
    if ($null -ne $targetExtensionId) { break }
    try {
        $manifest = Get-Content -LiteralPath $candidateManifestPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        $targetExtensionId = Get-ExtensionIdFromKey -Key ([string](Get-PropertyValue -InputObject $manifest -Name 'key'))
    }
    catch { }
}

$result = [ordered]@{
    schemaVersion = 1
    capability = 'chrome-unpacked-control-comparison-readonly-v1'
    observedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    readOnly = $true
    state = 'unavailable'
    targetExtensionId = $targetExtensionId
    lastUsedProfile = $null
    profilesDiscovered = 0
    profileFilesInspected = 0
    profileFilesUnavailable = 0
    targetRegistrationCount = 0
    controlCandidateCount = 0
    controlCandidateIds = @()
    records = @()
}

if ([string]::IsNullOrWhiteSpace($targetExtensionId)) {
    $result.state = 'target-id-unavailable'
}
elseif (-not (Test-Path -LiteralPath $chromeUserDataRoot -PathType Container)) {
    $result.state = 'chrome-user-data-missing'
}
else {
    try {
        $localStatePath = Join-Path $chromeUserDataRoot 'Local State'
        $localState = Get-Content -LiteralPath $localStatePath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        $profileRoot = Get-PropertyValue -InputObject $localState -Name 'profile'
        $lastUsed = [string](Get-PropertyValue -InputObject $profileRoot -Name 'last_used')
        if (-not [string]::IsNullOrWhiteSpace($lastUsed)) {
            $result.lastUsedProfile = $lastUsed.Substring(0, [Math]::Min(64, $lastUsed.Length))
        }
    }
    catch { }

    $records = @()
    $profiles = @(Get-ChildItem -LiteralPath $chromeUserDataRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' } |
        Sort-Object Name |
        Select-Object -First 32)

    foreach ($profile in $profiles) {
        $result.profilesDiscovered++
        foreach ($fileName in @('Secure Preferences', 'Preferences')) {
            $preferencePath = Join-Path $profile.FullName $fileName
            if (-not (Test-Path -LiteralPath $preferencePath -PathType Leaf)) { continue }

            try {
                $json = Get-Content -LiteralPath $preferencePath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
                $result.profileFilesInspected++
                $extensions = Get-PropertyValue -InputObject $json -Name 'extensions'
                $settings = Get-PropertyValue -InputObject $extensions -Name 'settings'
                if ($null -eq $settings) { continue }

                foreach ($property in @($settings.PSObject.Properties) | Select-Object -First 256) {
                    $extensionId = [string]$property.Name
                    $entry = $property.Value
                    $rawPath = [string](Get-PropertyValue -InputObject $entry -Name 'path')
                    $manifestSnapshot = Get-ManifestSnapshot -ExtensionPath $rawPath
                    $isTarget = $extensionId -ceq $targetExtensionId
                    if (-not $isTarget -and $manifestSnapshot.targetsChatGPT -ne $true) { continue }

                    $disableReasons = @()
                    foreach ($value in @(Get-PropertyValue -InputObject $entry -Name 'disable_reasons') | Select-Object -First 16) {
                        try { $disableReasons += [int]$value } catch { }
                    }

                    $pathIsAbsolute = $false
                    if (-not [string]::IsNullOrWhiteSpace($rawPath)) {
                        try { $pathIsAbsolute = [IO.Path]::IsPathRooted($rawPath) } catch { }
                    }

                    $records += [pscustomobject][ordered]@{
                        profile = $profile.Name
                        source = $fileName
                        extensionId = $extensionId
                        role = $(if ($isTarget) { 'fork-target' } else { 'control-candidate' })
                        stateValue = Get-PropertyValue -InputObject $entry -Name 'state'
                        locationValue = Get-PropertyValue -InputObject $entry -Name 'location'
                        creationFlagsValue = Get-PropertyValue -InputObject $entry -Name 'creation_flags'
                        fromWebStore = Get-PropertyValue -InputObject $entry -Name 'from_webstore'
                        disableReasonCount = $disableReasons.Count
                        disableReasonCodes = $disableReasons
                        pathAvailable = -not [string]::IsNullOrWhiteSpace($rawPath)
                        pathIsAbsolute = $pathIsAbsolute
                        pathCategory = Get-SafePathCategory -Candidate $rawPath -ForkRoot $forkRoot -ProfileRoot $ExpectedProfileRoot -ChromeUserDataRoot $chromeUserDataRoot
                        pathMatchesForkRoot = Test-PathEquals -Left $rawPath -Right $forkRoot
                        pathExists = $manifestSnapshot.pathExists
                        manifestExists = $manifestSnapshot.manifestExists
                        manifestReadable = $manifestSnapshot.manifestReadable
                        manifestName = $manifestSnapshot.manifestName
                        manifestVersion = $manifestSnapshot.manifestVersion
                        manifestKeyPresent = $manifestSnapshot.manifestKeyPresent
                        calculatedExtensionId = $manifestSnapshot.calculatedExtensionId
                        calculatedIdMatchesRegistration = $(if ($null -eq $manifestSnapshot.calculatedExtensionId) { $null } else { $manifestSnapshot.calculatedExtensionId -ceq $extensionId })
                        targetsChatGPT = $manifestSnapshot.targetsChatGPT
                    }
                }
            }
            catch { $result.profileFilesUnavailable++ }
        }
    }

    $result.records = @($records | Sort-Object profile, extensionId, source)
    $result.targetRegistrationCount = @($records | Where-Object { $_.role -ceq 'fork-target' }).Count
    $controlIds = @($records |
        Where-Object { $_.role -ceq 'control-candidate' } |
        Select-Object -ExpandProperty extensionId -Unique |
        Sort-Object)
    $result.controlCandidateIds = $controlIds
    $result.controlCandidateCount = $controlIds.Count

    if ($result.profileFilesInspected -eq 0) { $result.state = 'profile-files-unavailable' }
    elseif ($result.controlCandidateCount -eq 0) { $result.state = 'no-control-candidate-found' }
    elseif ($result.targetRegistrationCount -eq 0) { $result.state = 'target-absent-control-present' }
    else { $result.state = 'comparison-available' }
}

$parent = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
[pscustomobject]$result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $OutputPath -Encoding UTF8

Write-Host ('Chrome unpacked comparison: state={0}; target={1}; targetRegistrations={2}; controlCandidates={3}; profiles={4}; inspected={5}; unavailable={6}' -f `
    $result.state,
    $result.targetExtensionId,
    $result.targetRegistrationCount,
    $result.controlCandidateCount,
    $result.profilesDiscovered,
    $result.profileFilesInspected,
    $result.profileFilesUnavailable)
