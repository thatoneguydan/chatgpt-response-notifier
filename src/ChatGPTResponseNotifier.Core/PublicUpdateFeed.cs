using System.Text.Json;

namespace ChatGPTResponseNotifier.Core;

public sealed record PublicUpdateManifest(string Version, string SourceCommit, string DownloadUrl, string Sha256);

public static class PublicUpdateFeed
{
    public const string RepositoryFullName = "thatoneguydan/chatgpt-response-notifier";
    public const string ManifestUrl = "https://api.github.com/repos/thatoneguydan/chatgpt-response-notifier/contents/update/manifest.json";

    private const string ReleasePathPrefix = "/thatoneguydan/chatgpt-response-notifier/releases/download/";

    public static PublicUpdateManifest Parse(string json)
    {
        if (string.IsNullOrWhiteSpace(json)) throw new InvalidDataException("Public update manifest is empty.");
        if (json.Length > 64 * 1024) throw new InvalidDataException("Public update manifest is too large.");

        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Public update manifest must be a JSON object.");
        if (!root.TryGetProperty("schemaVersion", out var schema) || schema.ValueKind != JsonValueKind.Number || schema.GetInt32() != 1)
            throw new InvalidDataException("Unsupported public update manifest schema.");

        string RequiredString(string name)
        {
            if (!root.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
                throw new InvalidDataException($"Public update manifest field '{name}' is required.");
            var text = value.GetString()?.Trim() ?? string.Empty;
            if (string.IsNullOrWhiteSpace(text)) throw new InvalidDataException($"Public update manifest field '{name}' is empty.");
            return text;
        }

        var version = RequiredString("version");
        var sourceCommit = RequiredString("sourceCommit");
        var downloadUrl = RequiredString("downloadUrl");
        var sha256 = RequiredString("sha256").ToLowerInvariant();

        if (!TryParseVersion(version, out _)) throw new InvalidDataException("Public update version is invalid.");
        if (sourceCommit.Length != 40 || sourceCommit.Any(ch => !Uri.IsHexDigit(ch)))
            throw new InvalidDataException("Public update source commit is invalid.");
        if (sha256.Length != 64 || sha256.Any(ch => !Uri.IsHexDigit(ch)))
            throw new InvalidDataException("Public update SHA-256 is invalid.");

        if (!Uri.TryCreate(downloadUrl, UriKind.Absolute, out var uri)
            || !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(uri.Host, "github.com", StringComparison.OrdinalIgnoreCase)
            || !uri.AbsolutePath.StartsWith(ReleasePathPrefix, StringComparison.Ordinal)
            || !Path.GetFileName(uri.AbsolutePath).StartsWith("ChatGPT-Response-Notifier-", StringComparison.Ordinal)
            || !uri.AbsolutePath.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Public update download URL is outside the pinned release route.");
        }

        return new PublicUpdateManifest(
            Version: version,
            SourceCommit: sourceCommit,
            DownloadUrl: downloadUrl,
            Sha256: sha256);
    }

    public static int CompareVersions(string left, string right)
    {
        if (!TryParseVersion(left, out var a) || !TryParseVersion(right, out var b))
            throw new InvalidDataException("Version comparison requires numeric dot-separated versions.");

        var length = Math.Max(a.Length, b.Length);
        for (var index = 0; index < length; index += 1)
        {
            var av = index < a.Length ? a[index] : 0;
            var bv = index < b.Length ? b[index] : 0;
            if (av == bv) continue;
            return av > bv ? 1 : -1;
        }
        return 0;
    }

    private static bool TryParseVersion(string value, out int[] parts)
    {
        parts = Array.Empty<int>();
        var tokens = (value ?? string.Empty).Trim().Split('.', StringSplitOptions.RemoveEmptyEntries);
        if (tokens.Length < 2 || tokens.Length > 4) return false;
        var parsed = new int[tokens.Length];
        for (var index = 0; index < tokens.Length; index += 1)
        {
            if (!int.TryParse(tokens[index], out parsed[index]) || parsed[index] < 0) return false;
        }
        parts = parsed;
        return true;
    }
}
