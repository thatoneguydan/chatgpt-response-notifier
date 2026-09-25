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

function Open-BridgeSocket {
    param(
        [Parameter(Mandatory = $true)]
        [ref]$Socket
    )

    $client = [Net.WebSockets.ClientWebSocket]::new()
    [void]$client.Options.SetRequestHeader('Origin', $BridgeOrigin)
    $connectTimeout = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(10))
    try {
        [void]$client.ConnectAsync($BridgeUri, $connectTimeout.Token).GetAwaiter().GetResult()
        $Socket.Value = $client
    }
    catch {
        [void]$client.Dispose()
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
        [Parameter(Mandatory = $true)]
        [ref]$Message,
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
            [void]$stream.Write($buffer, 0, $result.Count)
        }
        while (-not $result.EndOfMessage)

        $Message.Value = ($Utf8.GetString($stream.ToArray()) | ConvertFrom-Json -ErrorAction Stop)
    }
    finally {
        [void]$readTimeout.Dispose()
        [void]$stream.Dispose()
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
        [void]$Socket.SendAsync(
            $segment,
            [Net.WebSockets.WebSocketMessageType]::Text,
            $true,
            $sendTimeout.Token).GetAwaiter().GetResult()
    }
    finally {
        [void]$sendTimeout.Dispose()
    }
}

function Read-BridgeReady {
    param(
        [Parameter(Mandatory = $true)]
        [ref]$Ready
    )

    $socket = $null
    Open-BridgeSocket -Socket ([ref]$socket)
    try {
        $message = $null
        Receive-BridgeJson -Socket $socket -Message ([ref]$message) -TimeoutSeconds 20
        if ([string]$message.type -ne 'host.ready') {
            throw "Notifier helper bridge did not begin with host.ready; received '$([string]$message.type)'."
        }
        $Ready.Value = $message
    }
    finally {
        try { [void]$socket.Dispose() } catch {}
    }
}

function Request-ManagedUpdate {
    $socket = $null
    Open-BridgeSocket -Socket ([ref]$socket)
    try {
        $ready = $null
        Receive-BridgeJson -Socket $socket -Message ([ref]$ready) -TimeoutSeconds 20
        if ([string]$ready.type -ne 'host.ready') {
            throw "Notifier helper bridge did not begin with host.ready; received '$([string]$ready.type)'."
        }

        Send-BridgeJson -Socket $socket -Payload ([ordered]@{
            type = 'update.check'
            requestId = [Guid]::NewGuid().ToString()
        })
    }
    finally {
        try { [void]$socket.Dispose() } catch {}
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
$lastError = ''
for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
    $requested = $false
    try {
        $ready = $null
        Read-BridgeReady -Ready ([ref]$ready)
        $installed = [string]$ready.installedExtensionVersion

        if ($installed -ne $ExpectedVersion -and (($attempt - 1) % 4 -eq 0)) {
            Request-ManagedUpdate
            $requested = $true
        }

        Write-Host "Notifier live-update acceptance attempt $attempt`: expected=$ExpectedVersion installed=$installed updateRequested=$requested"
        if ($installed -eq $ExpectedVersion) { break }
    }
    catch {
        $lastError = $_.Exception.Message
        Write-Warning "Notifier live-update acceptance attempt $attempt could not complete: $lastError"
    }

    if ($attempt -lt $Attempts) { Start-Sleep -Seconds $RetryDelaySeconds }
}

if ($installed -ne $ExpectedVersion) {
    throw "Notifier $ExpectedVersion was published but the Glass helper did not report it installed. Last result: installed=$installed error=$lastError"
}

# Give a replacement helper time to take over the loopback endpoint, then
# confirm a fresh host.ready still sees the installed release.
$verifiedHost = $false
$hostVersion = ''
for ($attempt = 1; $attempt -le 30; $attempt += 1) {
    try {
        $ready = $null
        Read-BridgeReady -Ready ([ref]$ready)
        $hostVersion = [string]$ready.installedExtensionVersion
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
    throw "Notifier $ExpectedVersion installed, but a fresh Glass helper connection did not report that version. Last helper version: $hostVersion"
}

Write-Host "Notifier $ExpectedVersion is installed on Glass and confirmed through a fresh local helper connection."
