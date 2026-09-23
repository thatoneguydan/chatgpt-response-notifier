using System.Text.Json;

namespace ChatGPTResponseNotifier.Core;

public static class QuickContinueUpdateFeed
{
    public const string ManifestUrl = "https://raw.githubusercontent.com/thatoneguydan/chatgpt-response-notifier/main/standalone-quick-continue/update/manifest.json";

    private const string ReleasePathPrefix = "/thatoneguydan/chatgpt-response-notifier/releases/download/";

    public static PublicUpdateManifest Parse(string json)
    {
        if (string.IsNullOrWhiteSpace(json)) throw new InvalidDataException("Quick Continue update manifest is empty.");
        if (json.Length > 64 * 1024) throw new InvalidDataException("Quick Continue update manifest is too large.");

        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Quick Continue update manifest must be a JSON object.");
        if (!root.TryGetProperty("schemaVersion", out var schema) || schema.ValueKind != JsonValueKind.Number || schema.GetInt32() != 1)
            throw new InvalidDataException("Unsupported Quick Continue update manifest schema.");

        string RequiredString(string name)
        {
            if (!root.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
                throw new InvalidDataException($"Quick Continue update manifest field '{name}' is required.");
            var text = value.GetString()?.Trim() ?? string.Empty;
            if (string.IsNullOrWhiteSpace(text)) throw new InvalidDataException($"Quick Continue update manifest field '{name}' is empty.");
            return text;
        }

        var version = RequiredString("version");
        var sourceCommit = RequiredString("sourceCommit");
        var downloadUrl = RequiredString("downloadUrl");
        var sha256 = RequiredString("sha256").ToLowerInvariant();

        _ = PublicUpdateFeed.CompareVersions(version, "0.0.0");
        if (sourceCommit.Length != 40 || sourceCommit.Any(ch => !Uri.IsHexDigit(ch)))
            throw new InvalidDataException("Quick Continue update source commit is invalid.");
        if (sha256.Length != 64 || sha256.Any(ch => !Uri.IsHexDigit(ch)))
            throw new InvalidDataException("Quick Continue update SHA-256 is invalid.");

        if (!Uri.TryCreate(downloadUrl, UriKind.Absolute, out var uri)
            || !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(uri.Host, "github.com", StringComparison.OrdinalIgnoreCase)
            || !uri.AbsolutePath.StartsWith(ReleasePathPrefix, StringComparison.Ordinal)
            || !Path.GetFileName(uri.AbsolutePath).StartsWith("ChatGPT-Quick-Continue-", StringComparison.Ordinal)
            || !uri.AbsolutePath.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Quick Continue update download URL is outside the pinned release route.");
        }

        return new PublicUpdateManifest(
            Version: version,
            SourceCommit: sourceCommit,
            DownloadUrl: downloadUrl,
            Sha256: sha256);
    }
}
