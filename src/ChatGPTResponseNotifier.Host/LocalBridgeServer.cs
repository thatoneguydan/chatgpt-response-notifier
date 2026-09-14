using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using ChatGPTResponseNotifier.Core;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace ChatGPTResponseNotifier.Host;

internal sealed class LocalBridgeServer : IAsyncDisposable
{
    private readonly WebApplication _app;
    private readonly Func<NativeMessage, Task> _onMessage;
    private readonly Func<object> _readyMessageFactory;
    private readonly ConcurrentDictionary<Guid, WebSocket> _clients = new();

    private LocalBridgeServer(WebApplication app, Func<NativeMessage, Task> onMessage, Func<object> readyMessageFactory)
    {
        _app = app;
        _onMessage = onMessage;
        _readyMessageFactory = readyMessageFactory;
    }

    public static async Task<LocalBridgeServer> StartAsync(
        Func<NativeMessage, Task> onMessage,
        Func<object> readyMessageFactory,
        CancellationToken cancellationToken)
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options =>
        {
            options.Listen(IPAddress.Loopback, LocalBridgeConstants.Port);
        });

        var app = builder.Build();
        var server = new LocalBridgeServer(app, onMessage, readyMessageFactory);
        app.UseWebSockets(new WebSocketOptions
        {
            KeepAliveInterval = TimeSpan.FromSeconds(20)
        });
        app.Map(LocalBridgeConstants.Path, server.HandleRequestAsync);
        await app.StartAsync(cancellationToken).ConfigureAwait(false);
        return server;
    }

    public async Task<int> SendAsync(object message, CancellationToken cancellationToken = default)
    {
        var payload = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(message, JsonOptions.Default));
        var sent = 0;

        foreach (var pair in _clients.ToArray())
        {
            var socket = pair.Value;
            if (socket.State != WebSocketState.Open)
            {
                _clients.TryRemove(pair.Key, out _);
                continue;
            }

            try
            {
                await socket.SendAsync(payload, WebSocketMessageType.Text, endOfMessage: true, cancellationToken).ConfigureAwait(false);
                sent += 1;
            }
            catch
            {
                _clients.TryRemove(pair.Key, out _);
                try { socket.Abort(); } catch { }
            }
        }

        return sent;
    }

    private async Task HandleRequestAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        var origin = context.Request.Headers.Origin.ToString();
        if (!string.Equals(origin, LocalBridgeConstants.ExtensionOrigin, StringComparison.OrdinalIgnoreCase))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }

        using var socket = await context.WebSockets.AcceptWebSocketAsync().ConfigureAwait(false);
        var clientId = Guid.NewGuid();
        _clients[clientId] = socket;

        try
        {
            await SendToSocketAsync(socket, _readyMessageFactory(), context.RequestAborted).ConfigureAwait(false);
            await ReceiveLoopAsync(socket, context.RequestAborted).ConfigureAwait(false);
        }
        finally
        {
            _clients.TryRemove(clientId, out _);
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                try
                {
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "closing", CancellationToken.None).ConfigureAwait(false);
                }
                catch { }
            }
        }
    }

    private async Task ReceiveLoopAsync(WebSocket socket, CancellationToken cancellationToken)
    {
        var buffer = new byte[64 * 1024];

        while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            using var payload = new MemoryStream();
            WebSocketReceiveResult result;
            do
            {
                result = await socket.ReceiveAsync(buffer, cancellationToken).ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close) return;
                if (result.MessageType != WebSocketMessageType.Text)
                    throw new InvalidDataException("Local bridge accepts text JSON messages only.");

                payload.Write(buffer, 0, result.Count);
                if (payload.Length > NativeHostConstants.MaxMessageBytes)
                    throw new InvalidDataException("Local bridge message exceeded the maximum accepted size.");
            }
            while (!result.EndOfMessage);

            payload.Position = 0;
            using var document = await JsonDocument.ParseAsync(payload, cancellationToken: cancellationToken).ConfigureAwait(false);
            NativeMessage message;
            try
            {
                message = NativeMessage.Parse(document.RootElement);
            }
            catch (Exception error)
            {
                FileLog.Write("Rejected malformed local bridge message", error);
                continue;
            }

            await _onMessage(message).ConfigureAwait(false);
        }
    }

    private static async Task SendToSocketAsync(WebSocket socket, object message, CancellationToken cancellationToken)
    {
        var payload = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(message, JsonOptions.Default));
        await socket.SendAsync(payload, WebSocketMessageType.Text, endOfMessage: true, cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var socket in _clients.Values)
        {
            try { socket.Abort(); } catch { }
        }
        _clients.Clear();

        try { await _app.StopAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false); } catch { }
        await _app.DisposeAsync().ConfigureAwait(false);
    }
}
