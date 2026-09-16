using System.IO;
using System.Runtime.CompilerServices;
using System.Text.Json;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

/// <summary>
/// Publishes only the Chrome preference inputs that can change unpacked startup
/// loading. Diagnostic-only: no profile or extension mutation is performed.
/// </summary>
internal static class ChromeStartupPreferenceEvidencePublisher
{
    private const long MaxJsonBytes = 32L * 1024L * 1024L;
    private const int InstalledViaCdpFlag = 1 << 15;
    private const int FromWebStoreFlag = 1 << 3;
    private const int WasInstalledByDefaultFlag = 1 << 7;
    private const int WasInstalledByOemFlag = 1 << 10;
    private const int AllowFileAccessFlag = 1 << 2;
    private static readonly TimeSpan InitialDelay = TimeSpan.FromSeconds(9);
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromMinutes(1);
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
            var path = Path.Combine(evidenceRoot, "chrome-startup-pref-evidence.json");
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
        var state = "unavailable";
        bool? developerMode = null;
        var registrationPresent = false;
        int? rawCreationFlags = null;
        string? creationFlagsSource = null;
        bool? fromWebStore = null;
        bool? wasInstalledByDefault = null;
        bool? wasInstalledByOem = null;
        bool? allowFileAccess = null;
        int? effectiveCreationFlags = null;

        var profilePath = SafeProfilePath(userDataRoot, lastUsedProfile);
        if (profilePath is null)
        {
            state = string.IsNullOrWhiteSpace(lastUsedProfile) ? "last-used-profile-unavailable" : "last-used-profile-rejected";
        }
        else
        {
            var preferencesPath = Path.Combine(profilePath, "Preferences");
            try
            {
                using var preferences = ReadJsonShared(preferencesPath);
                developerMode = ReadDeveloperMode(preferences.RootElement);
                if (TryReadRegistrationPrefs(preferences.RootElement, out var registration))
                {
                    registrationPresent = true;
                    rawCreationFlags = registration.CreationFlags;
                    creationFlagsSource = "Preferences";
                    fromWebStore = registration.FromWebStore;
                    wasInstalledByDefault = registration.WasInstalledByDefault;
                    wasInstalledByOem = registration.WasInstalledByOem;
                    allowFileAccess = registration.AllowFileAccess;
                }
                state = "read";
            }
            catch
            {
                state = "preferences-unavailable";
            }

            var securePreferencesPath = Path.Combine(profilePath, "Secure Preferences");
            try
            {
                using var securePreferences = ReadJsonShared(securePreferencesPath);
                if (TryReadRegistrationPrefs(securePreferences.RootElement, out var registration))
                {
                    registrationPresent = true;
                    rawCreationFlags = registration.CreationFlags;
                    creationFlagsSource = "Secure Preferences";
                    fromWebStore = registration.FromWebStore;
                    wasInstalledByDefault = registration.WasInstalledByDefault;
                    wasInstalledByOem = registration.WasInstalledByOem;
                    allowFileAccess = registration.AllowFileAccess;
                    if (state != "read") state = "read";
                }
            }
            catch
            {
                // Preferences remains authoritative for Developer Mode. A missing
                // Secure Preferences file does not erase successfully read evidence.
            }
        }

        if (registrationPresent)
        {
            var flags = rawCreationFlags ?? 0;
            if (rawCreationFlags is null)
            {
                if (fromWebStore == true) flags |= FromWebStoreFlag;
                if (wasInstalledByDefault == true) flags |= WasInstalledByDefaultFlag;
                if (wasInstalledByOem == true) flags |= WasInstalledByOemFlag;
            }
            flags &= ~AllowFileAccessFlag;
            if (allowFileAccess == true) flags |= AllowFileAccessFlag;
            effectiveCreationFlags = flags;
        }

        return new
        {
            schemaVersion = 1,
            capability = "chrome-startup-pref-readonly-helper-v1",
            observedAtUtc = DateTimeOffset.UtcNow,
            state,
            lastUsedProfile,
            developerMode,
            registrationPresent,
            creationFlagsStored = rawCreationFlags,
            creationFlagsSource,
            effectiveCreationFlags,
            installedViaCdp = effectiveCreationFlags.HasValue ? (effectiveCreationFlags.Value & InstalledViaCdpFlag) != 0 : (bool?)null,
            fromWebStore,
            wasInstalledByDefault,
            wasInstalledByOem,
            allowFileAccess
        };
    }

    private static bool? ReadDeveloperMode(JsonElement root)
    {
        if (!root.TryGetProperty("extensions", out var extensions) || extensions.ValueKind != JsonValueKind.Object) return null;
        if (!extensions.TryGetProperty("ui", out var ui) || ui.ValueKind != JsonValueKind.Object) return null;
        if (!ui.TryGetProperty("developer_mode", out var value)) return null;
        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null
        };
    }

    private static bool TryReadRegistrationPrefs(JsonElement root, out RegistrationPrefs registration)
    {
        registration = default;
        if (!root.TryGetProperty("extensions", out var extensions) || extensions.ValueKind != JsonValueKind.Object) return false;
        if (!extensions.TryGetProperty("settings", out var settings) || settings.ValueKind != JsonValueKind.Object) return false;
        if (!settings.TryGetProperty(NativeHostConstants.ExtensionId, out var entry) || entry.ValueKind != JsonValueKind.Object) return false;

        registration = new RegistrationPrefs(
            IntegerValue(entry, "creation_flags"),
            BooleanValue(entry, "from_webstore"),
            BooleanValue(entry, "was_installed_by_default"),
            BooleanValue(entry, "was_installed_by_oem"),
            BooleanValue(entry, "newAllowFileAccess"));
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

    private static int? IntegerValue(JsonElement root, string name)
    {
        return root.TryGetProperty(name, out var node) && node.ValueKind == JsonValueKind.Number && node.TryGetInt32(out var value)
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

    private readonly record struct RegistrationPrefs(
        int? CreationFlags,
        bool? FromWebStore,
        bool? WasInstalledByDefault,
        bool? WasInstalledByOem,
        bool? AllowFileAccess);
}
