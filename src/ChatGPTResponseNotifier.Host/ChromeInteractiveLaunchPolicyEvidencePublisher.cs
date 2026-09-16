using System.Diagnostics;
using System.IO;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using ChatGPTResponseNotifier.Core;
using Microsoft.Win32;

namespace ChatGPTResponseNotifier.Host;

/// <summary>
/// Publishes a bounded, read-only summary of Chrome browser launch switches and
/// current-user Chrome extension policy. Raw command lines, paths, registry data,
/// URLs, and profile identifiers are never persisted.
/// </summary>
internal static class ChromeInteractiveLaunchPolicyEvidencePublisher
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const int ProcessCommandLineInformation = 60;
    private const int MaxCommandLineChars = 32768;
    private static readonly TimeSpan InitialDelay = TimeSpan.FromSeconds(11);
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
            var path = Path.Combine(evidenceRoot, "chrome-interactive-launch-policy-evidence.json");
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
        var processEvidence = CaptureProcesses();
        var policyEvidence = CaptureCurrentUserPolicy();
        return new
        {
            schemaVersion = 1,
            capability = "chrome-interactive-launch-policy-readonly-helper-v1",
            observedAtUtc = DateTimeOffset.UtcNow,
            chromeProcesses = processEvidence,
            currentUserPolicy = policyEvidence
        };
    }

    private static object CaptureProcesses()
    {
        var totalCount = 0;
        var readableCount = 0;
        var browserCount = 0;
        var browserReadableCount = 0;
        var anyDisableExtensions = false;
        var anyDisableExtensionsExcept = false;
        var anyLoadExtension = false;
        var anyUserDataDirOverride = false;
        var anyProfileDirectoryOverride = false;
        var versions = new HashSet<string>(StringComparer.Ordinal);
        var state = "read";

        try
        {
            foreach (var process in Process.GetProcessesByName("chrome"))
            {
                using (process)
                {
                    totalCount++;
                    var commandLine = TryReadCommandLine(process.Id);
                    if (commandLine is null) continue;
                    readableCount++;
                    var isBrowser = !HasSwitch(commandLine, "type");
                    if (!isBrowser) continue;
                    browserCount++;
                    browserReadableCount++;
                    anyDisableExtensions |= HasSwitch(commandLine, "disable-extensions");
                    anyDisableExtensionsExcept |= HasSwitch(commandLine, "disable-extensions-except");
                    anyLoadExtension |= HasSwitch(commandLine, "load-extension");
                    anyUserDataDirOverride |= HasSwitch(commandLine, "user-data-dir");
                    anyProfileDirectoryOverride |= HasSwitch(commandLine, "profile-directory");

                    try
                    {
                        var version = process.MainModule?.FileVersionInfo.ProductVersion;
                        if (!string.IsNullOrWhiteSpace(version) && version.Length <= 64) versions.Add(version);
                    }
                    catch
                    {
                        // Version is optional diagnostic metadata.
                    }
                }
            }
        }
        catch
        {
            state = "unavailable";
        }

        return new
        {
            state,
            totalCount,
            commandLinesReadable = readableCount,
            browserProcessCount = browserCount,
            browserCommandLinesReadable = browserReadableCount,
            anyBrowserDisableExtensions = anyDisableExtensions,
            anyBrowserDisableExtensionsExcept = anyDisableExtensionsExcept,
            anyBrowserLoadExtension = anyLoadExtension,
            anyBrowserUserDataDirOverride = anyUserDataDirOverride,
            anyBrowserProfileDirectoryOverride = anyProfileDirectoryOverride,
            observedVersions = versions.OrderBy(static value => value, StringComparer.Ordinal).Take(4).ToArray()
        };
    }

    private static string? TryReadCommandLine(int processId)
    {
        var handle = OpenProcess(ProcessQueryLimitedInformation, false, processId);
        if (handle == IntPtr.Zero) return null;
        try
        {
            _ = NtQueryInformationProcess(handle, ProcessCommandLineInformation, IntPtr.Zero, 0, out var required);
            if (required <= Marshal.SizeOf<UnicodeString>() || required > MaxCommandLineChars * sizeof(char) + 4096) return null;

            var buffer = Marshal.AllocHGlobal(required);
            try
            {
                var status = NtQueryInformationProcess(handle, ProcessCommandLineInformation, buffer, required, out _);
                if (status < 0) return null;
                var value = Marshal.PtrToStructure<UnicodeString>(buffer);
                if (value.Buffer == IntPtr.Zero || value.Length == 0 || value.Length > value.MaximumLength) return null;
                var charCount = value.Length / sizeof(char);
                if (charCount <= 0 || charCount > MaxCommandLineChars) return null;
                return Marshal.PtrToStringUni(value.Buffer, charCount);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        catch
        {
            return null;
        }
        finally
        {
            _ = CloseHandle(handle);
        }
    }

    private static bool HasSwitch(string commandLine, string name)
    {
        return Regex.IsMatch(
            commandLine,
            "(?:^|\\s)--" + Regex.Escape(name) + "(?:=|\\s|$)",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }

    private static object CaptureCurrentUserPolicy()
    {
        try
        {
            using var chrome = Registry.CurrentUser.OpenSubKey(@"Software\Policies\Google\Chrome", writable: false);
            if (chrome is null)
            {
                return new
                {
                    state = "read",
                    chromePolicyKeyPresent = false,
                    extensionInstallBlocklistHasSpecific = false,
                    extensionInstallBlocklistHasWildcard = false,
                    extensionInstallAllowlistHasSpecific = false,
                    extensionSettingsPresent = false,
                    extensionSettingsSpecificPresent = false,
                    extensionSettingsSpecificInstallationMode = (string?)null,
                    extensionSettingsWildcardPresent = false,
                    extensionSettingsWildcardInstallationMode = (string?)null,
                    extensionDeveloperModeSettings = (int?)null
                };
            }

            var blocklist = ReadListPolicy(chrome, "ExtensionInstallBlocklist");
            var allowlist = ReadListPolicy(chrome, "ExtensionInstallAllowlist");
            var settings = ReadExtensionSettings(chrome.GetValue("ExtensionSettings") as string);
            var developerModeSetting = IntegerRegistryValue(chrome.GetValue("ExtensionDeveloperModeSettings"));

            return new
            {
                state = "read",
                chromePolicyKeyPresent = true,
                extensionInstallBlocklistHasSpecific = blocklist.Contains(NativeHostConstants.ExtensionId, StringComparer.Ordinal),
                extensionInstallBlocklistHasWildcard = blocklist.Contains("*", StringComparer.Ordinal),
                extensionInstallAllowlistHasSpecific = allowlist.Contains(NativeHostConstants.ExtensionId, StringComparer.Ordinal),
                extensionSettingsPresent = settings.Present,
                extensionSettingsSpecificPresent = settings.SpecificPresent,
                extensionSettingsSpecificInstallationMode = settings.SpecificInstallationMode,
                extensionSettingsWildcardPresent = settings.WildcardPresent,
                extensionSettingsWildcardInstallationMode = settings.WildcardInstallationMode,
                extensionDeveloperModeSettings = developerModeSetting
            };
        }
        catch
        {
            return new
            {
                state = "unavailable",
                chromePolicyKeyPresent = (bool?)null,
                extensionInstallBlocklistHasSpecific = (bool?)null,
                extensionInstallBlocklistHasWildcard = (bool?)null,
                extensionInstallAllowlistHasSpecific = (bool?)null,
                extensionSettingsPresent = (bool?)null,
                extensionSettingsSpecificPresent = (bool?)null,
                extensionSettingsSpecificInstallationMode = (string?)null,
                extensionSettingsWildcardPresent = (bool?)null,
                extensionSettingsWildcardInstallationMode = (string?)null,
                extensionDeveloperModeSettings = (int?)null
            };
        }
    }

    private static IReadOnlyList<string> ReadListPolicy(RegistryKey chrome, string subKeyName)
    {
        var values = new List<string>();
        try
        {
            using var key = chrome.OpenSubKey(subKeyName, writable: false);
            if (key is null) return values;
            foreach (var name in key.GetValueNames().Take(256))
            {
                var text = key.GetValue(name) as string;
                if (!string.IsNullOrWhiteSpace(text) && text.Length <= 256) values.Add(text);
            }
        }
        catch
        {
            // Treat unreadable list values as absent from this bounded summary.
        }
        return values;
    }

    private static ExtensionSettingsSummary ReadExtensionSettings(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw) || raw.Length > 1024 * 1024)
            return new(false, false, null, false, null);
        try
        {
            using var document = JsonDocument.Parse(raw);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
                return new(true, false, null, false, null);

            var specificPresent = document.RootElement.TryGetProperty(NativeHostConstants.ExtensionId, out var specific)
                && specific.ValueKind == JsonValueKind.Object;
            var wildcardPresent = document.RootElement.TryGetProperty("*", out var wildcard)
                && wildcard.ValueKind == JsonValueKind.Object;
            return new(
                true,
                specificPresent,
                specificPresent ? BoundedInstallationMode(specific) : null,
                wildcardPresent,
                wildcardPresent ? BoundedInstallationMode(wildcard) : null);
        }
        catch
        {
            return new(true, false, null, false, null);
        }
    }

    private static string? BoundedInstallationMode(JsonElement settings)
    {
        if (!settings.TryGetProperty("installation_mode", out var mode) || mode.ValueKind != JsonValueKind.String) return null;
        var value = mode.GetString();
        return !string.IsNullOrWhiteSpace(value) && value.Length <= 64 ? value : null;
    }

    private static int? IntegerRegistryValue(object? value)
    {
        try
        {
            return value is null ? null : Convert.ToInt32(value, System.Globalization.CultureInfo.InvariantCulture);
        }
        catch
        {
            return null;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private readonly struct UnicodeString
    {
        public readonly ushort Length;
        public readonly ushort MaximumLength;
        public readonly IntPtr Buffer;
    }

    private readonly record struct ExtensionSettingsSummary(
        bool Present,
        bool SpecificPresent,
        string? SpecificInstallationMode,
        bool WildcardPresent,
        string? WildcardInstallationMode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int processInformationClass,
        IntPtr processInformation,
        int processInformationLength,
        out int returnLength);
}
