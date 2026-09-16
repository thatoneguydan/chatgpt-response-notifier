using System.IO;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

/// <summary>
/// Publishes a bounded, read-only view of Chrome's notifier registration from the
/// interactive helper process. This exists because the self-hosted Actions runner
/// intentionally cannot read the interactive user's Chrome profile.
/// </summary>
internal static class ChromeRegistrationEvidencePublisher
{
    private const int MaxProfiles = 32;
    private const int MaxDisableReasons = 16;
    private const long MaxJsonBytes = 32L * 1024L * 1024L;
    private static readonly TimeSpan InitialDelay = TimeSpan.FromSeconds(8);
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
            // Registration evidence is diagnostic-only and must never affect helper startup.
        }
    }

    private static void CaptureAndPublish()
    {
        try
        {
            var evidenceRoot = Path.Combine(NativeHostInstaller.InstallRoot, "Evidence");
            Directory.CreateDirectory(evidenceRoot);
            var path = Path.Combine(evidenceRoot, "chrome-registration-evidence.json");
            var payload = Capture();
            var temp = path + ".next";
            File.WriteAllText(temp, JsonSerializer.Serialize(payload, new JsonSerializerOptions(JsonOptions.Default) { WriteIndented = true }));
            File.Move(temp, path, overwrite: true);
        }
        catch
        {
            // Read-only diagnostics must never affect notifier delivery or helper lifetime.
        }
    }

    private static object Capture()
    {
        var now = DateTimeOffset.UtcNow;
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var userDataRoot = Path.Combine(localAppData, "Google", "Chrome", "User Data");
        var extensionRoot = NativeHostInstaller.ExtensionRoot;
        var extensionId = ReadExtensionId(extensionRoot);
        var lastUsedProfile = ReadLastUsedProfile(userDataRoot);
        var registrations = new List<object>();
        var profileStates = new List<object>();
        var inspected = 0;
        var unavailable = 0;
        var profilesDiscovered = 0;

        var initialState = string.IsNullOrWhiteSpace(extensionId)
            ? "extension-id-unavailable"
            : Directory.Exists(userDataRoot)
                ? "unavailable"
                : "chrome-user-data-missing";

        if (!string.IsNullOrWhiteSpace(extensionId) && Directory.Exists(userDataRoot))
        {
            var stableExtensionId = extensionId!;
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
                var preferencesReadable = false;
                var securePreferencesReadable = false;
                bool? developerModeEnabled = null;

                foreach (var fileName in new[] { "Secure Preferences", "Preferences" })
                {
                    var preferencePath = Path.Combine(profile.FullName, fileName);
                    if (!File.Exists(preferencePath)) continue;
                    try
                    {
                        using var document = ReadJsonShared(preferencePath);
                        inspected++;
                        if (fileName == "Preferences")
                        {
                            preferencesReadable = true;
                            developerModeEnabled = ReadDeveloperMode(document.RootElement);
                        }
                        else
                        {
                            securePreferencesReadable = true;
                        }

                        if (!TryReadRegistration(document.RootElement, stableExtensionId, extensionRoot, out var registration)) continue;
                        registrations.Add(new
                        {
                            profile = profile.Name,
                            source = fileName,
                            present = true,
                            stateValue = registration.StateValue,
                            locationValue = registration.LocationValue,
                            disableReasonCount = registration.DisableReasonCodes.Count,
                            disableReasonCodes = registration.DisableReasonCodes,
                            pathAvailable = registration.PathAvailable,
                            pathMatchesExpectedExtensionRoot = registration.PathMatchesExpectedExtensionRoot
                        });
                    }
                    catch
                    {
                        unavailable++;
                    }
                }

                profileStates.Add(new
                {
                    profile = profile.Name,
                    preferencesReadable,
                    securePreferencesReadable,
                    developerModeEnabled
                });
            }
        }

        var state = initialState;
        if (!string.IsNullOrWhiteSpace(extensionId) && Directory.Exists(userDataRoot))
        {
            state = registrations.Count > 0
                ? "present"
                : inspected > 0
                    ? "absent"
                    : "unavailable";
        }

        var lastUsedState = profileStates
            .Select(item => JsonSerializer.SerializeToElement(item, JsonOptions.Default))
            .FirstOrDefault(item => string.Equals(StringValue(item, "profile"), lastUsedProfile, StringComparison.Ordinal));
        bool? lastUsedDeveloperMode = lastUsedState.ValueKind == JsonValueKind.Object
            ? BooleanValue(lastUsedState, "developerModeEnabled")
            : null;
        var lastUsedRegistrationPresent = registrations
            .Select(item => JsonSerializer.SerializeToElement(item, JsonOptions.Default))
            .Any(item => string.Equals(StringValue(item, "profile"), lastUsedProfile, StringComparison.Ordinal));
        var lastUsedPathMatches = registrations
            .Select(item => JsonSerializer.SerializeToElement(item, JsonOptions.Default))
            .Where(item => string.Equals(StringValue(item, "profile"), lastUsedProfile, StringComparison.Ordinal))
            .Select(item => BooleanValue(item, "pathMatchesExpectedExtensionRoot"))
            .Any(value => value == true);

        return new
        {
            schemaVersion = 1,
            capability = "chrome-registration-readonly-helper-v1",
            observedAtUtc = now,
            state,
            extensionId,
            lastUsedProfile,
            lastUsedProfileDeveloperModeEnabled = lastUsedDeveloperMode,
            lastUsedProfileRegistrationPresent = lastUsedRegistrationPresent,
            lastUsedProfilePathMatchesExpectedExtensionRoot = lastUsedRegistrationPresent ? lastUsedPathMatches : (bool?)null,
            profilesDiscovered,
            profileFilesInspected = inspected,
            profileFilesUnavailable = unavailable,
            profileStates,
            registrations
        };
    }

    private static string? ReadExtensionId(string extensionRoot)
    {
        try
        {
            var manifestPath = Path.Combine(extensionRoot, "manifest.json");
            using var document = ReadJsonShared(manifestPath);
            if (!document.RootElement.TryGetProperty("key", out var keyNode) || keyNode.ValueKind != JsonValueKind.String) return null;
            var key = keyNode.GetString();
            if (string.IsNullOrWhiteSpace(key)) return null;
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
        catch
        {
            return null;
        }
    }

    private static string? ReadLastUsedProfile(string userDataRoot)
    {
        try
        {
            var localStatePath = Path.Combine(userDataRoot, "Local State");
            using var document = ReadJsonShared(localStatePath);
            if (!document.RootElement.TryGetProperty("profile", out var profile) || profile.ValueKind != JsonValueKind.Object) return null;
            if (!profile.TryGetProperty("last_used", out var lastUsed) || lastUsed.ValueKind != JsonValueKind.String) return null;
            return BoundedProfileName(lastUsed.GetString());
        }
        catch
        {
            return null;
        }
    }

    private static bool? ReadDeveloperMode(JsonElement root)
    {
        if (!root.TryGetProperty("extensions", out var extensions) || extensions.ValueKind != JsonValueKind.Object) return null;
        if (!extensions.TryGetProperty("ui", out var ui) || ui.ValueKind != JsonValueKind.Object) return null;
        if (!ui.TryGetProperty("developer_mode", out var developerMode)) return null;
        return developerMode.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null
        };
    }

    private static bool TryReadRegistration(
        JsonElement root,
        string extensionId,
        string expectedExtensionRoot,
        out Registration registration)
    {
        registration = default;
        if (!root.TryGetProperty("extensions", out var extensions) || extensions.ValueKind != JsonValueKind.Object) return false;
        if (!extensions.TryGetProperty("settings", out var settings) || settings.ValueKind != JsonValueKind.Object) return false;
        if (!settings.TryGetProperty(extensionId, out var entry) || entry.ValueKind != JsonValueKind.Object) return false;

        var rawPath = entry.TryGetProperty("path", out var pathNode) && pathNode.ValueKind == JsonValueKind.String
            ? pathNode.GetString()
            : null;
        var disableReasons = new List<int>();
        if (entry.TryGetProperty("disable_reasons", out var reasons) && reasons.ValueKind == JsonValueKind.Array)
        {
            foreach (var reason in reasons.EnumerateArray().Take(MaxDisableReasons))
            {
                if (reason.ValueKind == JsonValueKind.Number && reason.TryGetInt32(out var code)) disableReasons.Add(code);
            }
        }

        registration = new Registration(
            IntegerValue(entry, "state"),
            IntegerValue(entry, "location"),
            disableReasons,
            !string.IsNullOrWhiteSpace(rawPath),
            PathMatches(rawPath, expectedExtensionRoot));
        return true;
    }

    private static JsonDocument ReadJsonShared(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("Chrome JSON file is missing.", path);
        if (info.Length < 0 || info.Length > MaxJsonBytes) throw new InvalidDataException("Chrome JSON file exceeds diagnostic size bound.");
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        return JsonDocument.Parse(stream);
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

    private static string? StringValue(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var node) || node.ValueKind != JsonValueKind.String) return null;
        return BoundedProfileName(node.GetString());
    }

    private static string? BoundedProfileName(string? value)
    {
        var text = (value ?? string.Empty).Trim();
        if (text.Length == 0) return null;
        return text.Length <= 64 ? text : text[..64];
    }

    private readonly record struct Registration(
        int? StateValue,
        int? LocationValue,
        IReadOnlyList<int> DisableReasonCodes,
        bool PathAvailable,
        bool PathMatchesExpectedExtensionRoot);
}
