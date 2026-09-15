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

$installRoot = Join-Path $ExpectedProfileRoot 'AppData\Local\ChatGPTResponseNotifier'
$extensionRoot = Join-Path $installRoot 'Extension'
$manifestPath = Join-Path $extensionRoot 'manifest.json'
$userDataRoot = Join-Path $ExpectedProfileRoot 'AppData\Local\Google\Chrome\User Data'
$result = [ordered]@{
    state = 'unavailable'
    extensionId = $null
    profileFilesInspected = 0
    profileFilesUnavailable = 0
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
        $records = @()
        $profiles = @(Get-ChildItem -LiteralPath $userDataRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' })
        foreach ($profile in $profiles) {
            foreach ($fileName in @('Secure Preferences','Preferences')) {
                $path = Join-Path $profile.FullName $fileName
                if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
                try {
                    $json = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
                    $result.profileFilesInspected++
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
                        stateValue = Get-PropertyValue -InputObject $entry -Name 'state'
                        locationValue = Get-PropertyValue -InputObject $entry -Name 'location'
                        disableReasonCount = $disableReasons.Count
                        disableReasonCodes = @($disableReasons | ForEach-Object { [int]$_ })
                        pathAvailable = -not [string]::IsNullOrWhiteSpace($rawPath)
                        pathMatchesExpectedExtensionRoot = Test-PathMatches -Candidate $rawPath -Expected $extensionRoot
                    }
                }
                catch { $result.profileFilesUnavailable++ }
            }
        }
        $result.registrations = $records
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

$evidence = Get-Content -LiteralPath $EvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
$evidence.chrome | Add-Member -NotePropertyName registration -NotePropertyValue ([pscustomobject]$result) -Force
$evidence | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8
Write-Host ('Chrome registration evidence: state={0}; id={1}; inspected={2}; unavailable={3}; registrations={4}' -f $result.state, $result.extensionId, $result.profileFilesInspected, $result.profileFilesUnavailable, @($result.registrations).Count)
