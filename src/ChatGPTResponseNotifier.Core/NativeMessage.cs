using System.Text.Json;

namespace ChatGPTResponseNotifier.Core;

public sealed class NativeMessage
{
    public string Type { get; init; } = string.Empty;
    public string? RequestId { get; init; }
    public string? ConversationId { get; init; }
    public string? ConversationUrl { get; init; }
    public string? NotificationId { get; init; }
    public string? WindowTitle { get; init; }
    public int? WindowLeft { get; init; }
    public int? WindowTop { get; init; }
    public int? WindowWidth { get; init; }
    public int? WindowHeight { get; init; }
    public NotificationRecord? Notification { get; init; }

    public static NativeMessage Parse(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Native message must be a JSON object.");

        string? ReadString(string name) =>
            root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;

        int? ReadInt32(string name) =>
            root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)
                ? number
                : null;

        NotificationRecord? notification = null;
        if (root.TryGetProperty("notification", out var notificationNode) && notificationNode.ValueKind == JsonValueKind.Object)
        {
            notification = JsonSerializer.Deserialize<NotificationRecord>(notificationNode.GetRawText(), JsonOptions.Default)
                ?? throw new InvalidDataException("Notification payload could not be parsed.");
            notification.Validate();
        }

        var message = new NativeMessage
        {
            Type = ReadString("type") ?? string.Empty,
            RequestId = ReadString("requestId"),
            ConversationId = ReadString("conversationId"),
            ConversationUrl = ReadString("conversationUrl"),
            NotificationId = ReadString("notificationId"),
            WindowTitle = ReadString("windowTitle"),
            WindowLeft = ReadInt32("windowLeft"),
            WindowTop = ReadInt32("windowTop"),
            WindowWidth = ReadInt32("windowWidth"),
            WindowHeight = ReadInt32("windowHeight"),
            Notification = notification
        };

        if (string.IsNullOrWhiteSpace(message.Type)) throw new InvalidDataException("Native message type is required.");
        return message;
    }
}

public static class JsonOptions
{
    public static readonly JsonSerializerOptions Default = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false
    };
}
