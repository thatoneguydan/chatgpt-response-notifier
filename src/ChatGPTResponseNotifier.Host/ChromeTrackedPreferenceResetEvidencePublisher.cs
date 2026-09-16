using System.IO;
using System.Runtime.CompilerServices;
using System.Text.Json;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

/// <summary>
/// Publishes only bounded Chrome tracked-preference reset markers relevant to
/// the notifier extension. This is read-only and never exports unrelated reset
/// paths or authenticator values.
/// </summary>
internal static class ChromeTrackedPreferenceResetEvidencePublisher
{
    private const long MaxJsonBytes = 32L * 1024L * 1024L;
    private static readonly TimeSpan InitialDelay = TimeSpan.FromSeconds(8);
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromMinutes(1);
    private static Timer? _timer;

    [ModuleInitializer]
    internal static void Initialize()
    {
        try
        {
            _timer = new Timer(static _ => CaptureAndPublish(), null, InitialDelay, RefreshInterval);
        }
        catch { }
    }

    private static void CaptureAndPublish()
    {
        try
        {
            var evidenceRoot = Path.Combine(NativeHostInstaller.InstallRoot, "Evidence");
            Directory.CreateDirectory(evidenceRoot);
            var path = Path.Combine(evidenceRoot, "chrome-tracked-preference-reset-evidence.json");
            var temp = path + ".next";
            File.WriteAllText(temp, JsonSerializer.Serialize(Capture(), new JsonSerializerOptions(JsonOptions.Default) { WriteIndented = true }));
            File.Move(temp, path, overwrite: true);
        }
        catch { }
    }

    private static object Capture()
    {
        var observedAtUtc = DateTimeOffset.UtcNow;
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var userDataRoot = Path.Combine(localAppData, "Google", "Chrome", "User Data");
        var lastUsedProfile = ReadLastUsedProfile(userDataRoot);
        var profilePath = SafeProfilePath(userDataRoot, lastUsedProfile);
        if (profilePath is null)
            return Result("profile-unavailable", observedAtUtc, lastUsedProfile, null, null, null, null);

        var securePreferencesPath = Path.Combine(profilePath, "Secure Preferences");
        try
        {
            using var document = ReadJsonShared(securePreferencesPath);
            var root = document.RootElement;
            var target = $"extensions.settings.{NativeHostConstants.ExtensionId}";
            var notifierReset = false;
            var extensionsSettingsReset = false;
            var count = 0;

            if (TryGetPath(root, new[] { "prefs", "tracked_preferences_reset" }, out var resetEntries))
            {
                if (resetEntries.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in resetEntries.EnumerateArray().Take(512))
                    {
                        if (item.ValueKind != JsonValueKind.String) continue;
                        var value = item.GetString();
                        if (string.IsNullOrWhiteSpace(value)) continue;
                        count++;
                        if (string.Equals(value, target, StringComparison.Ordinal)) notifierReset = true;
                        if (string.Equals(value, "extensions.settings", StringComparison.Ordinal)) extensionsSettingsReset = true;
                    }
                }
                else if (resetEntries.ValueKind == JsonValueKind.Object)
                {
                    foreach (var item in resetEntries.EnumerateObject().Take(512))
                    {
                        count++;
                        if (string.Equals(item.Name, target, StringComparison.Ordinal)) notifierReset = true;
                        if (string.Equals(item.Name, "extensions.settings", StringComparison.Ordinal)) extensionsSettingsReset = true;
                    }
                }
            }

            bool resetTimePresent = false;
            if (TryGetPath(root, new[] { "prefs", "preference_reset_time" }, out var resetTime))
            {
                resetTimePresent = resetTime.ValueKind switch
                {
                    JsonValueKind.String => !string.IsNullOrWhiteSpace(resetTime.GetString()) && resetTime.GetString() != "0",
                    JsonValueKind.Number => resetTime.TryGetInt64(out var number) && number != 0,
                    _ => false
                };
            }

            var registrationPresent = TryGetPath(root, new[] { "extensions", "settings", NativeHostConstants.ExtensionId }, out var registration)
                && registration.ValueKind == JsonValueKind.Object;

            return Result("read", observedAtUtc, lastUsedProfile, registrationPresent, notifierReset, extensionsSettingsReset, count, resetTimePresent);
        }
        catch
        {
            return Result("unavailable", observedAtUtc, lastUsedProfile, null, null, null, null);
        }
    }

    private static object Result(
        string state,
        DateTimeOffset observedAtUtc,
        string? lastUsedProfile,
        bool? registrationPresent,
        bool? notifierTrackedResetRecorded,
        bool? extensionsSettingsResetRecorded,
        int? trackedResetEntryCount,
        bool? preferenceResetTimePresent = null) => new
    {
        schemaVersion = 1,
        capability = "chrome-tracked-preference-reset-readonly-v1",
        observedAtUtc,
        state,
        lastUsedProfile,
        registrationPresent,
        notifierTrackedResetRecorded,
        extensionsSettingsResetRecorded,
        trackedResetEntryCount,
        preferenceResetTimePresent,
        sourceProfileMutated = false
    };

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
        catch { return null; }
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
        catch { return null; }
    }

    private static JsonDocument ReadJsonShared(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("Chrome JSON file is missing.", path);
        if (info.Length < 0 || info.Length > MaxJsonBytes) throw new InvalidDataException("Chrome JSON file exceeds diagnostic size bound.");
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        return JsonDocument.Parse(stream);
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
}
