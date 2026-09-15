using System.Text.Json;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

internal sealed class HiddenWindowIncidentRetention
{
    private const int MaxIncidents = 20;
    private const int MaxMetadataBytes = 128 * 1024;
    private readonly List<JsonElement> _incidents = new();
    private int _hostEvictions;

    public bool TryUpsert(JsonElement diagnostic)
    {
        if (diagnostic.ValueKind != JsonValueKind.Object) return false;
        if (!string.Equals(StringValue(diagnostic, "source", 40), "hidden-window-diagnostics", StringComparison.Ordinal)) return false;
        if (!string.Equals(StringValue(diagnostic, "status", 96), "incident-snapshot", StringComparison.Ordinal)) return false;
        if (!diagnostic.TryGetProperty("incident", out var incident) || incident.ValueKind != JsonValueKind.Object) return false;
        var id = StringValue(incident, "incidentId", 80);
        if (string.IsNullOrWhiteSpace(id)) return false;

        for (var index = _incidents.Count - 1; index >= 0; index--)
        {
            if (string.Equals(StringValue(_incidents[index], "incidentId", 80), id, StringComparison.Ordinal))
                _incidents.RemoveAt(index);
        }
        _incidents.Add(incident.Clone());
        Trim();
        return true;
    }

    public void Load(JsonElement root)
    {
        _incidents.Clear();
        _hostEvictions = 0;
        if (!root.TryGetProperty("hiddenWindowDiagnostics", out var hidden) || hidden.ValueKind != JsonValueKind.Object) return;
        _hostEvictions = (int)Math.Clamp(IntegerValue(hidden, "hostEvictions") ?? 0, 0, int.MaxValue);
        if (!hidden.TryGetProperty("incidents", out var items) || items.ValueKind != JsonValueKind.Array) return;
        foreach (var item in items.EnumerateArray().TakeLast(MaxIncidents))
        {
            if (item.ValueKind == JsonValueKind.Object) _incidents.Add(item.Clone());
        }
        Trim();
    }

    public object Snapshot() => new
    {
        schemaVersion = 1,
        maxIncidents = MaxIncidents,
        maxTransitionsPerIncident = 48,
        maxMetadataBytes = MaxMetadataBytes,
        incidentCount = _incidents.Count,
        metadataBytes = MetadataBytes(),
        hostEvictions = _hostEvictions,
        incidents = _incidents.ToArray()
    };

    private void Trim()
    {
        while (_incidents.Count > MaxIncidents || MetadataBytes() > MaxMetadataBytes)
        {
            if (_incidents.Count == 0) break;
            _incidents.RemoveAt(0);
            _hostEvictions++;
        }
    }

    private int MetadataBytes()
    {
        try { return JsonSerializer.SerializeToUtf8Bytes(_incidents, JsonOptions.Default).Length; }
        catch { return MaxMetadataBytes + 1; }
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
}
