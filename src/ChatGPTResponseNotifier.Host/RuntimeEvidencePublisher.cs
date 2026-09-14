using System.Diagnostics;
using System.IO;
using System.Text.Json;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

internal sealed class RuntimeEvidencePublisher
{
    private const int MaxDiagnostics = 200;
    private static readonly TimeSpan LiveFreshness = TimeSpan.FromSeconds(60);
    private readonly object _sync = new();
    private readonly string _root;
    private readonly string _path;
    private readonly List<JsonElement> _diagnostics = new();
    private string? _historicalExtensionVersion;
    private string? _historicalExtensionRuntimeSuffix;
    private DateTimeOffset? _historicalExtensionObservedAtUtc;
    private string? _currentExtensionVersion;
    private string? _currentExtensionRuntimeSuffix;
    private DateTimeOffset? _currentExtensionObservedAtUtc;
    private DateTimeOffset? _bridgeLastSeenAtUtc;
    private int _bridgeClientCount;

    public RuntimeEvidencePublisher()
    {
        _root = Path.Combine(NativeHostInstaller.InstallRoot, "Evidence");
        _path = Path.Combine(_root, "runtime-evidence.json");
        InitializeReadOnlyGlassAccess();
        LoadExisting();
        Publish();
    }

    public void ObserveBridgeClientCount(int count)
    {
        try
        {
            lock (_sync)
            {
                _bridgeClientCount = Math.Max(0, count);
                if (_bridgeClientCount > 0) _bridgeLastSeenAtUtc = DateTimeOffset.UtcNow;
                PublishLocked();
            }
        }
        catch { }
    }

    public void ObserveBridgeActivity()
    {
        try
        {
            lock (_sync)
            {
                if (_bridgeClientCount > 0) _bridgeLastSeenAtUtc = DateTimeOffset.UtcNow;
                PublishLocked();
            }
        }
        catch { }
    }

    public void Append(JsonElement diagnostic)
    {
        if (diagnostic.ValueKind != JsonValueKind.Object) return;
        try
        {
            var safe = ProjectDiagnostic(diagnostic);
            lock (_sync)
            {
                _diagnostics.Add(safe);
                while (_diagnostics.Count > MaxDiagnostics) _diagnostics.RemoveAt(0);

                var source = StringValue(diagnostic, "source", 40);
                var status = StringValue(diagnostic, "status", 96);
                if (source == "extension-runtime" && status is "worker-connected" or "worker-alive")
                {
                    var version = StringValue(diagnostic, "extensionVersion", 32);
                    var runtimeSuffix = Suffix(StringValue(diagnostic, "correlationId", 80));
                    if (!string.IsNullOrWhiteSpace(version))
                    {
                        _currentExtensionVersion = version;
                        _currentExtensionRuntimeSuffix = runtimeSuffix;
                        _currentExtensionObservedAtUtc = DateTimeOffset.UtcNow;
                        _historicalExtensionVersion = version;
                        _historicalExtensionRuntimeSuffix = runtimeSuffix;
                        _historicalExtensionObservedAtUtc = _currentExtensionObservedAtUtc;
                    }
                }
                PublishLocked();
            }
        }
        catch
        {
            // Evidence is diagnostic-only and must never affect notification delivery.
        }
    }

    public void Publish()
    {
        try
        {
            lock (_sync) PublishLocked();
        }
        catch
        {
            // Evidence is diagnostic-only and must never affect helper startup.
        }
    }

    private void PublishLocked()
    {
        Directory.CreateDirectory(_root);
        var installed = ReadInstallIdentity();
        var now = DateTimeOffset.UtcNow;
        var bridgeFresh = _bridgeClientCount > 0
            && _bridgeLastSeenAtUtc.HasValue
            && now - _bridgeLastSeenAtUtc.Value <= LiveFreshness;
        var identityFresh = !string.IsNullOrWhiteSpace(_currentExtensionVersion)
            && _currentExtensionObservedAtUtc.HasValue
            && now - _currentExtensionObservedAtUtc.Value <= LiveFreshness;
        var extensionConnectionLive = bridgeFresh && identityFresh;
        var payload = new
        {
            // Keep the envelope at schema v1 for the trusted Glass deployment
            // contract. The explicit v2 capability below gates the new freshness
            // semantics, so legacy schema-v1 evidence cannot be mistaken for live.
            schemaVersion = 1,
            observedAtUtc = now,
            installedVersion = installed.version,
            sourceCommit = installed.sourceCommit,
            installedManifestVersion = BundleInstaller.ReadInstalledExtensionVersion(),
            helperProcessId = Environment.ProcessId,
            helperSessionId = Process.GetCurrentProcess().SessionId,
            transport = "localhost-websocket",
            observationCapability = "extension-bridge-runtime-self-report-v2",
            livenessWindowSeconds = (int)LiveFreshness.TotalSeconds,
            bridgeClientCount = _bridgeClientCount,
            bridgeConnected = _bridgeClientCount > 0,
            bridgeLastSeenAtUtc = _bridgeLastSeenAtUtc,
            currentExtensionVersion = _currentExtensionVersion,
            currentExtensionRuntimeSuffix = _currentExtensionRuntimeSuffix,
            currentExtensionObservedAtUtc = _currentExtensionObservedAtUtc,
            extensionConnectionLive,
            historicalExtensionVersion = _historicalExtensionVersion,
            historicalExtensionRuntimeSuffix = _historicalExtensionRuntimeSuffix,
            historicalExtensionObservedAtUtc = _historicalExtensionObservedAtUtc,
            // Legacy compatibility fields are deliberately live-only. A helper restart
            // can never make restored identity look current again.
            loadedExtensionVersion = extensionConnectionLive ? _currentExtensionVersion : null,
            extensionRuntimeSuffix = extensionConnectionLive ? _currentExtensionRuntimeSuffix : null,
            diagnostics = _diagnostics
        };

        var temp = _path + ".next";
        File.WriteAllText(temp, JsonSerializer.Serialize(payload, new JsonSerializerOptions(JsonOptions.Default) { WriteIndented = true }));
        File.Move(temp, _path, overwrite: true);
    }

    private (string? version, string? sourceCommit) ReadInstallIdentity()
    {
        try
        {
            if (!File.Exists(NativeHostInstaller.InstallStatePath)) return (null, null);
            using var document = JsonDocument.Parse(File.ReadAllText(NativeHostInstaller.InstallStatePath));
            var root = document.RootElement;
            return (
                StringValue(root, "version", 32),
                StringValue(root, "sourceCommit", 64));
        }
        catch
        {
            return (null, null);
        }
    }

    private void InitializeReadOnlyGlassAccess()
    {
        try
        {
            Directory.CreateDirectory(_root);
            var startInfo = new ProcessStartInfo("icacls.exe")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            startInfo.ArgumentList.Add(_root);
            startInfo.ArgumentList.Add("/grant");
            startInfo.ArgumentList.Add("*S-1-5-20:(OI)(CI)(RX)");
            startInfo.ArgumentList.Add("/Q");
            using var process = Process.Start(startInfo);
            if (process is null) return;
            if (!process.WaitForExit(5000))
            {
                try { process.Kill(entireProcessTree: true); } catch { }
            }
        }
        catch
        {
            // Failure to expose the bounded evidence surface is reported later by
            // the external collector; never weaken the private Data directory.
        }
    }

    private void LoadExisting()
    {
        try
        {
            if (!File.Exists(_path)) return;
            using var document = JsonDocument.Parse(File.ReadAllText(_path));
            var root = document.RootElement;

            _historicalExtensionVersion = StringValue(root, "historicalExtensionVersion", 32)
                ?? StringValue(root, "currentExtensionVersion", 32)
                ?? StringValue(root, "loadedExtensionVersion", 32);
            _historicalExtensionRuntimeSuffix = StringValue(root, "historicalExtensionRuntimeSuffix", 8)
                ?? StringValue(root, "currentExtensionRuntimeSuffix", 8)
                ?? StringValue(root, "extensionRuntimeSuffix", 8);
            _historicalExtensionObservedAtUtc = DateValue(root, "historicalExtensionObservedAtUtc")
                ?? DateValue(root, "currentExtensionObservedAtUtc")
                ?? DateValue(root, "observedAtUtc");

            // Deliberately do not restore current identity, bridge count, or liveness.
            // They must be re-observed in this helper process lifetime.
            _currentExtensionVersion = null;
            _currentExtensionRuntimeSuffix = null;
            _currentExtensionObservedAtUtc = null;
            _bridgeLastSeenAtUtc = null;
            _bridgeClientCount = 0;

            if (!root.TryGetProperty("diagnostics", out var diagnostics) || diagnostics.ValueKind != JsonValueKind.Array) return;
            foreach (var item in diagnostics.EnumerateArray().TakeLast(MaxDiagnostics))
            {
                if (item.ValueKind == JsonValueKind.Object) _diagnostics.Add(item.Clone());
            }
        }
        catch
        {
            _diagnostics.Clear();
        }
    }

    private static JsonElement ProjectDiagnostic(JsonElement input)
    {
        var safe = new
        {
            source = StringValue(input, "source", 40),
            status = StringValue(input, "status", 96),
            observedAt = StringValue(input, "observedAt", 64),
            extensionVersion = StringValue(input, "extensionVersion", 32),
            correlationId = StringValue(input, "correlationId", 80),
            tabId = IntegerValue(input, "tabId"),
            statusCode = IntegerValue(input, "statusCode"),
            attempt = IntegerValue(input, "attempt"),
            elapsedMs = IntegerValue(input, "elapsedMs"),
            queuedMessages = IntegerValue(input, "queuedMessages"),
            frozen = BooleanValue(input, "frozen"),
            discarded = BooleanValue(input, "discarded"),
            deliveredNow = BooleanValue(input, "deliveredNow"),
            presented = BooleanValue(input, "presented"),
            triggerPath = StringValue(input, "triggerPath", 160),
            reason = StringValue(input, "reason", 160),
            captureSource = StringValue(input, "captureSource", 160),
            presentationState = StringValue(input, "presentationState", 48),
            conversationSuffix = StringValue(input, "conversationSuffix", 8),
            notificationSuffix = StringValue(input, "notificationSuffix", 8),
            chromeDocumentSuffix = StringValue(input, "chromeDocumentSuffix", 8),
            statusRuntimeSuffix = StringValue(input, "statusRuntimeSuffix", 8),
            monitorRuntimeSuffix = StringValue(input, "monitorRuntimeSuffix", 8)
        };
        return JsonSerializer.SerializeToElement(safe, JsonOptions.Default);
    }

    private static string? StringValue(JsonElement root, string name, int maxLength)
    {
        if (!root.TryGetProperty(name, out var node) || node.ValueKind != JsonValueKind.String) return null;
        var value = (node.GetString() ?? string.Empty).Replace('\r', ' ').Replace('\n', ' ').Replace('\t', ' ').Trim();
        if (value.Length == 0) return null;
        return value.Length <= maxLength ? value : value[..maxLength];
    }

    private static long? IntegerValue(JsonElement root, string name)
    {
        return root.TryGetProperty(name, out var node)
            && node.ValueKind == JsonValueKind.Number
            && node.TryGetInt64(out var value)
                ? value
                : null;
    }

    private static bool? BooleanValue(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var node)) return null;
        return node.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null
        };
    }

    private static DateTimeOffset? DateValue(JsonElement root, string name)
    {
        var value = StringValue(root, name, 64);
        return DateTimeOffset.TryParse(value, out var parsed) ? parsed : null;
    }

    private static string? Suffix(string? value)
    {
        var text = (value ?? string.Empty).Trim();
        if (text.Length == 0) return null;
        return text.Length <= 8 ? text : text[^8..];
    }
}
