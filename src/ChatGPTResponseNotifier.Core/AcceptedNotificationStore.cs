using System.Text.Json;

namespace ChatGPTResponseNotifier.Core;

public sealed class AcceptedNotificationStore
{
    private const int SchemaVersion = 1;
    private const int MaxAcceptedIds = 512;
    private readonly string _path;
    private readonly object _gate = new();

    public AcceptedNotificationStore(string path)
    {
        _path = path;
    }

    public bool Contains(string notificationId)
    {
        if (string.IsNullOrWhiteSpace(notificationId)) return false;
        lock (_gate)
        {
            return LoadUnsafe().Any(item => string.Equals(item.Id, notificationId, StringComparison.Ordinal));
        }
    }

    public void Remember(string notificationId)
    {
        if (string.IsNullOrWhiteSpace(notificationId)) throw new ArgumentException("Notification ID is required.", nameof(notificationId));
        lock (_gate)
        {
            var items = LoadUnsafe().ToList();
            var now = DateTimeOffset.UtcNow;
            items.RemoveAll(item => string.Equals(item.Id, notificationId, StringComparison.Ordinal));
            items.Add(new AcceptedNotification(notificationId, now));
            items = items.OrderByDescending(item => item.AcceptedAt).Take(MaxAcceptedIds).ToList();
            SaveUnsafe(items);
        }
    }

    private IReadOnlyList<AcceptedNotification> LoadUnsafe()
    {
        try
        {
            if (!File.Exists(_path)) return Array.Empty<AcceptedNotification>();
            var state = JsonSerializer.Deserialize<PersistedAcceptedState>(File.ReadAllText(_path), JsonOptions.Default);
            if (state?.SchemaVersion != SchemaVersion) return Array.Empty<AcceptedNotification>();
            return (state.Accepted ?? Array.Empty<AcceptedNotification>())
                .Where(item => !string.IsNullOrWhiteSpace(item.Id))
                .OrderByDescending(item => item.AcceptedAt)
                .Take(MaxAcceptedIds)
                .ToArray();
        }
        catch
        {
            return Array.Empty<AcceptedNotification>();
        }
    }

    private void SaveUnsafe(IEnumerable<AcceptedNotification> accepted)
    {
        var directory = Path.GetDirectoryName(_path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        var temp = _path + ".tmp";
        var state = new PersistedAcceptedState(SchemaVersion, accepted.Take(MaxAcceptedIds).ToArray());
        File.WriteAllText(temp, JsonSerializer.Serialize(state, JsonOptions.Default));
        File.Move(temp, _path, overwrite: true);
    }

    private sealed record AcceptedNotification(string Id, DateTimeOffset AcceptedAt);
    private sealed record PersistedAcceptedState(int SchemaVersion, AcceptedNotification[] Accepted);
}
