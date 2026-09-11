namespace ChatGPTResponseNotifier.Core;

public sealed record NotificationRecord(
    string Id,
    string ConversationId,
    string ConversationUrl,
    string Title,
    string Preview,
    DateTimeOffset CompletedAt)
{
    // Kept outside the positional constructor so unresolved notifications saved
    // by v0.6.0 deserialize with an empty code and survive an update handoff.
    public string StatusCode { get; init; } = string.Empty;

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

        // The browser tab title is intentionally preserved in full. Preview data
        // remains bounded because it is retained for popup/future toast layouts.
        if (Preview.Length > 2000) throw new InvalidDataException("Notification preview is too long.");
        if (StatusCode.Length > 64 || StatusCode.Any(character =>
            !(character is >= 'A' and <= 'Z') &&
            !(character is >= '0' and <= '9') &&
            character != '_'))
        {
            throw new InvalidDataException("Notification status code is invalid.");
        }
    }
}
