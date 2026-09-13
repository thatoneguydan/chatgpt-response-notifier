using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

internal sealed class NativeHostApplication : Application
{
    private readonly CancellationTokenSource _shutdown = new();
    private LocalBridgeServer? _bridgeServer;
    private ToastManager? _toastManager;
    private PublicUpdateService? _updateService;
    private DiagnosticsStore? _diagnosticsStore;
    private RuntimeEvidencePublisher? _runtimeEvidencePublisher;
    private Task? _updateLoop;

    public new int Run()
    {
        ShutdownMode = ShutdownMode.OnExplicitShutdown;
        Startup += OnStartup;
        Exit += OnExit;
        return base.Run();
    }

    private async void OnStartup(object sender, StartupEventArgs e)
    {
        try
        {
            _runtimeEvidencePublisher = new RuntimeEvidencePublisher();
            _diagnosticsStore = new DiagnosticsStore(
                Path.Combine(NativeHostInstaller.DataRoot, "diagnostics.jsonl"),
                _runtimeEvidencePublisher.Append);
            _diagnosticsStore.AppendHost(new
            {
                source = "host",
                status = "host-started",
                observedAt = DateTimeOffset.UtcNow,
                extensionVersion = BundleInstaller.ReadInstalledExtensionVersion()
            });

            var store = new NotificationStateStore(Path.Combine(NativeHostInstaller.DataRoot, "pending.json"));
            var acceptedStore = new AcceptedNotificationStore(Path.Combine(NativeHostInstaller.DataRoot, "accepted-notifications.json"));
            _toastManager = new ToastManager(store, acceptedStore, SendEventAsync);

            try
            {
                _toastManager.Restore();
            }
            catch (Exception error)
            {
                FileLog.Write("Persisted toast restoration failed; localhost bridge will continue without restored windows", error);
            }

            _updateService = new PublicUpdateService(status => SendEventAsync(new
            {
                type = "update.status",
                updateStatus = status
            }));

            _bridgeServer = await LocalBridgeServer.StartAsync(
                HandleBridgeMessageAsync,
                CreateReadyMessage,
                _shutdown.Token);

            var processPath = Environment.ProcessPath;
            if (!string.IsNullOrWhiteSpace(processPath))
            {
                try { StartupRegistration.Register(processPath); } catch (Exception error) { FileLog.Write("Could not refresh per-user startup registration", error); }
            }

            _runtimeEvidencePublisher.Publish();
            _updateLoop = RunUpdateLoopAsync();
        }
        catch (Exception error)
        {
            FileLog.Write("Local bridge startup failed", error);
            Shutdown(1);
        }
    }

    private async void OnExit(object? sender, ExitEventArgs e)
    {
        _shutdown.Cancel();
        if (_bridgeServer is not null)
        {
            try { await _bridgeServer.DisposeAsync(); } catch { }
            _bridgeServer = null;
        }

        _updateService?.Dispose();
        _updateService = null;
        _diagnosticsStore = null;
        _runtimeEvidencePublisher = null;
        _shutdown.Dispose();
    }

    private object CreateReadyMessage() => new
    {
        type = "host.ready",
        restored = _toastManager?.Count ?? 0,
        installedExtensionVersion = BundleInstaller.ReadInstalledExtensionVersion(),
        transport = "localhost-websocket",
        diagnosticsAvailable = true,
        updateStatus = _updateService?.Status
    };

    private async Task HandleBridgeMessageAsync(NativeMessage message)
    {
        await Dispatcher.InvokeAsync(() => HandleMessage(message));
    }

    private void HandleMessage(NativeMessage message)
    {
        switch (message.Type)
        {
            case "toast.show" when message.Notification is not null:
            {
                _diagnosticsStore?.AppendHost(new
                {
                    source = "host",
                    status = "toast-received",
                    observedAt = DateTimeOffset.UtcNow,
                    conversationSuffix = Suffix(message.Notification.ConversationId),
                    notificationSuffix = Suffix(message.Notification.Id)
                });

                var showResult = _toastManager!.Show(message.Notification);

                _diagnosticsStore?.AppendHost(new
                {
                    source = "host",
                    status = showResult.Presented ? "toast-presented" : "toast-idempotent-accepted",
                    observedAt = DateTimeOffset.UtcNow,
                    conversationSuffix = Suffix(message.Notification.ConversationId),
                    notificationSuffix = Suffix(message.Notification.Id),
                    presented = showResult.Presented,
                    presentationState = showResult.PresentationState
                });

                _ = SendEventAsync(new
                {
                    type = "toast.accepted",
                    requestId = message.RequestId,
                    notificationId = message.Notification.Id,
                    accepted = showResult.Accepted,
                    presented = showResult.Presented,
                    presentationState = showResult.PresentationState
                });
                break;
            }
            case "toast.dismissConversation" when !string.IsNullOrWhiteSpace(message.ConversationId):
                _toastManager!.DismissConversation(message.ConversationId);
                break;
            case "toast.dismissEvent" when !string.IsNullOrWhiteSpace(message.NotificationId):
                _toastManager!.DismissEvent(message.NotificationId);
                break;
            case "toast.clearAll":
                _toastManager!.ClearAll();
                break;
            case "window.foreground":
                var foregrounded = ChromeWindowForeground.TryForeground(
                    message.WindowTitle,
                    message.WindowLeft,
                    message.WindowTop,
                    message.WindowWidth,
                    message.WindowHeight);
                _ = SendEventAsync(new
                {
                    type = "window.foregroundResult",
                    requestId = message.RequestId,
                    success = foregrounded
                });
                break;
            case "ping":
                _ = SendEventAsync(new
                {
                    type = "pong",
                    requestId = message.RequestId,
                    installedExtensionVersion = BundleInstaller.ReadInstalledExtensionVersion(),
                    transport = "localhost-websocket",
                    diagnosticsAvailable = true,
                    updateStatus = _updateService?.Status
                });
                break;
            case "update.check":
                _ = CheckForPublicUpdateAsync(message.RequestId);
                break;
            case "diagnostics.event" when message.Diagnostic is JsonElement diagnostic:
                _diagnosticsStore?.Append(DiagnosticsSanitizer.Event(diagnostic));
                break;
            case "diagnostics.get":
                _ = SendDiagnosticsAsync(message.RequestId, message.Limit);
                break;
            case "diagnostics.probe":
                _ = SendEventAsync(new
                {
                    type = "diagnostics.probe",
                    requestId = message.RequestId
                });
                break;
            case "diagnostics.probeResult" when message.Probe is JsonElement probe:
            {
                var safeProbe = DiagnosticsSanitizer.Probe(probe);
                _diagnosticsStore?.AppendHost(new
                {
                    source = "host",
                    status = "probe-result-received",
                    observedAt = DateTimeOffset.UtcNow
                });
                _ = SendEventAsync(new
                {
                    type = "diagnostics.probeResult",
                    requestId = message.RequestId,
                    probe = safeProbe
                });
                break;
            }
            default:
                FileLog.Write($"Ignored unsupported localhost bridge message type '{message.Type}'.");
                break;
        }
    }

    private async Task SendDiagnosticsAsync(string? requestId, int? limit)
    {
        var records = _diagnosticsStore?.Snapshot(limit ?? 200) ?? Array.Empty<DiagnosticEnvelope>();
        await SendEventAsync(new
        {
            type = "diagnostics.result",
            requestId,
            installedExtensionVersion = BundleInstaller.ReadInstalledExtensionVersion(),
            hostProcessId = Environment.ProcessId,
            records
        }).ConfigureAwait(false);
    }

    private static string Suffix(string? value)
    {
        var text = (value ?? string.Empty).Trim();
        return text.Length <= 8 ? text : text[^8..];
    }

    private async Task RunUpdateLoopAsync()
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(30), _shutdown.Token).ConfigureAwait(false);
            while (!_shutdown.IsCancellationRequested)
            {
                await CheckForPublicUpdateAsync(null).ConfigureAwait(false);
                await Task.Delay(TimeSpan.FromHours(1), _shutdown.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            FileLog.Write("Public update loop stopped unexpectedly", error);
        }
    }

    private async Task CheckForPublicUpdateAsync(string? requestId)
    {
        var updater = _updateService;
        if (updater is null)
        {
            if (!string.IsNullOrWhiteSpace(requestId))
            {
                await SendEventAsync(new
                {
                    type = "update.result",
                    requestId,
                    updateStatus = new UpdateStatusSnapshot("error", BundleInstaller.ReadInstalledExtensionVersion() ?? "0.0.0", Error: "Update service is unavailable.")
                }).ConfigureAwait(false);
            }
            return;
        }

        UpdateCheckResult result;
        try
        {
            result = await updater.CheckAndInstallAsync(_shutdown.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
            return;
        }

        if (!string.IsNullOrWhiteSpace(requestId))
        {
            await SendEventAsync(new
            {
                type = "update.result",
                requestId,
                updateStatus = result.Status
            }).ConfigureAwait(false);
        }

        if (result.InstalledBundle is null) return;

        try
        {
            StartupRegistration.Register(result.InstalledBundle.HostExecutablePath);
            ScheduleReplacementIfNeeded(result.InstalledBundle.HostExecutablePath);
        }
        catch (Exception error)
        {
            FileLog.Write("Could not activate installed public update", error);
        }
    }

    private void ScheduleReplacementIfNeeded(string installedHostPath)
    {
        var currentPath = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(currentPath)) return;
        if (string.Equals(Path.GetFullPath(currentPath), Path.GetFullPath(installedHostPath), StringComparison.OrdinalIgnoreCase)) return;

        var startInfo = new ProcessStartInfo(installedHostPath)
        {
            UseShellExecute = false,
            CreateNoWindow = true
        };
        startInfo.ArgumentList.Add("--wait-for-pid");
        startInfo.ArgumentList.Add(Environment.ProcessId.ToString());

        Process.Start(startInfo);
        Dispatcher.BeginInvoke(() => Shutdown());
    }

    private async Task SendEventAsync(object message)
    {
        var bridge = _bridgeServer;
        var sent = bridge is null ? 0 : await bridge.SendAsync(message, _shutdown.Token).ConfigureAwait(false);
        if (sent > 0) return;

        try
        {
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(message, JsonOptions.Default));
            var root = document.RootElement;
            if (root.TryGetProperty("type", out var typeNode)
                && string.Equals(typeNode.GetString(), "toast.clicked", StringComparison.Ordinal)
                && root.TryGetProperty("conversationUrl", out var urlNode)
                && urlNode.ValueKind == JsonValueKind.String)
            {
                var url = urlNode.GetString();
                if (!string.IsNullOrWhiteSpace(url)
                    && Uri.TryCreate(url, UriKind.Absolute, out var uri)
                    && string.Equals(uri.Host, "chatgpt.com", StringComparison.OrdinalIgnoreCase))
                {
                    Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
                }
            }
        }
        catch (Exception error)
        {
            FileLog.Write("Local bridge event fallback failed", error);
        }
    }
}
