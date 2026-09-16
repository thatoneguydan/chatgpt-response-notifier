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

function Get-ExtensionId {
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

function Test-PathMatches {
    param([string]$Candidate, [string]$Expected)
    if ([string]::IsNullOrWhiteSpace($Candidate) -or [string]::IsNullOrWhiteSpace($Expected)) { return $false }
    try {
        return [IO.Path]::GetFullPath($Candidate).TrimEnd('\') -ieq [IO.Path]::GetFullPath($Expected).TrimEnd('\')
    }
    catch { return $false }
}

function Copy-SafeRegistration {
    param([object]$Record)
    if ($null -eq $Record) { return $null }
    $safe = [ordered]@{}
    foreach ($name in @('profile','source','present','locationValue','disableReasonCount','pathAvailable','pathMatchesExpectedExtensionRoot')) {
        $value = Get-PropertyValue -InputObject $Record -Name $name
        if ($null -ne $value) { $safe[$name] = $value }
    }
    $codes = @()
    foreach ($value in @(Get-PropertyValue -InputObject $Record -Name 'disableReasonCodes') | Select-Object -First 16) {
        try { $codes += [int]$value } catch { }
    }
    $safe.disableReasonCodes = $codes
    return [pscustomobject]$safe
}

function Copy-SafeProfileState {
    param([object]$Record)
    if ($null -eq $Record) { return $null }
    $safe = [ordered]@{}
    foreach ($name in @('profile','preferencesReadable','securePreferencesReadable')) {
        $value = Get-PropertyValue -InputObject $Record -Name $name
        if ($null -ne $value) { $safe[$name] = $value }
    }
    return [pscustomobject]$safe
}

function Copy-SafeRootEvidence {
    param([object]$Record)
    if ($null -eq $Record) { return $null }
    $safe = [ordered]@{}
    foreach ($name in @('exists','manifestExists','manifestReadable','manifestJsonValid','manifestVersion','manifestKeyPresent','calculatedExtensionId','referencedFileCount')) {
        $value = Get-PropertyValue -InputObject $Record -Name $name
        if ($null -ne $value) { $safe[$name] = $value }
    }
    $safe.referencedFilesMissing = @((Get-PropertyValue -InputObject $Record -Name 'referencedFilesMissing') | Select-Object -First 128)
    $safe.referencedFilesUnreadable = @((Get-PropertyValue -InputObject $Record -Name 'referencedFilesUnreadable') | Select-Object -First 128)
    return [pscustomobject]$safe
}

function Get-HelperSnapshot {
    param([string]$Path)
    try {
        $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction Stop
        $snapshot = $raw | ConvertFrom-Json -ErrorAction Stop
        if ([int](Get-PropertyValue -InputObject $snapshot -Name 'schemaVersion') -ne 2) { return $null }
        if ([string](Get-PropertyValue -InputObject $snapshot -Name 'capability') -cne 'chrome-registration-readonly-helper-v2') { return $null }
        $observedText = [string](Get-PropertyValue -InputObject $snapshot -Name 'observedAtUtc')
        $observed = [DateTimeOffset]::Parse($observedText)
        $age = ([DateTimeOffset]::UtcNow - $observed).TotalSeconds
        if ($age -lt -5 -or $age -gt 180) { return $null }

        $registrations = @()
        foreach ($record in @(Get-PropertyValue -InputObject $snapshot -Name 'registrations') | Select-Object -First 64) {
            $copy = Copy-SafeRegistration -Record $record
            if ($null -ne $copy) { $registrations += $copy }
        }
        $profileStates = @()
        foreach ($record in @(Get-PropertyValue -InputObject $snapshot -Name 'profileStates') | Select-Object -First 32) {
            $copy = Copy-SafeProfileState -Record $record
            if ($null -ne $copy) { $profileStates += $copy }
        }

        return [pscustomobject][ordered]@{
            source = 'helper-snapshot'
            capability = 'chrome-registration-readonly-helper-v2'
            observedAtUtc = $observed.ToString('o')
            state = [string](Get-PropertyValue -InputObject $snapshot -Name 'state')
            extensionId = [string](Get-PropertyValue -InputObject $snapshot -Name 'extensionId')
            expectedExtensionRoot = Copy-SafeRootEvidence -Record (Get-PropertyValue -InputObject $snapshot -Name 'expectedExtensionRoot')
            lastUsedProfile = Get-PropertyValue -InputObject $snapshot -Name 'lastUsedProfile'
            lastUsedProfileRegistrationPresent = Get-PropertyValue -InputObject $snapshot -Name 'lastUsedProfileRegistrationPresent'
            lastUsedProfilePathMatchesExpectedExtensionRoot = Get-PropertyValue -InputObject $snapshot -Name 'lastUsedProfilePathMatchesExpectedExtensionRoot'
            profilesDiscovered = Get-PropertyValue -InputObject $snapshot -Name 'profilesDiscovered'
            profileFilesInspected = Get-PropertyValue -InputObject $snapshot -Name 'profileFilesInspected'
            profileFilesUnavailable = Get-PropertyValue -InputObject $snapshot -Name 'profileFilesUnavailable'
            profileStates = $profileStates
            registrations = $registrations
        }
    }
    catch { return $null }
}

$installRoot = Join-Path $ExpectedProfileRoot 'AppData\Local\ChatGPTResponseNotifier'
$extensionRoot = Join-Path $installRoot 'Extension'
$manifestPath = Join-Path $extensionRoot 'manifest.json'
$userDataRoot = Join-Path $ExpectedProfileRoot 'AppData\Local\Google\Chrome\User Data'
$helperSnapshotPath = Join-Path $installRoot 'Evidence\chrome-registration-evidence.json'
$result = [ordered]@{
    source = 'direct-profile-read'
    capability = 'chrome-registration-readonly-v2'
    observedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    state = 'unavailable'
    extensionId = $null
    expectedExtensionRoot = $null
    lastUsedProfile = $null
    lastUsedProfileRegistrationPresent = $null
    lastUsedProfilePathMatchesExpectedExtensionRoot = $null
    profilesDiscovered = 0
    profileFilesInspected = 0
    profileFilesUnavailable = 0
    profileStates = @()
    registrations = @()
}

try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $extensionId = Get-ExtensionId -Key ([string](Get-PropertyValue -InputObject $manifest -Name 'key'))
    $result.extensionId = $extensionId
    if ([string]::IsNullOrWhiteSpace($extensionId)) {
        $result.state = 'extension-id-unavailable'
    }
    elseif (-not (Test-Path -LiteralPath $userDataRoot -PathType Container)) {
        $result.state = 'chrome-user-data-missing'
    }
    else {
        try {
            $localStatePath = Join-Path $userDataRoot 'Local State'
            $localState = Get-Content -LiteralPath $localStatePath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            $profileRoot = Get-PropertyValue -InputObject $localState -Name 'profile'
            $lastUsed = [string](Get-PropertyValue -InputObject $profileRoot -Name 'last_used')
            if (-not [string]::IsNullOrWhiteSpace($lastUsed)) { $result.lastUsedProfile = $lastUsed.Substring(0, [Math]::Min(64, $lastUsed.Length)) }
        }
        catch { }

        $records = @()
        $profileStates = @()
        $profiles = @(Get-ChildItem -LiteralPath $userDataRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' } | Sort-Object Name | Select-Object -First 32)
        foreach ($profile in $profiles) {
            $result.profilesDiscovered++
            $preferencesReadable = $false
            $securePreferencesReadable = $false
            foreach ($fileName in @('Secure Preferences','Preferences')) {
                $path = Join-Path $profile.FullName $fileName
                if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
                try {
                    $json = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
                    $result.profileFilesInspected++
                    if ($fileName -eq 'Preferences') { $preferencesReadable = $true }
                    else { $securePreferencesReadable = $true }
                    $extensions = Get-PropertyValue -InputObject $json -Name 'extensions'
                    $settings = Get-PropertyValue -InputObject $extensions -Name 'settings'
                    $entry = Get-PropertyValue -InputObject $settings -Name $extensionId
                    if ($null -eq $entry) { continue }
                    $rawPath = [string](Get-PropertyValue -InputObject $entry -Name 'path')
                    $disableReasons = @(Get-PropertyValue -InputObject $entry -Name 'disable_reasons')
                    $records += [pscustomobject][ordered]@{
                        profile = $profile.Name
                        source = $fileName
                        present = $true
                        locationValue = Get-PropertyValue -InputObject $entry -Name 'location'
                        disableReasonCount = $disableReasons.Count
                        disableReasonCodes = @($disableReasons | Select-Object -First 16 | ForEach-Object { [int]$_ })
                        pathAvailable = -not [string]::IsNullOrWhiteSpace($rawPath)
                        pathMatchesExpectedExtensionRoot = Test-PathMatches -Candidate $rawPath -Expected $extensionRoot
                    }
                }
                catch { $result.profileFilesUnavailable++ }
            }
            $profileStates += [pscustomobject][ordered]@{
                profile = $profile.Name
                preferencesReadable = $preferencesReadable
                securePreferencesReadable = $securePreferencesReadable
            }
        }
        $result.profileStates = $profileStates
        $result.registrations = $records
        $lastProfile = [string]$result.lastUsedProfile
        if (-not [string]::IsNullOrWhiteSpace($lastProfile)) {
            $lastRecords = @($records | Where-Object { $_.profile -ceq $lastProfile })
            $result.lastUsedProfileRegistrationPresent = $lastRecords.Count -gt 0
            if ($lastRecords.Count -gt 0) { $result.lastUsedProfilePathMatchesExpectedExtensionRoot = @($lastRecords | Where-Object { $_.pathMatchesExpectedExtensionRoot -eq $true }).Count -gt 0 }
        }
        if ($records.Count -gt 0) { $result.state = 'present' }
        elseif ($result.profileFilesInspected -gt 0) { $result.state = 'absent' }
        else { $result.state = 'unavailable' }
    }
}
catch [System.Management.Automation.ItemNotFoundException] { $result.state = 'manifest-missing' }
catch {
    $result.state = 'unavailable'
    $result.errorType = $_.Exception.GetType().Name
    $result.errorCode = $_.Exception.HResult
}

$snapshot = Get-HelperSnapshot -Path $helperSnapshotPath
if ($null -ne $snapshot) {
    $result = [ordered]@{}
    foreach ($property in $snapshot.PSObject.Properties) { $result[$property.Name] = $property.Value }
}

$evidence = Get-Content -LiteralPath $EvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
$evidence.chrome | Add-Member -NotePropertyName registration -NotePropertyValue ([pscustomobject]$result) -Force
$evidence | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8
$root = $result.expectedExtensionRoot
Write-Host ('Chrome registration evidence: source={0}; state={1}; id={2}; lastUsed={3}; rootExists={4}; manifestReadable={5}; manifestJsonValid={6}; calculatedId={7}; referencedMissing={8}; referencedUnreadable={9}; inspected={10}; unavailable={11}; registrations={12}' -f $result.source, $result.state, $result.extensionId, $result.lastUsedProfile, (Get-PropertyValue $root 'exists'), (Get-PropertyValue $root 'manifestReadable'), (Get-PropertyValue $root 'manifestJsonValid'), (Get-PropertyValue $root 'calculatedExtensionId'), @((Get-PropertyValue $root 'referencedFilesMissing')).Count, @((Get-PropertyValue $root 'referencedFilesUnreadable')).Count, $result.profileFilesInspected, $result.profileFilesUnavailable, @($result.registrations).Count)