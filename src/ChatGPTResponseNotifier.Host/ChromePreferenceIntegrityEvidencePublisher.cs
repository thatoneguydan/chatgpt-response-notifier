using System.IO;
using System.Runtime.CompilerServices;
using System.Text.Json;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

/// <summary>
/// Publishes only the presence of Chrome's protected preference authenticators
/// for the notifier registration. Authenticator values are never persisted.
/// Diagnostic-only: no Chrome preference or extension mutation is performed.
/// </summary>
internal static class ChromePreferenceIntegrityEvidencePublisher
{
    private const long MaxJsonBytes = 32L * 1024L * 1024L;
    private static readonly TimeSpan InitialDelay = TimeSpan.FromSeconds(13);
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromMinutes(2);
    private static Timer? _timer;

    [ModuleInitializer]
    internal static void Initialize()
    {
        try
        {
            _timer = new Timer(static _ => CaptureAndPublish(), null, InitialDelay, RefreshInterval);
        }
        catch
        {
            // Diagnostic-only evidence must never affect helper startup.
        }
    }

    private static void CaptureAndPublish()
    {
        try
        {
            var evidenceRoot = Path.Combine(NativeHostInstaller.InstallRoot, "Evidence");
            Directory.CreateDirectory(evidenceRoot);
            var path = Path.Combine(evidenceRoot, "chrome-pref-integrity-evidence.json");
            var temp = path + ".next";
            File.WriteAllText(temp, JsonSerializer.Serialize(Capture(), new JsonSerializerOptions(JsonOptions.Default) { WriteIndented = true }));
            File.Move(temp, path, overwrite: true);
        }
        catch
        {
            // Diagnostic-only evidence must never affect helper lifetime.
        }
    }

    private static object Capture()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var userDataRoot = Path.Combine(localAppData, "Google", "Chrome", "User Data");
        var lastUsedProfile = ReadLastUsedProfile(userDataRoot);
        var profilePath = SafeProfilePath(userDataRoot, lastUsedProfile);
        if (profilePath is null)
        {
            return Result(
                string.IsNullOrWhiteSpace(lastUsedProfile) ? "last-used-profile-unavailable" : "last-used-profile-rejected",
                lastUsedProfile,
                null, null, null, null, null, null, null);
        }

        try
        {
            using var securePreferences = ReadJsonShared(Path.Combine(profilePath, "Secure Preferences"));
            var root = securePreferences.RootElement;
            var registrationPresent = HasObjectAtPath(root, "extensions", "settings", NativeHostConstants.ExtensionId);
            var legacyHmacPresent = HasNonEmptyStringAtPath(root, "protection", "macs", "extensions", "settings", NativeHostConstants.ExtensionId);
            var encryptedHashPresent = HasNonEmptyStringAtPath(root, "protection", "macs", "extensions", "settings_encrypted_hash", NativeHostConstants.ExtensionId);
            var superMacPresent = HasNonEmptyStringAtPath(root, "protection", "super_mac");
            var superEncryptedHashPresent = HasNonEmptyStringAtPath(root, "protection", "super_encrypted_hash");
            var legacyHmacEntryCount = ObjectPropertyCountAtPath(root, "protection", "macs", "extensions", "settings");
            var encryptedHashEntryCount = ObjectPropertyCountAtPath(root, "protection", "macs", "extensions", "settings_encrypted_hash");

            return Result(
                "read",
                lastUsedProfile,
                registrationPresent,
                legacyHmacPresent,
                encryptedHashPresent,
                superMacPresent,
                superEncryptedHashPresent,
                legacyHmacEntryCount,
                encryptedHashEntryCount);
        }
        catch
        {
            return Result("secure-preferences-unavailable", lastUsedProfile, null, null, null, null, null, null, null);
        }
    }

    private static object Result(
        string state,
        string? lastUsedProfile,
        bool? registrationPresent,
        bool? legacyHmacPresent,
        bool? encryptedHashPresent,
        bool? superMacPresent,
        bool? superEncryptedHashPresent,
        int? legacyHmacEntryCount,
        int? encryptedHashEntryCount)
    {
        return new
        {
            schemaVersion = 1,
            capability = "chrome-pref-integrity-readonly-helper-v1",
            observedAtUtc = DateTimeOffset.UtcNow,
            state,
            lastUsedProfile,
            registrationPresent,
            legacyHmacPresent,
            encryptedHashPresent,
            notifierAuthenticatorPresent = legacyHmacPresent.HasValue && encryptedHashPresent.HasValue
                ? legacyHmacPresent.Value || encryptedHashPresent.Value
                : (bool?)null,
            superMacPresent,
            superEncryptedHashPresent,
            legacyHmacEntryCount,
            encryptedHashEntryCount
        };
    }

    private static bool HasObjectAtPath(JsonElement root, params string[] path)
    {
        return TryGetPath(root, path, out var value) && value.ValueKind == JsonValueKind.Object;
    }

    private static bool HasNonEmptyStringAtPath(JsonElement root, params string[] path)
    {
        return TryGetPath(root, path, out var value)
            && value.ValueKind == JsonValueKind.String
            && !string.IsNullOrWhiteSpace(value.GetString());
    }

    private static int? ObjectPropertyCountAtPath(JsonElement root, params string[] path)
    {
        if (!TryGetPath(root, path, out var value) || value.ValueKind != JsonValueKind.Object) return null;
        var count = 0;
        foreach (var _ in value.EnumerateObject())
        {
            if (++count > 4096) return 4096;
        }
        return count;
    }

    private static bool TryGetPath(JsonElement root, IReadOnlyList<string> path, out JsonElement value)
    {
        value = root;
        foreach (var segment in path)
        {
            if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty(segment, out value)) return false;
        }
        return true;
    }

    private static string? ReadLastUsedProfile(string userDataRoot)
    {
        try
        {
            using var document = ReadJsonShared(Path.Combine(userDataRoot, "Local State"));
            if (!document.RootElement.TryGetProperty("profile", out var profile) || profile.ValueKind != JsonValueKind.Object) return null;
            if (!profile.TryGetProperty("last_used", out var lastUsed) || lastUsed.ValueKind != JsonValueKind.String) return null;
            var value = (lastUsed.GetString() ?? string.Empty).Trim();
            return value.Length is > 0 and <= 64 ? value : null;
        }
        catch
        {
            return null;
        }
    }

    private static string? SafeProfilePath(string userDataRoot, string? profileName)
    {
        if (string.IsNullOrWhiteSpace(profileName)) return null;
        if (!string.Equals(profileName, "Default", StringComparison.Ordinal) && !profileName.StartsWith("Profile ", StringComparison.Ordinal)) return null;
        try
        {
            var root = Path.GetFullPath(userDataRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            var profile = Path.GetFullPath(Path.Combine(userDataRoot, profileName));
            return profile.StartsWith(root, StringComparison.OrdinalIgnoreCase) ? profile : null;
        }
        catch
        {
            return null;
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
}
