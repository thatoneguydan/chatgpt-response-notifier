param(
    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
    [int]$UpdateTimeoutSeconds = 300,
    [int]$RestartTimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-BridgeConstants {
    $constantsPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\ChatGPTResponseNotifier.Core\LocalBridgeConstants.cs'
    $text = Get-Content -LiteralPath $constantsPath -Raw -Encoding UTF8 -ErrorAction Stop

    $portMatch = [regex]::Match($text, 'DefaultPort\s*=\s*(\d+)')
    $pathMatch = [regex]::Match($text, 'Path\s*=\s*"([^"]+)"')
    $originMatch = [regex]::Match($text, 'ExtensionOrigin\s*=\s*"([^"]+)"')
    if (-not $portMatch.Success -or -not $pathMatch.Success -or -not $originMatch.Success) {
        throw 'Could not resolve localhost bridge constants from source.'
    }

    $port = [int]$portMatch.Groups[1].Value
    if ($port -lt 1024 -or $port -gt 65535) { throw 'Resolved bridge port is outside the accepted range.' }
    $path = $pathMatch.Groups[1].Value
    $origin = $originMatch.Groups[1].Value
    if ($path -notmatch '^/[A-Za-z0-9._~/-]+$') { throw 'Resolved bridge path is invalid.' }
    if ($origin -notmatch '^chrome-extension://[a-p]{32}$') { throw 'Resolved extension origin is invalid.' }

    return [pscustomobject]@{
        Uri = [Uri]("ws://127.0.0.1:{0}{1}" -f $port, $path)
        Origin = $origin
    }
}

function Connect-Bridge {
    param([object]$Constants, [int]$TimeoutSeconds = 15)

    $socket = [System.Net.WebSockets.ClientWebSocket]::new()
    $socket.Options.SetRequestHeader('Origin', [string]$Constants.Origin)
    $cts = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
    try {
        $socket.ConnectAsync($Constants.Uri, $cts.Token).GetAwaiter().GetResult()
        if ($socket.State -ne [System.Net.WebSockets.WebSocketState]::Open) {
            throw "Bridge socket did not open: $($socket.State)."
        }
        return $socket
    }
    catch {
        $socket.Dispose()
        throw
    }
    finally {
        $cts.Dispose()
    }
}

function Receive-BridgeMessage {
    param(
        [System.Net.WebSockets.ClientWebSocket]$Socket,
        [int]$TimeoutSeconds = 15
    )

    $buffer = New-Object byte[] 65536
    $stream = [IO.MemoryStream]::new()
    $cts = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
    try {
        do {
            $segment = [ArraySegment[byte]]::new($buffer)
            $result = $Socket.ReceiveAsync($segment, $cts.Token).GetAwaiter().GetResult()
            if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { return $null }
            if ($result.MessageType -ne [System.Net.WebSockets.WebSocketMessageType]::Text) {
                throw 'Notifier bridge returned a non-text WebSocket message.'
            }
            $stream.Write($buffer, 0, $result.Count)
            if ($stream.Length -gt 65536) { throw 'Notifier bridge response exceeded the diagnostic size bound.' }
        }
        while (-not $result.EndOfMessage)

        $json = [Text.Encoding]::UTF8.GetString($stream.ToArray())
        return $json | ConvertFrom-Json -ErrorAction Stop
    }
    finally {
        $cts.Dispose()
        $stream.Dispose()
    }
}

function Send-BridgeMessage {
    param(
        [System.Net.WebSockets.ClientWebSocket]$Socket,
        [object]$Message,
        [int]$TimeoutSeconds = 15
    )

    $json = $Message | ConvertTo-Json -Compress -Depth 8
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    if ($bytes.Length -gt 65536) { throw 'Notifier bridge request exceeded the diagnostic size bound.' }
    $segment = [ArraySegment[byte]]::new($bytes)
    $cts = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
    try {
        $Socket.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).GetAwaiter().GetResult()
    }
    finally {
        $cts.Dispose()
    }
}

function Close-Bridge {
    param([System.Net.WebSockets.ClientWebSocket]$Socket)
    if ($null -eq $Socket) { return }
    try {
        if ($Socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
            $cts = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(2))
            try {
                $Socket.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'diagnostic-complete', $cts.Token).GetAwaiter().GetResult()
            }
            finally { $cts.Dispose() }
        }
    }
    catch { }
    finally { $Socket.Dispose() }
}

function Get-InstalledVersionFromReady {
    param([object]$Message)
    if ($null -eq $Message -or [string]$Message.type -cne 'host.ready') { return $null }
    return [string]$Message.installedExtensionVersion
}

$expected = $ExpectedVersion.Trim()
if ($expected -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') { throw 'ExpectedVersion must be a numeric dotted version.' }
$constants = Get-BridgeConstants
$requestId = [Guid]::NewGuid().ToString('N')
$startedAt = [DateTimeOffset]::UtcNow
$initialVersion = $null
$updateState = 'not-started'
$resultVersion = $null
$socket = $null

try {
    $socket = Connect-Bridge -Constants $constants
    $ready = Receive-BridgeMessage -Socket $socket
    $initialVersion = Get-InstalledVersionFromReady -Message $ready
    if ([string]::IsNullOrWhiteSpace($initialVersion)) { throw 'Notifier helper did not provide a valid host.ready message.' }

    Send-BridgeMessage -Socket $socket -Message ([ordered]@{ type = 'update.check'; requestId = $requestId })
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($UpdateTimeoutSeconds)

    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $remaining = [Math]::Max(1, [Math]::Min(30, [int][Math]::Ceiling(($deadline - [DateTimeOffset]::UtcNow).TotalSeconds)))
        $message = $null
        try { $message = Receive-BridgeMessage -Socket $socket -TimeoutSeconds $remaining }
        catch [OperationCanceledException] { continue }
        catch [Threading.Tasks.TaskCanceledException] { continue }

        if ($null -eq $message) { break }
        if ([string]$message.type -cne 'update.result' -or [string]$message.requestId -cne $requestId) { continue }
        $updateState = [string]$message.updateStatus.state
        $resultVersion = [string]$message.updateStatus.currentVersion
        if ($updateState -notin @('installed','current')) {
            $safeError = [string]$message.updateStatus.error
            if ($safeError.Length -gt 240) { $safeError = $safeError.Substring(0, 240) }
            throw "Managed update returned state '$updateState': $safeError"
        }
        break
    }
}
finally {
    if ($null -ne $socket) { Close-Bridge -Socket $socket }
}

if ($updateState -notin @('installed','current')) {
    throw "Managed update did not reach a terminal success state before timeout (last state: $updateState)."
}

$verifiedVersion = $null
$restartDeadline = [DateTimeOffset]::UtcNow.AddSeconds($RestartTimeoutSeconds)
while ([DateTimeOffset]::UtcNow -lt $restartDeadline) {
    $probe = $null
    try {
        $probe = Connect-Bridge -Constants $constants -TimeoutSeconds 5
        $ready = Receive-BridgeMessage -Socket $probe -TimeoutSeconds 5
        $candidate = Get-InstalledVersionFromReady -Message $ready
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            $verifiedVersion = $candidate
            if ($candidate -ceq $expected) { break }
        }
    }
    catch { }
    finally {
        if ($null -ne $probe) { Close-Bridge -Socket $probe }
    }
    Start-Sleep -Seconds 2
}

if ($verifiedVersion -cne $expected) {
    throw "Notifier helper did not restart on expected version $expected (last observed: $verifiedVersion)."
}

$result = [ordered]@{
    schemaVersion = 1
    capability = 'notifier-managed-update-localhost-v1'
    observedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    loopbackOnly = $true
    expectedVersion = $expected
    initialVersion = $initialVersion
    updateState = $updateState
    resultVersion = $resultVersion
    verifiedRestartVersion = $verifiedVersion
    elapsedSeconds = [Math]::Round(([DateTimeOffset]::UtcNow - $startedAt).TotalSeconds, 1)
}

$parent = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
[pscustomobject]$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Host ("Notifier managed update: initial={0}; state={1}; result={2}; verifiedRestart={3}; elapsed={4}s" -f `
    $initialVersion, $updateState, $resultVersion, $verifiedVersion, $result.elapsedSeconds)
