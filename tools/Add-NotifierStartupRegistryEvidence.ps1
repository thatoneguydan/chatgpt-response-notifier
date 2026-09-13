param(
    [Parameter(Mandatory = $true)]
    [string]$EvidencePath,
    [string]$ExpectedProfileRoot = 'C:\Users\dan'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Test-SamePath {
    param([string]$Left, [string]$Right)
    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
    try {
        return [string]::Equals(
            [IO.Path]::GetFullPath($Left).TrimEnd('\'),
            [IO.Path]::GetFullPath($Right).TrimEnd('\'),
            [StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
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

function Get-ExecutableFromCommand {
    param([string]$Command)
    $text = [string]$Command
    if ([string]::IsNullOrWhiteSpace($text)) { return '' }
    $text = $text.Trim()
    if ($text.StartsWith('"')) {
        $match = [regex]::Match($text, '^"([^\"]+)"')
        if ($match.Success) { return $match.Groups[1].Value }
        return ''
    }
    $match = [regex]::Match($text, '^([^\s]+)')
    return $(if ($match.Success) { $match.Groups[1].Value } else { '' })
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

$registration = [ordered]@{
    state = 'missing-profile-hive'
    commandPresent = $false
    commandTargetsExpectedHostRoot = $false
    versionFromCommand = $null
}

try {
    $profileListRoot = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
    $matchingSid = $null
    foreach ($profileKey in @(Get-ChildItem -LiteralPath $profileListRoot -ErrorAction Stop)) {
        try {
            $profile = Get-ItemProperty -LiteralPath $profileKey.PSPath -Name ProfileImagePath -ErrorAction Stop
            $expanded = [Environment]::ExpandEnvironmentVariables([string]$profile.ProfileImagePath)
            if (Test-SamePath -Left $expanded -Right $ExpectedProfileRoot) {
                $matchingSid = [string]$profileKey.PSChildName
                break
            }
        }
        catch {}
    }

    if (-not [string]::IsNullOrWhiteSpace($matchingSid)) {
        $registration.state = 'missing-registration'
        $runKey = "Registry::HKEY_USERS\$matchingSid\Software\Microsoft\Windows\CurrentVersion\Run"
        try {
            $value = Get-ItemProperty -LiteralPath $runKey -Name 'ChatGPTResponseNotifier' -ErrorAction Stop
            $command = [string]$value.ChatGPTResponseNotifier
            $exe = Get-ExecutableFromCommand -Command $command
            $hostRoot = Join-Path $ExpectedProfileRoot 'AppData\Local\ChatGPTResponseNotifier\Host'
            $registration.state = 'read'
            $registration.commandPresent = -not [string]::IsNullOrWhiteSpace($command)
            $registration.commandTargetsExpectedHostRoot = Test-PathWithinRoot -Candidate $exe -Root $hostRoot
            $registration.versionFromCommand = Get-HostVersionFromPath -Candidate $exe -HostRoot $hostRoot
        }
        catch [System.Management.Automation.ItemNotFoundException] {
            $registration.state = 'missing-registration'
        }
        catch {
            $registration.state = 'unavailable'
            $registration.errorType = $_.Exception.GetType().Name
            $registration.errorCode = $_.Exception.HResult
        }
    }
}
catch {
    $registration.state = 'unavailable'
    $registration.errorType = $_.Exception.GetType().Name
    $registration.errorCode = $_.Exception.HResult
}

$evidence = Get-Content -LiteralPath $EvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
if ($null -eq $evidence.helper) { throw 'Runtime evidence is missing the helper section.' }
$evidence.helper | Add-Member -NotePropertyName startupRegistration -NotePropertyValue ([pscustomobject]$registration) -Force
$evidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8

Write-Host ('Notifier startup registration evidence: state={0}; present={1}; expectedRoot={2}; version={3}' -f `
    $registration.state,
    $registration.commandPresent,
    $registration.commandTargetsExpectedHostRoot,
    $registration.versionFromCommand)
