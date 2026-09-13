using System.Diagnostics;
using System.IO;
using System.Text.Json;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

internal sealed class RuntimeEvidencePublisher
{
    private const int MaxDiagnostics = 200;
    private readonly object _sync = new();
    private readonly string _root;
    private readonly string _path;
    private readonly List<JsonElement> _diagnostics = new();
    private string? _loadedExtensionVersion;
    private string? _extensionRuntimeSuffix;

    public RuntimeEvidencePublisher()
    {
        _root = Path.Combine(NativeHostInstaller.InstallRoot, "Evidence");
        _path = Path.Combine(_root, "runtime-evidence.json");
        InitializeReadOnlyGlassAccess();
        LoadExisting();
        Publish();
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

                if (StringValue(diagnostic, "source", 40) == "extension-runtime"
                    && StringValue(diagnostic, "status", 96) == "worker-connected")
                {
                    _loadedExtensionVersion = StringValue(diagnostic, "extensionVersion", 32);
                    _extensionRuntimeSuffix = Suffix(StringValue(diagnostic, "correlationId", 80));
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
        var payload = new
        {
            schemaVersion = 1,
            observedAtUtc = DateTimeOffset.UtcNow,
            installedVersion = installed.version,
            sourceCommit = installed.sourceCommit,
            installedManifestVersion = BundleInstaller.ReadInstalledExtensionVersion(),
            helperProcessId = Environment.ProcessId,
            helperSessionId = Process.GetCurrentProcess().SessionId,
            transport = "localhost-websocket",
            loadedExtensionVersion = _loadedExtensionVersion,
            extensionRuntimeSuffix = _extensionRuntimeSuffix,
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
            _loadedExtensionVersion = StringValue(root, "loadedExtensionVersion", 32);
            _extensionRuntimeSuffix = StringValue(root, "extensionRuntimeSuffix", 8);
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
            attempt = IntegerValue(input, "attempt"),
            frozen = BooleanValue(input, "frozen"),
            discarded = BooleanValue(input, "discarded"),
            presented = BooleanValue(input, "presented"),
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

    private static string? Suffix(string? value)
    {
        var text = (value ?? string.Empty).Trim();
        if (text.Length == 0) return null;
        return text.Length <= 8 ? text : text[^8..];
    }
}
