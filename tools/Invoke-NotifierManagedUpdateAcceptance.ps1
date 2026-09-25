param(
    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,
    [int]$Attempts = 40,
    [int]$RetryDelaySeconds = 15
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$BridgeUri = [Uri]'ws://127.0.0.1:38473/bridge'
$BridgeOrigin = 'chrome-extension://lciedmoiiapbgemklkpoadimhffaaaah'
$Utf8 = [Text.Encoding]::UTF8

function New-BridgeSocket {
    $socket = [Net.WebSockets.ClientWebSocket]::new()
    [void]$socket.Options.SetRequestHeader('Origin', $BridgeOrigin)
    $connectTimeout = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(10))
    try {
        [void]$socket.ConnectAsync($BridgeUri, $connectTimeout.Token).GetAwaiter().GetResult()
        Write-Output -NoEnumerate $socket
    }
    catch {
        [void]$socket.Dispose()
        throw
    }
    finally {
        [void]$connectTimeout.Dispose()
    }
}

function Receive-BridgeJson {
    param(
        [Parameter(Mandatory = $true)]
        [Net.WebSockets.ClientWebSocket]$Socket,
        [int]$TimeoutSeconds = 20
    )

    $buffer = [byte[]]::new(65536)
    $stream = [IO.MemoryStream]::new()
    $readTimeout = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
    try {
        do {
            $segment = [ArraySegment[byte]]::new($buffer)
            $result = $Socket.ReceiveAsync($segment, $readTimeout.Token).GetAwaiter().GetResult()
            if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) {
                throw 'Notifier helper closed the localhost bridge before the expected response arrived.'
            }
            if ($result.MessageType -ne [Net.WebSockets.WebSocketMessageType]::Text) {
                continue
            }
            $stream.Write($buffer, 0, $result.Count)
        }
        while (-not $result.EndOfMessage)

        return ($Utf8.GetString($stream.ToArray()) | ConvertFrom-Json -ErrorAction Stop)
    }
    finally {
        $readTimeout.Dispose()
        $stream.Dispose()
    }
}

function Send-BridgeJson {
    param(
        [Parameter(Mandatory = $true)]
        [Net.WebSockets.ClientWebSocket]$Socket,
        [Parameter(Mandatory = $true)]
        [object]$Payload
    )

    $bytes = $Utf8.GetBytes(($Payload | ConvertTo-Json -Depth 8 -Compress))
    $segment = [ArraySegment[byte]]::new($bytes)
    $sendTimeout = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(10))
    try {
        $Socket.SendAsync(
            $segment,
            [Net.WebSockets.WebSocketMessageType]::Text,
            $true,
            $sendTimeout.Token).GetAwaiter().GetResult()
    }
    finally {
        $sendTimeout.Dispose()
    }
}

function Invoke-ManagedUpdateCheck {
    $socket = New-BridgeSocket
    try {
        # The helper sends host.ready immediately after the WebSocket handshake.
        $ready = Receive-BridgeJson -Socket $socket -TimeoutSeconds 20
        if ([string]$ready.type -ne 'host.ready') {
            throw "Notifier helper bridge did not begin with host.ready; received '$([string]$ready.type)'."
        }

        $requestId = [Guid]::NewGuid().ToString()
        Send-BridgeJson -Socket $socket -Payload ([ordered]@{
            type = 'update.check'
            requestId = $requestId
        })

        $deadline = [DateTimeOffset]::UtcNow.AddSeconds(150)
        while ([DateTimeOffset]::UtcNow -lt $deadline) {
            $message = Receive-BridgeJson -Socket $socket -TimeoutSeconds 20
            if ([string]$message.type -ne 'update.result') { continue }
            if ([string]$message.requestId -ne $requestId) { continue }
            return $message
        }
        throw 'Notifier helper did not return update.result before the acceptance deadline.'
    }
    finally {
        try { $socket.Dispose() } catch {}
    }
}

function Read-InstalledBridgeVersion {
    $socket = New-BridgeSocket
    try {
        $ready = Receive-BridgeJson -Socket $socket -TimeoutSeconds 20
        if ([string]$ready.type -ne 'host.ready') { return '' }
        return [string]$ready.installedExtensionVersion
    }
    finally {
        try { $socket.Dispose() } catch {}
    }
}

if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) {
    throw 'ExpectedVersion is required.'
}
if ($Attempts -lt 1 -or $Attempts -gt 80) {
    throw 'Attempts must be between 1 and 80.'
}
if ($RetryDelaySeconds -lt 1 -or $RetryDelaySeconds -gt 60) {
    throw 'RetryDelaySeconds must be between 1 and 60.'
}

$installed = ''
$lastState = ''
$lastAvailable = ''
$lastError = ''
for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
    try {
        $response = Invoke-ManagedUpdateCheck
        $status = $response.updateStatus
        $installed = [string]$status.currentVersion
        $lastState = [string]$status.state
        $lastAvailable = [string]$status.availableVersion
        $lastError = [string]$status.error
        Write-Host "Notifier live-update acceptance attempt $attempt`: expected=$ExpectedVersion installed=$installed state=$lastState available=$lastAvailable errorPresent=$(-not [string]::IsNullOrWhiteSpace($lastError))"
        if ($installed -eq $ExpectedVersion) { break }
    }
    catch {
        $lastError = $_.Exception.Message
        Write-Warning "Notifier live-update acceptance attempt $attempt could not complete: $lastError"
    }

    if ($attempt -lt $Attempts) { Start-Sleep -Seconds $RetryDelaySeconds }
}

if ($installed -ne $ExpectedVersion) {
    throw "Notifier $ExpectedVersion was published but the Glass helper did not install it. Last result: installed=$installed state=$lastState available=$lastAvailable error=$lastError"
}

# The update result is emitted before the helper schedules its replacement.
# Reconnect until the restarted helper itself reports the installed version.
$verifiedHost = $false
$hostVersion = ''
for ($attempt = 1; $attempt -le 30; $attempt += 1) {
    try {
        $hostVersion = Read-InstalledBridgeVersion
        if ($hostVersion -eq $ExpectedVersion) {
            $verifiedHost = $true
            break
        }
    }
    catch {
        $hostVersion = ''
    }
    Start-Sleep -Seconds 2
}

if (-not $verifiedHost) {
    throw "Notifier $ExpectedVersion installed, but the restarted Glass helper did not report that version. Last helper version: $hostVersion"
}

Write-Host "Notifier $ExpectedVersion is installed on Glass and confirmed by the restarted local helper."
