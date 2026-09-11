using System.IO;
using System.Text.Json;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

internal sealed class DiagnosticEnvelope
{
    public DateTimeOffset ReceivedAt { get; init; }
    public JsonElement Diagnostic { get; init; }
}

internal sealed class DiagnosticsStore
{
    private const int MaxRecords = 400;
    private const long MaxFileBytes = 512 * 1024;
    private readonly object _sync = new();
    private readonly string _path;
    private readonly List<DiagnosticEnvelope> _records = new();

    public DiagnosticsStore(string path)
    {
        _path = path;
        Load();
    }

    public void Append(JsonElement diagnostic)
    {
        if (diagnostic.ValueKind != JsonValueKind.Object) return;
        AppendEnvelope(new DiagnosticEnvelope
        {
            ReceivedAt = DateTimeOffset.UtcNow,
            Diagnostic = diagnostic.Clone()
        });
    }

    public void AppendHost(object diagnostic)
    {
        try
        {
            Append(JsonSerializer.SerializeToElement(diagnostic, JsonOptions.Default));
        }
        catch
        {
            // Diagnostics must never affect notification delivery.
        }
    }

    public IReadOnlyList<DiagnosticEnvelope> Snapshot(int limit = 200)
    {
        lock (_sync)
        {
            var bounded = Math.Clamp(limit, 1, MaxRecords);
            return _records.Skip(Math.Max(0, _records.Count - bounded)).ToArray();
        }
    }

    private void AppendEnvelope(DiagnosticEnvelope envelope)
    {
        try
        {
            lock (_sync)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
                _records.Add(envelope);
                var trimmed = false;
                while (_records.Count > MaxRecords)
                {
                    _records.RemoveAt(0);
                    trimmed = true;
                }

                File.AppendAllText(
                    _path,
                    JsonSerializer.Serialize(envelope, JsonOptions.Default) + Environment.NewLine);

                var file = new FileInfo(_path);
                if (trimmed || (file.Exists && file.Length > MaxFileBytes)) RewriteLocked();
            }
        }
        catch
        {
            // Diagnostics must never affect notification delivery.
        }
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_path)) return;
            foreach (var line in File.ReadLines(_path).TakeLast(MaxRecords))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try
                {
                    var record = JsonSerializer.Deserialize<DiagnosticEnvelope>(line, JsonOptions.Default);
                    if (record is not null && record.Diagnostic.ValueKind == JsonValueKind.Object)
                        _records.Add(record);
                }
                catch
                {
                    // Ignore damaged historical lines and preserve newer records.
                }
            }
            if (new FileInfo(_path).Length > MaxFileBytes) RewriteLocked();
        }
        catch
        {
            // A damaged diagnostics file must not block helper startup.
        }
    }

    private void RewriteLocked()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var lines = _records.Select(record => JsonSerializer.Serialize(record, JsonOptions.Default));
        File.WriteAllLines(_path, lines);
    }
}
