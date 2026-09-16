param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ExtensionId = 'lciedmoiiapbgemklkpoadimhffaaaah'

function Get-SafeChromeVersion {
    param([string]$ExecutablePath)
    if ([string]::IsNullOrWhiteSpace($ExecutablePath)) { return $null }
    try {
        $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($ExecutablePath).ProductVersion
        if ([string]::IsNullOrWhiteSpace($version)) { return $null }
        if ($version.Length -gt 64) { return $version.Substring(0, 64) }
        return $version
    }
    catch { return $null }
}

function Test-Flag {
    param([string]$CommandLine, [string]$Name)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $null }
    return [regex]::IsMatch($CommandLine, '(?i)(?:^|\s)--' + [regex]::Escape($Name) + '(?:=|\s|$)')
}

function Get-RegistryProperty {
    param([string]$Path, [string]$Name)
    try {
        $item = Get-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction Stop
        return $item.PSObject.Properties[$Name].Value
    }
    catch { return $null }
}

function Get-PolicyListValues {
    param([string]$Path)
    $values = @()
    try {
        $item = Get-ItemProperty -LiteralPath $Path -ErrorAction Stop
        foreach ($property in $item.PSObject.Properties) {
            if ($property.Name -like 'PS*') { continue }
            if ($null -eq $property.Value) { continue }
            $text = [string]$property.Value
            if ($text.Length -le 256) { $values += $text }
        }
    }
    catch { }
    return @($values)
}

function Get-ExtensionSettingsSummary {
    param([string]$ChromePolicyPath)
    $specificMode = $null
    $wildcardMode = $null
    $settingsPresent = $false
    $raw = Get-RegistryProperty -Path $ChromePolicyPath -Name 'ExtensionSettings'
    if ($null -eq $raw) {
        return [pscustomobject]@{
            present = $false
            specificPresent = $false
            specificInstallationMode = $null
            wildcardPresent = $false
            wildcardInstallationMode = $null
        }
    }

    $settingsPresent = $true
    $specificPresent = $false
    $wildcardPresent = $false
    try {
        $json = ([string]$raw) | ConvertFrom-Json -ErrorAction Stop
        $specific = $json.PSObject.Properties[$ExtensionId]
        if ($null -ne $specific) {
            $specificPresent = $true
            $modeProperty = $specific.Value.PSObject.Properties['installation_mode']
            if ($null -ne $modeProperty) { $specificMode = [string]$modeProperty.Value }
        }
        $wildcard = $json.PSObject.Properties['*']
        if ($null -ne $wildcard) {
            $wildcardPresent = $true
            $modeProperty = $wildcard.Value.PSObject.Properties['installation_mode']
            if ($null -ne $modeProperty) { $wildcardMode = [string]$modeProperty.Value }
        }
    }
    catch { }

    return [pscustomobject]@{
        present = $settingsPresent
        specificPresent = $specificPresent
        specificInstallationMode = $specificMode
        wildcardPresent = $wildcardPresent
        wildcardInstallationMode = $wildcardMode
    }
}

function Get-PolicyScopeSummary {
    param([string]$ChromePolicyPath, [string]$Scope)
    $exists = Test-Path -LiteralPath $ChromePolicyPath -PathType Container
    $blocklist = Get-PolicyListValues -Path (Join-Path $ChromePolicyPath 'ExtensionInstallBlocklist')
    $allowlist = Get-PolicyListValues -Path (Join-Path $ChromePolicyPath 'ExtensionInstallAllowlist')
    $settings = Get-ExtensionSettingsSummary -ChromePolicyPath $ChromePolicyPath
    $developerModeSetting = Get-RegistryProperty -Path $ChromePolicyPath -Name 'ExtensionDeveloperModeSettings'

    return [pscustomobject][ordered]@{
        scope = $Scope
        chromePolicyKeyPresent = $exists
        extensionInstallBlocklistHasSpecific = @($blocklist | Where-Object { $_ -ceq $ExtensionId }).Count -gt 0
        extensionInstallBlocklistHasWildcard = @($blocklist | Where-Object { $_ -ceq '*' }).Count -gt 0
        extensionInstallAllowlistHasSpecific = @($allowlist | Where-Object { $_ -ceq $ExtensionId }).Count -gt 0
        extensionSettingsPresent = $settings.present
        extensionSettingsSpecificPresent = $settings.specificPresent
        extensionSettingsSpecificInstallationMode = $settings.specificInstallationMode
        extensionSettingsWildcardPresent = $settings.wildcardPresent
        extensionSettingsWildcardInstallationMode = $settings.wildcardInstallationMode
        extensionDeveloperModeSettings = if ($null -eq $developerModeSetting) { $null } else { [int]$developerModeSetting }
    }
}

$chromeRecords = @()
$processState = 'read'
try {
    $chromeProcesses = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction Stop)
    foreach ($process in $chromeProcesses) {
        $commandLine = [string]$process.CommandLine
        $commandLineReadable = -not [string]::IsNullOrWhiteSpace($commandLine)
        $isBrowserProcess = $commandLineReadable -and -not [regex]::IsMatch($commandLine, '(?i)(?:^|\s)--type=')
        $chromeRecords += [pscustomobject][ordered]@{
            isBrowserProcess = $isBrowserProcess
            commandLineReadable = $commandLineReadable
            disableExtensions = Test-Flag -CommandLine $commandLine -Name 'disable-extensions'
            disableExtensionsExcept = Test-Flag -CommandLine $commandLine -Name 'disable-extensions-except'
            loadExtension = Test-Flag -CommandLine $commandLine -Name 'load-extension'
            userDataDirOverride = Test-Flag -CommandLine $commandLine -Name 'user-data-dir'
            profileDirectoryOverride = Test-Flag -CommandLine $commandLine -Name 'profile-directory'
            version = Get-SafeChromeVersion -ExecutablePath ([string]$process.ExecutablePath)
        }
    }
}
catch {
    $processState = 'unavailable'
}

$browserRecords = @($chromeRecords | Where-Object { $_.isBrowserProcess -eq $true })

$policyScopes = @(
    Get-PolicyScopeSummary -ChromePolicyPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome' -Scope 'machine-64'
    Get-PolicyScopeSummary -ChromePolicyPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Policies\Google\Chrome' -Scope 'machine-32'
)

$userPolicyState = 'unavailable'
try {
    $profileList = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
    $danSid = $null
    foreach ($key in @(Get-ChildItem -LiteralPath $profileList -ErrorAction Stop)) {
        $profileImagePath = [Environment]::ExpandEnvironmentVariables([string](Get-RegistryProperty -Path $key.PSPath -Name 'ProfileImagePath'))
        if ($profileImagePath -match '(?i)\\Users\\dan$') {
            $danSid = $key.PSChildName
            break
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($danSid)) {
        $userChromePolicyPath = 'Registry::HKEY_USERS\' + $danSid + '\Software\Policies\Google\Chrome'
        $policyScopes += Get-PolicyScopeSummary -ChromePolicyPath $userChromePolicyPath -Scope 'interactive-user'
        $userPolicyState = 'read'
    }
    else {
        $userPolicyState = 'profile-not-found'
    }
}
catch {
    $userPolicyState = 'unavailable'
}

$result = [ordered]@{
    schemaVersion = 1
    capability = 'chrome-launch-policy-readonly-v1'
    observedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    readOnly = $true
    chromeProcesses = [ordered]@{
        state = $processState
        totalCount = @($chromeRecords).Count
        browserProcessCount = @($browserRecords).Count
        browserCommandLinesReadable = @($browserRecords | Where-Object { $_.commandLineReadable -eq $true }).Count
        anyBrowserDisableExtensions = @($browserRecords | Where-Object { $_.disableExtensions -eq $true }).Count -gt 0
        anyBrowserDisableExtensionsExcept = @($browserRecords | Where-Object { $_.disableExtensionsExcept -eq $true }).Count -gt 0
        anyBrowserLoadExtension = @($browserRecords | Where-Object { $_.loadExtension -eq $true }).Count -gt 0
        anyBrowserUserDataDirOverride = @($browserRecords | Where-Object { $_.userDataDirOverride -eq $true }).Count -gt 0
        anyBrowserProfileDirectoryOverride = @($browserRecords | Where-Object { $_.profileDirectoryOverride -eq $true }).Count -gt 0
        observedVersions = @($browserRecords | ForEach-Object { $_.version } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique | Select-Object -First 4)
    }
    policies = [ordered]@{
        userPolicyState = $userPolicyState
        scopes = $policyScopes
    }
}

$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
