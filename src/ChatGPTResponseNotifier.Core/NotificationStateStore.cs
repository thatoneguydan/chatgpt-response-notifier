using System.Text.Json;

namespace ChatGPTResponseNotifier.Core;

public sealed class NotificationStateStore
{
    private readonly string _path;

    public NotificationStateStore(string path)
    {
        _path = path;
    }

    public IReadOnlyList<NotificationRecord> Load()
    {
        try
        {
            if (!File.Exists(_path)) return Array.Empty<NotificationRecord>();
            var json = File.ReadAllText(_path);
            var state = JsonSerializer.Deserialize<PersistedState>(json, JsonOptions.Default);
            if (state?.SchemaVersion != NativeHostConstants.StateSchemaVersion) return Array.Empty<NotificationRecord>();
            var valid = new List<NotificationRecord>();
            foreach (var item in state.Notifications ?? Array.Empty<NotificationRecord>())
            {
                try
                {
                    item.Validate();
                    valid.Add(item);
                }
                catch
                {
                    // Drop invalid/corrupt entries rather than letting one record strand the helper.
                }
            }
            return valid;
        }
        catch
        {
            return Array.Empty<NotificationRecord>();
        }
    }

    public void Save(IEnumerable<NotificationRecord> notifications)
    {
        var directory = Path.GetDirectoryName(_path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        var items = notifications.ToArray();
        foreach (var item in items) item.Validate();

        var temp = _path + ".tmp";
        var json = JsonSerializer.Serialize(new PersistedState(NativeHostConstants.StateSchemaVersion, items), JsonOptions.Default);
        File.WriteAllText(temp, json);
        File.Move(temp, _path, overwrite: true);
    }

    private sealed record PersistedState(int SchemaVersion, NotificationRecord[] Notifications);
}
