namespace ChatGPTResponseNotifier.Core;

public sealed record NotificationRecord(
    string Id,
    string ConversationId,
    string ConversationUrl,
    string Title,
    string Preview,
    DateTimeOffset CompletedAt)
{
    public void Validate()
    {
        if (string.IsNullOrWhiteSpace(Id)) throw new InvalidDataException("Notification id is required.");
        if (string.IsNullOrWhiteSpace(ConversationId)) throw new InvalidDataException("Conversation id is required.");
        if (!Uri.TryCreate(ConversationUrl, UriKind.Absolute, out var uri) ||
            !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(uri.Host, "chatgpt.com", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Conversation URL must be an absolute https://chatgpt.com URL.");
        }
        if (Title.Length > 300) throw new InvalidDataException("Notification title is too long.");
        if (Preview.Length > 2000) throw new InvalidDataException("Notification preview is too long.");
    }
}
