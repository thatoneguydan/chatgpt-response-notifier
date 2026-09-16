using System.IO;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

/// <summary>
/// Publishes a bounded, read-only comparison of the notifier's unpacked Chrome
/// registration against other unpacked extensions that target chatgpt.com.
/// The interactive helper owns this read because the Actions service account
/// intentionally cannot read the user's Chrome profile.
/// </summary>
internal static class ChromeUnpackedControlComparisonEvidencePublisher
{
    private const int MaxProfiles = 32;
    private const int MaxExtensionsPerPreferenceFile = 256;
    private const int MaxDisableReasons = 16;
    private const long MaxJsonBytes = 32L * 1024L * 1024L;
    private static readonly TimeSpan InitialDelay = TimeSpan.FromSeconds(10);
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
            var path = Path.Combine(evidenceRoot, "chrome-unpacked-control-comparison.json");
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
        var now = DateTimeOffset.UtcNow;
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var profileRoot = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var userDataRoot = Path.Combine(localAppData, "Google", "Chrome", "User Data");
        var forkRoot = NativeHostInstaller.ExtensionRoot;
        var targetExtensionId = ReadExtensionId(forkRoot);
        var lastUsedProfile = ReadLastUsedProfile(userDataRoot);
        var records = new List<ComparisonRecord>();
        var inspected = 0;
        var unavailable = 0;
        var profilesDiscovered = 0;

        var initialState = string.IsNullOrWhiteSpace(targetExtensionId)
            ? "target-id-unavailable"
            : Directory.Exists(userDataRoot)
                ? "unavailable"
                : "chrome-user-data-missing";

        if (!string.IsNullOrWhiteSpace(targetExtensionId) && Directory.Exists(userDataRoot))
        {
            IEnumerable<DirectoryInfo> profiles;
            try
            {
                profiles = new DirectoryInfo(userDataRoot)
                    .EnumerateDirectories()
                    .Where(static profile => profile.Name == "Default" || profile.Name.StartsWith("Profile ", StringComparison.Ordinal))
                    .OrderBy(static profile => profile.Name, StringComparer.Ordinal)
                    .Take(MaxProfiles)
                    .ToArray();
            }
            catch
            {
                profiles = Array.Empty<DirectoryInfo>();
            }

            foreach (var profile in profiles)
            {
                profilesDiscovered++;
                foreach (var fileName in new[] { "Secure Preferences", "Preferences" })
                {
                    var preferencePath = Path.Combine(profile.FullName, fileName);
                    if (!File.Exists(preferencePath)) continue;

                    try
                    {
                        using var document = ReadJsonShared(preferencePath);
                        inspected++;
                        foreach (var record in ReadCandidates(
                                     document.RootElement,
                                     profile.Name,
                                     fileName,
                                     targetExtensionId,
                                     forkRoot,
                                     profileRoot,
                                     userDataRoot))
                        {
                            records.Add(record);
                        }
                    }
                    catch
                    {
                        unavailable++;
                    }
                }
            }
        }

        var targetRegistrationCount = records.Count(static record => record.Role == "fork-target");
        var controlIds = records
            .Where(static record => record.Role == "control-candidate")
            .Select(static record => record.ExtensionId)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static value => value, StringComparer.Ordinal)
            .ToArray();

        var state = initialState;
        if (!string.IsNullOrWhiteSpace(targetExtensionId) && Directory.Exists(userDataRoot))
        {
            state = inspected == 0
                ? "profile-files-unavailable"
                : controlIds.Length == 0
                    ? "no-control-candidate-found"
                    : targetRegistrationCount == 0
                        ? "target-absent-control-present"
                        : "comparison-available";
        }

        return new
        {
            schemaVersion = 1,
            capability = "chrome-unpacked-control-comparison-readonly-helper-v1",
            observedAtUtc = now,
            readOnly = true,
            state,
            targetExtensionId,
            lastUsedProfile,
            profilesDiscovered,
            profileFilesInspected = inspected,
            profileFilesUnavailable = unavailable,
            targetRegistrationCount,
            controlCandidateCount = controlIds.Length,
            controlCandidateIds = controlIds,
            records = records
                .OrderBy(static record => record.Profile, StringComparer.Ordinal)
                .ThenBy(static record => record.ExtensionId, StringComparer.Ordinal)
                .ThenBy(static record => record.Source, StringComparer.Ordinal)
                .Select(static record => new
                {
                    profile = record.Profile,
                    source = record.Source,
                    extensionId = record.ExtensionId,
                    role = record.Role,
                    stateValue = record.StateValue,
                    locationValue = record.LocationValue,
                    creationFlagsValue = record.CreationFlagsValue,
                    fromWebStore = record.FromWebStore,
                    disableReasonCount = record.DisableReasonCodes.Count,
                    disableReasonCodes = record.DisableReasonCodes,
                    pathAvailable = record.PathAvailable,
                    pathIsAbsolute = record.PathIsAbsolute,
                    pathCategory = record.PathCategory,
                    pathMatchesForkRoot = record.PathMatchesForkRoot,
                    pathExists = record.Manifest.PathExists,
                    manifestExists = record.Manifest.ManifestExists,
                    manifestReadable = record.Manifest.ManifestReadable,
                    manifestName = record.Manifest.ManifestName,
                    manifestVersion = record.Manifest.ManifestVersion,
                    manifestKeyPresent = record.Manifest.ManifestKeyPresent,
                    calculatedExtensionId = record.Manifest.CalculatedExtensionId,
                    calculatedIdMatchesRegistration = record.Manifest.CalculatedExtensionId is null
                        ? (bool?)null
                        : string.Equals(record.Manifest.CalculatedExtensionId, record.ExtensionId, StringComparison.Ordinal),
                    targetsChatGPT = record.Manifest.TargetsChatGpt
                })
                .ToArray()
        };
    }

    private static IEnumerable<ComparisonRecord> ReadCandidates(
        JsonElement root,
        string profile,
        string source,
        string targetExtensionId,
        string forkRoot,
        string profileRoot,
        string userDataRoot)
    {
        if (!root.TryGetProperty("extensions", out var extensions) || extensions.ValueKind != JsonValueKind.Object) yield break;
        if (!extensions.TryGetProperty("settings", out var settings) || settings.ValueKind != JsonValueKind.Object) yield break;

        var count = 0;
        foreach (var property in settings.EnumerateObject())
        {
            if (++count > MaxExtensionsPerPreferenceFile) yield break;
            var entry = property.Value;
            if (entry.ValueKind != JsonValueKind.Object) continue;

            var extensionId = BoundedExtensionId(property.Name);
            if (extensionId is null) continue;

            var rawPath = StringValue(entry, "path", 1024);
            var manifest = ReadManifestSnapshot(rawPath);
            var isTarget = string.Equals(extensionId, targetExtensionId, StringComparison.Ordinal);
            if (!isTarget && !manifest.TargetsChatGpt) continue;

            var disableReasons = new List<int>();
            if (entry.TryGetProperty("disable_reasons", out var reasons) && reasons.ValueKind == JsonValueKind.Array)
            {
                foreach (var reason in reasons.EnumerateArray().Take(MaxDisableReasons))
                {
                    if (reason.ValueKind == JsonValueKind.Number && reason.TryGetInt32(out var code)) disableReasons.Add(code);
                }
            }

            var pathAvailable = !string.IsNullOrWhiteSpace(rawPath);
            var pathIsAbsolute = false;
            if (pathAvailable)
            {
                try { pathIsAbsolute = Path.IsPathRooted(rawPath); }
                catch { }
            }

            yield return new ComparisonRecord(
                profile,
                source,
                extensionId,
                isTarget ? "fork-target" : "control-candidate",
                IntegerValue(entry, "state"),
                IntegerValue(entry, "location"),
                IntegerValue(entry, "creation_flags"),
                BooleanValue(entry, "from_webstore"),
                disableReasons,
                pathAvailable,
                pathIsAbsolute,
                SafePathCategory(rawPath, forkRoot, profileRoot, userDataRoot),
                PathMatches(rawPath, forkRoot),
                manifest);
        }
    }

    private static ManifestSnapshot ReadManifestSnapshot(string? extensionPath)
    {
        if (string.IsNullOrWhiteSpace(extensionPath)) return ManifestSnapshot.Empty;

        bool pathExists;
        try { pathExists = Directory.Exists(extensionPath); }
        catch { pathExists = false; }
        if (!pathExists) return ManifestSnapshot.Empty with { PathExists = false };

        string manifestPath;
        try { manifestPath = Path.Combine(extensionPath, "manifest.json"); }
        catch { return ManifestSnapshot.Empty with { PathExists = true }; }

        bool manifestExists;
        try { manifestExists = File.Exists(manifestPath); }
        catch { manifestExists = false; }
        if (!manifestExists) return ManifestSnapshot.Empty with { PathExists = true };

        try
        {
            using var document = ReadJsonShared(manifestPath);
            var root = document.RootElement;
            var key = StringValue(root, "key", 8192);
            string? calculatedId = null;
            if (!string.IsNullOrWhiteSpace(key))
            {
                try { calculatedId = ExtensionIdFromPublicKey(key); }
                catch { }
            }

            return new ManifestSnapshot(
                true,
                true,
                true,
                StringValue(root, "name", 128),
                StringValue(root, "version", 32),
                !string.IsNullOrWhiteSpace(key),
                calculatedId,
                ManifestTargetsChatGpt(root));
        }
        catch
        {
            return new ManifestSnapshot(true, true, false, null, null, false, null, false);
        }
    }

    private static bool ManifestTargetsChatGpt(JsonElement root)
    {
        if (root.TryGetProperty("host_permissions", out var hosts) && hosts.ValueKind == JsonValueKind.Array)
        {
            foreach (var host in hosts.EnumerateArray())
            {
                if (host.ValueKind == JsonValueKind.String && IsChatGptMatch(host.GetString())) return true;
            }
        }

        if (root.TryGetProperty("content_scripts", out var scripts) && scripts.ValueKind == JsonValueKind.Array)
        {
            foreach (var script in scripts.EnumerateArray())
            {
                if (script.ValueKind != JsonValueKind.Object || !script.TryGetProperty("matches", out var matches) || matches.ValueKind != JsonValueKind.Array) continue;
                foreach (var match in matches.EnumerateArray())
                {
                    if (match.ValueKind == JsonValueKind.String && IsChatGptMatch(match.GetString())) return true;
                }
            }
        }

        var name = StringValue(root, "name", 128) ?? string.Empty;
        var description = StringValue(root, "description", 256) ?? string.Empty;
        var combined = (name + " " + description).ToLowerInvariant();
        return combined.Contains("chatgpt", StringComparison.Ordinal) && combined.Contains("notif", StringComparison.Ordinal);
    }

    private static bool IsChatGptMatch(string? value)
    {
        return !string.IsNullOrWhiteSpace(value)
            && value.StartsWith("https://chatgpt.com/", StringComparison.OrdinalIgnoreCase);
    }

    private static string SafePathCategory(string? candidate, string forkRoot, string profileRoot, string userDataRoot)
    {
        if (string.IsNullOrWhiteSpace(candidate)) return "unavailable";
        if (PathMatches(candidate, forkRoot)) return "fork-stable-root";
        if (PathUnder(candidate, userDataRoot)) return "chrome-user-data";
        if (PathUnder(candidate, profileRoot)) return "user-profile-other";
        return "outside-user-profile";
    }

    private static bool PathUnder(string? candidate, string root)
    {
        if (string.IsNullOrWhiteSpace(candidate) || string.IsNullOrWhiteSpace(root)) return false;
        try
        {
            var candidateFull = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            var rootFull = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            return candidateFull.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
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

    private static string? ReadLastUsedProfile(string userDataRoot)
    {
        try
        {
            using var document = ReadJsonShared(Path.Combine(userDataRoot, "Local State"));
            if (!document.RootElement.TryGetProperty("profile", out var profile) || profile.ValueKind != JsonValueKind.Object) return null;
            return StringValue(profile, "last_used", 64);
        }
        catch
        {
            return null;
        }
    }

    private static string ExtensionIdFromPublicKey(string key)
    {
        var bytes = Convert.FromBase64String(key);
        var hash = SHA256.HashData(bytes);
        const string alphabet = "abcdefghijklmnop";
        var builder = new StringBuilder(32);
        for (var index = 0; index < 16; index++)
        {
            builder.Append(alphabet[hash[index] >> 4]);
            builder.Append(alphabet[hash[index] & 0x0f]);
        }
        return builder.ToString();
    }

    private static JsonDocument ReadJsonShared(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("Chrome JSON file is missing.", path);
        if (info.Length < 0 || info.Length > MaxJsonBytes) throw new InvalidDataException("Chrome JSON file exceeds diagnostic size bound.");
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        return JsonDocument.Parse(stream);
    }

    private static string? BoundedExtensionId(string? value)
    {
        var text = (value ?? string.Empty).Trim();
        if (text.Length != 32) return null;
        return text.All(static character => character is >= 'a' and <= 'p') ? text : null;
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

    private static bool? BooleanValue(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var node)) return null;
        return node.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null
        };
    }

    private sealed record ComparisonRecord(
        string Profile,
        string Source,
        string ExtensionId,
        string Role,
        int? StateValue,
        int? LocationValue,
        int? CreationFlagsValue,
        bool? FromWebStore,
        IReadOnlyList<int> DisableReasonCodes,
        bool PathAvailable,
        bool PathIsAbsolute,
        string PathCategory,
        bool PathMatchesForkRoot,
        ManifestSnapshot Manifest);

    private sealed record ManifestSnapshot(
        bool PathExists,
        bool ManifestExists,
        bool ManifestReadable,
        string? ManifestName,
        string? ManifestVersion,
        bool ManifestKeyPresent,
        string? CalculatedExtensionId,
        bool TargetsChatGpt)
    {
        public static ManifestSnapshot Empty { get; } = new(false, false, false, null, null, false, null, false);
    }
}
