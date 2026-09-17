using System.IO;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

/// <summary>
/// Publishes a bounded, read-only identity comparison for the known notifier
/// unpacked registrations. Chrome derives an unpacked extension ID from the
/// exact native path string when no manifest key is present. The raw persisted
/// path never leaves the interactive helper; only its derived ID and match
/// booleans are published.
/// </summary>
internal static class ChromeUnpackedPathIdentityEvidencePublisher
{
    private const string KnownStaleLegacyExtensionId = "pbbmmjcakamllfpcglbhcpmbpegapgih";
    private const int MaxDisableReasons = 16;
    private const long MaxJsonBytes = 32L * 1024L * 1024L;
    private static readonly TimeSpan InitialDelay = TimeSpan.FromSeconds(12);
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromMinutes(1);
    private static Timer? _timer;

    [ModuleInitializer]
    internal static void Initialize()
    {
        try
        {
            _timer = new Timer(
                static _ => CaptureAndPublish(),
                null,
                InitialDelay,
                RefreshInterval);
        }
        catch
        {
            // Diagnostic-only; never affect helper startup or notification delivery.
        }
    }

    private static void CaptureAndPublish()
    {
        try
        {
            var evidenceRoot = Path.Combine(NativeHostInstaller.InstallRoot, "Evidence");
            Directory.CreateDirectory(evidenceRoot);
            var path = Path.Combine(evidenceRoot, "chrome-unpacked-path-identity.json");
            var temp = path + ".next";
            File.WriteAllText(
                temp,
                JsonSerializer.Serialize(Capture(), new JsonSerializerOptions(JsonOptions.Default) { WriteIndented = true }));
            File.Move(temp, path, overwrite: true);
        }
        catch
        {
            // Diagnostic-only; never affect helper startup or notification delivery.
        }
    }

    private static object Capture()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var userDataRoot = Path.Combine(localAppData, "Google", "Chrome", "User Data");
        var defaultProfileRoot = Path.Combine(userDataRoot, "Default");
        var forkRoot = NativeHostInstaller.ExtensionRoot;
        var intendedExtensionId = ReadExtensionId(forkRoot);
        var records = new List<PathIdentityRecord>();
        var inspected = 0;
        var unavailable = 0;

        if (!string.IsNullOrWhiteSpace(intendedExtensionId) && Directory.Exists(defaultProfileRoot))
        {
            foreach (var fileName in new[] { "Secure Preferences", "Preferences" })
            {
                var preferencePath = Path.Combine(defaultProfileRoot, fileName);
                if (!File.Exists(preferencePath)) continue;

                try
                {
                    using var document = ReadJsonShared(preferencePath);
                    inspected++;
                    ReadRegistration(document.RootElement, fileName, intendedExtensionId, "fork-target", forkRoot, records);
                    ReadRegistration(document.RootElement, fileName, KnownStaleLegacyExtensionId, "stale-legacy", forkRoot, records);
                }
                catch
                {
                    unavailable++;
                }
            }
        }

        var stale = records.FirstOrDefault(static record => record.Role == "stale-legacy");
        var target = records.FirstOrDefault(static record => record.Role == "fork-target");
        var state = string.IsNullOrWhiteSpace(intendedExtensionId)
            ? "target-id-unavailable"
            : !Directory.Exists(defaultProfileRoot)
                ? "default-profile-missing"
                : inspected == 0
                    ? "profile-files-unavailable"
                    : stale is null
                        ? "stale-registration-absent"
                        : "comparison-available";

        return new
        {
            schemaVersion = 1,
            capability = "chrome-unpacked-path-identity-readonly-helper-v1",
            observedAtUtc = DateTimeOffset.UtcNow,
            readOnly = true,
            state,
            intendedExtensionId,
            knownStaleLegacyExtensionId = KnownStaleLegacyExtensionId,
            profile = "Default",
            profileFilesInspected = inspected,
            profileFilesUnavailable = unavailable,
            staleRegistrationPresent = stale is not null,
            intendedRegistrationPresent = target is not null,
            stalePathDerivedIdMatchesRegistration = stale?.PathDerivedIdMatchesRegistration,
            intendedPathDerivedIdMatchesRegistration = target?.PathDerivedIdMatchesRegistration,
            records = records
                .OrderBy(static record => record.ExtensionId, StringComparer.Ordinal)
                .ThenBy(static record => record.Source, StringComparer.Ordinal)
                .Select(static record => new
                {
                    source = record.Source,
                    extensionId = record.ExtensionId,
                    role = record.Role,
                    locationValue = record.LocationValue,
                    disableReasonCount = record.DisableReasonCodes.Count,
                    disableReasonCodes = record.DisableReasonCodes,
                    pathAvailable = record.PathAvailable,
                    pathIsAbsolute = record.PathIsAbsolute,
                    pathMatchesForkRoot = record.PathMatchesForkRoot,
                    pathDerivedExtensionId = record.PathDerivedExtensionId,
                    pathDerivedIdMatchesRegistration = record.PathDerivedIdMatchesRegistration
                })
                .ToArray()
        };
    }

    private static void ReadRegistration(
        JsonElement root,
        string source,
        string extensionId,
        string role,
        string forkRoot,
        List<PathIdentityRecord> records)
    {
        if (!root.TryGetProperty("extensions", out var extensions) || extensions.ValueKind != JsonValueKind.Object) return;
        if (!extensions.TryGetProperty("settings", out var settings) || settings.ValueKind != JsonValueKind.Object) return;
        if (!settings.TryGetProperty(extensionId, out var entry) || entry.ValueKind != JsonValueKind.Object) return;

        // Do not trim or canonicalize this string before deriving an ID. Chromium's
        // Windows path-ID algorithm hashes the exact native path value after only
        // uppercasing a leading drive letter.
        var rawPath = RawStringValue(entry, "path", 2048);
        var disableReasons = new List<int>();
        if (entry.TryGetProperty("disable_reasons", out var reasons) && reasons.ValueKind == JsonValueKind.Array)
        {
            foreach (var reason in reasons.EnumerateArray().Take(MaxDisableReasons))
            {
                if (reason.ValueKind == JsonValueKind.Number && reason.TryGetInt32(out var code)) disableReasons.Add(code);
            }
        }

        var pathAvailable = !string.IsNullOrEmpty(rawPath);
        var pathIsAbsolute = false;
        if (pathAvailable)
        {
            try { pathIsAbsolute = Path.IsPathRooted(rawPath); } catch { }
        }

        string? pathDerivedExtensionId = null;
        if (pathAvailable)
        {
            try { pathDerivedExtensionId = ExtensionIdFromWindowsPath(rawPath!); } catch { }
        }

        records.Add(new PathIdentityRecord(
            source,
            extensionId,
            role,
            IntegerValue(entry, "location"),
            disableReasons,
            pathAvailable,
            pathIsAbsolute,
            PathMatches(rawPath, forkRoot),
            pathDerivedExtensionId,
            pathDerivedExtensionId is null
                ? null
                : string.Equals(pathDerivedExtensionId, extensionId, StringComparison.Ordinal)));
    }

    private static string? ReadExtensionId(string extensionRoot)
    {
        try
        {
            using var document = ReadJsonShared(Path.Combine(extensionRoot, "manifest.json"));
            var key = StringValue(document.RootElement, "key", 8192);
            return string.IsNullOrWhiteSpace(key) ? null : ExtensionIdFromPublicKey(key);
        }
        catch
        {
            return null;
        }
    }

    // Mirrors Chromium components/crx_file/id_util.cc GenerateIdForPath on Windows:
    // only a leading drive letter is normalized to uppercase, then the exact
    // UTF-16 native FilePath value is SHA-256 hashed and the first 16 bytes are
    // mapped from hexadecimal 0-f to extension alphabet a-p.
    private static string ExtensionIdFromWindowsPath(string path)
    {
        var normalized = path;
        if (normalized.Length >= 2
            && normalized[0] is >= 'a' and <= 'z'
            && normalized[1] == ':')
        {
            normalized = char.ToUpperInvariant(normalized[0]) + normalized[1..];
        }

        var hash = SHA256.HashData(Encoding.Unicode.GetBytes(normalized));
        return ExtensionIdFromHash(hash);
    }

    private static string ExtensionIdFromPublicKey(string key)
    {
        return ExtensionIdFromHash(SHA256.HashData(Convert.FromBase64String(key)));
    }

    private static string ExtensionIdFromHash(ReadOnlySpan<byte> hash)
    {
        if (hash.Length < 16) throw new ArgumentException("Extension identity hash is too short.", nameof(hash));
        const string alphabet = "abcdefghijklmnop";
        var builder = new StringBuilder(32);
        for (var index = 0; index < 16; index++)
        {
            builder.Append(alphabet[hash[index] >> 4]);
            builder.Append(alphabet[hash[index] & 0x0f]);
        }
        return builder.ToString();
    }

    private static bool PathMatches(string? candidate, string expected)
    {
        if (string.IsNullOrWhiteSpace(candidate) || string.IsNullOrWhiteSpace(expected)) return false;
        try
        {
            return string.Equals(
                Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar),
                Path.GetFullPath(expected).TrimEnd(Path.DirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static JsonDocument ReadJsonShared(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("Chrome JSON file is missing.", path);
        if (info.Length < 0 || info.Length > MaxJsonBytes) throw new InvalidDataException("Chrome JSON file exceeds diagnostic size bound.");
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        return JsonDocument.Parse(stream);
    }

    private static string? RawStringValue(JsonElement root, string name, int maxLength)
    {
        if (!root.TryGetProperty(name, out var node) || node.ValueKind != JsonValueKind.String) return null;
        var text = node.GetString() ?? string.Empty;
        if (text.Length == 0 || text.Length > maxLength) return null;
        return text;
    }

    private static string? StringValue(JsonElement root, string name, int maxLength)
    {
        if (!root.TryGetProperty(name, out var node) || node.ValueKind != JsonValueKind.String) return null;
        var text = (node.GetString() ?? string.Empty).Trim();
        if (text.Length == 0) return null;
        return text.Length <= maxLength ? text : text[..maxLength];
    }

    private static int? IntegerValue(JsonElement root, string name)
    {
        return root.TryGetProperty(name, out var node)
            && node.ValueKind == JsonValueKind.Number
            && node.TryGetInt32(out var value)
                ? value
                : null;
    }

    private sealed record PathIdentityRecord(
        string Source,
        string ExtensionId,
        string Role,
        int? LocationValue,
        IReadOnlyList<int> DisableReasonCodes,
        bool PathAvailable,
        bool PathIsAbsolute,
        bool PathMatchesForkRoot,
        string? PathDerivedExtensionId,
        bool? PathDerivedIdMatchesRegistration);
}
