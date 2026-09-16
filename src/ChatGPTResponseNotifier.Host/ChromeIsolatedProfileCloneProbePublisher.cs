using System.Diagnostics;
using System.IO;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

/// <summary>
/// Replays only Chrome's minimum preference files in a disposable profile whose
/// basename starts with Chromium's ScopedTempDir prefix. On Windows this gives
/// the clone its own external PreferenceMACs registry store, which Chromium
/// removes when the temporary profile shuts down. The real profile and its
/// external validator are read-only.
/// </summary>
internal static class ChromeIsolatedProfileCloneProbePublisher
{
    private const long MaxJsonBytes = 32L * 1024L * 1024L;
    private const int MaxRecordKeys = 96;
    private const string ChromeRegistryRoot = @"Software\Google\Chrome";
    private static readonly TimeSpan InitialDelay = TimeSpan.FromSeconds(19);
    private static Timer? _timer;

    [ModuleInitializer]
    internal static void Initialize()
    {
        try
        {
            _timer = new Timer(
                static _ => CaptureAndPublishAsync().GetAwaiter().GetResult(),
                null,
                InitialDelay,
                Timeout.InfiniteTimeSpan);
        }
        catch { }
    }

    private static async Task CaptureAndPublishAsync()
    {
        try
        {
            var evidenceRoot = Path.Combine(NativeHostInstaller.InstallRoot, "Evidence");
            Directory.CreateDirectory(evidenceRoot);
            var path = Path.Combine(evidenceRoot, "chrome-isolated-profile-clone-evidence.json");
            var temp = path + ".next";
            File.WriteAllText(temp, JsonSerializer.Serialize(await CaptureAsync(), new JsonSerializerOptions(JsonOptions.Default) { WriteIndented = true }));
            File.Move(temp, path, overwrite: true);
        }
        catch { }
    }

    private static async Task<object> CaptureAsync()
    {
        var observedAtUtc = DateTimeOffset.UtcNow;
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var sourceUserDataRoot = Path.Combine(localAppData, "Google", "Chrome", "User Data");
        var lastUsedProfile = ReadLastUsedProfile(sourceUserDataRoot);
        var sourceProfilePath = SafeProfilePath(sourceUserDataRoot, lastUsedProfile);
        var chromePath = FindChromeExecutable();
        var chromeVersion = ReadProductVersion(chromePath);
        var realExternalBefore = ReadExternalValidator(lastUsedProfile);

        if (sourceProfilePath is null)
            return InitialResult("source-profile-unavailable", observedAtUtc, lastUsedProfile, chromeVersion, realExternalBefore);
        if (chromePath is null)
            return InitialResult("chrome-executable-unavailable", observedAtUtc, lastUsedProfile, chromeVersion, realExternalBefore);

        var localStatePath = Path.Combine(sourceUserDataRoot, "Local State");
        var preferencesPath = Path.Combine(sourceProfilePath, "Preferences");
        var securePreferencesPath = Path.Combine(sourceProfilePath, "Secure Preferences");
        if (!File.Exists(localStatePath) || !File.Exists(preferencesPath) || !File.Exists(securePreferencesPath))
            return InitialResult("source-preferences-incomplete", observedAtUtc, lastUsedProfile, chromeVersion, realExternalBefore);

        // Chromium's Windows tracked-pref implementation recognizes profile
        // basenames beginning with "scoped_dir" as disposable and attaches a
        // registry cleaner to that profile's external PreferenceMACs store.
        var isolatedProfileName = $"scoped_dir_notifier_{Guid.NewGuid():N}";
        var cloneRoot = Path.Combine(Path.GetTempPath(), $"notifier-chrome-isolated-{Guid.NewGuid():N}");
        var cloneProfile = Path.Combine(cloneRoot, isolatedProfileName);
        Process? chrome = null;
        var cleanupRecorded = false;

        try
        {
            Directory.CreateDirectory(cloneProfile);
            CopyShared(localStatePath, Path.Combine(cloneRoot, "Local State"));
            CopyShared(preferencesPath, Path.Combine(cloneProfile, "Preferences"));
            CopyShared(securePreferencesPath, Path.Combine(cloneProfile, "Secure Preferences"));

            var cloneSecurePreferences = Path.Combine(cloneProfile, "Secure Preferences");
            var before = ReadRegistrationSnapshot(cloneSecurePreferences);
            if (!before.RegistrationPresent)
                throw new ProbeException("clone-registration-missing-before-launch");

            var startInfo = new ProcessStartInfo
            {
                FileName = chromePath,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = cloneRoot
            };
            foreach (var argument in new[]
            {
                $"--user-data-dir={cloneRoot}",
                $"--profile-directory={isolatedProfileName}",
                "--remote-debugging-port=0",
                "--headless=new",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-sync",
                "--disable-default-apps",
                "--metrics-recording-only",
                "--no-pings",
                "about:blank"
            }) startInfo.ArgumentList.Add(argument);

            chrome = Process.Start(startInfo) ?? throw new ProbeException("clone-chrome-start-failed");
            var endpoint = await WaitForDevToolsEndpointAsync(cloneRoot, chrome, TimeSpan.FromSeconds(15))
                ?? throw new ProbeException("clone-devtools-unavailable");

            using var socket = new ClientWebSocket();
            using (var connectCts = new CancellationTokenSource(TimeSpan.FromSeconds(10)))
                await socket.ConnectAsync(endpoint, connectCts.Token);

            using var query = await SendCommandAsync(socket, 1, "Extensions.getExtensions", TimeSpan.FromSeconds(10));
            var extensions = ParseExtensions(query);
            var notifier = extensions.FirstOrDefault(static extension => extension.Id == NativeHostConstants.ExtensionId);

            try { using var _ = await SendCommandAsync(socket, 99, "Browser.close", TimeSpan.FromSeconds(3)); }
            catch { }

            await WaitForExitAsync(chrome, TimeSpan.FromSeconds(5));
            EnsureStopped(chrome);

            var afterStartup = ReadRegistrationSnapshot(cloneSecurePreferences);
            var addedKeys = afterStartup.RecordKeys.Except(before.RecordKeys, StringComparer.Ordinal)
                .OrderBy(static key => key, StringComparer.Ordinal).Take(MaxRecordKeys).ToArray();
            var removedKeys = before.RecordKeys.Except(afterStartup.RecordKeys, StringComparer.Ordinal)
                .OrderBy(static key => key, StringComparer.Ordinal).Take(MaxRecordKeys).ToArray();

            var isolatedExternalAfter = ReadExternalValidator(isolatedProfileName);
            var realExternalAfter = ReadExternalValidator(lastUsedProfile);
            var realExternalChanged = CompareExternalValidators(realExternalBefore, realExternalAfter);

            var deleted = TryDeleteDirectory(cloneRoot);
            cleanupRecorded = true;
            return new
            {
                schemaVersion = 1,
                capability = "chrome-isolated-profile-clone-readonly-source-v1",
                observedAtUtc,
                state = "complete",
                lastUsedProfile,
                chromeVersion,
                sourceProfileMutated = false,
                copiedFiles = 3,
                copiedBrowsingDatabases = 0,
                chatGptNavigationPerformed = false,
                repairAttempted = false,
                isolatedProfileUsesScopedDirPrefix = isolatedProfileName.StartsWith("scoped_dir", StringComparison.OrdinalIgnoreCase),
                cloneRegistrationPresentBefore = before.RegistrationPresent,
                cloneLegacyAuthenticatorPresentBefore = before.LegacyAuthenticatorPresent,
                cloneEncryptedAuthenticatorPresentBefore = before.EncryptedAuthenticatorPresent,
                rawUnpackedRegistrationCountBefore = before.RawUnpackedRegistrationCount,
                notifierListedByChrome = notifier is not null,
                notifierEnabledByChrome = notifier?.Enabled,
                notifierVersionByChrome = notifier?.Version,
                loadedExtensionCount = extensions.Count,
                cloneRegistrationPresentAfterStartup = afterStartup.RegistrationPresent,
                cloneLegacyAuthenticatorPresentAfterStartup = afterStartup.LegacyAuthenticatorPresent,
                cloneEncryptedAuthenticatorPresentAfterStartup = afterStartup.EncryptedAuthenticatorPresent,
                rawUnpackedRegistrationCountAfterStartup = afterStartup.RawUnpackedRegistrationCount,
                recordKeysAddedByStartup = addedKeys,
                recordKeysRemovedByStartup = removedKeys,
                realExternalValidatorReadableBefore = realExternalBefore.Readable,
                realExternalValidatorKeyPresentBefore = realExternalBefore.KeyPresent,
                realExternalValidatorValueCountBefore = realExternalBefore.ValueCount,
                realExternalNotifierValuePresentBefore = realExternalBefore.NotifierValuePresent,
                realExternalValidatorReadableAfter = realExternalAfter.Readable,
                realExternalValidatorKeyPresentAfter = realExternalAfter.KeyPresent,
                realExternalValidatorValueCountAfter = realExternalAfter.ValueCount,
                realExternalNotifierValuePresentAfter = realExternalAfter.NotifierValuePresent,
                realExternalValidatorChangedByProbe = realExternalChanged,
                isolatedExternalValidatorReadableAfter = isolatedExternalAfter.Readable,
                isolatedExternalValidatorPresentAfter = isolatedExternalAfter.KeyPresent,
                temporaryCloneDeleted = deleted
            };
        }
        catch (Exception ex)
        {
            EnsureStopped(chrome);
            var realExternalAfter = ReadExternalValidator(lastUsedProfile);
            var changed = CompareExternalValidators(realExternalBefore, realExternalAfter);
            var isolatedExternalAfter = ReadExternalValidator(isolatedProfileName);
            var deleted = TryDeleteDirectory(cloneRoot);
            cleanupRecorded = true;
            return new
            {
                schemaVersion = 1,
                capability = "chrome-isolated-profile-clone-readonly-source-v1",
                observedAtUtc,
                state = "probe-error",
                lastUsedProfile,
                chromeVersion,
                errorCode = ex is ProbeException probe ? probe.Code : ex.GetType().Name,
                sourceProfileMutated = false,
                copiedBrowsingDatabases = 0,
                chatGptNavigationPerformed = false,
                repairAttempted = false,
                isolatedProfileUsesScopedDirPrefix = true,
                realExternalValidatorReadableBefore = realExternalBefore.Readable,
                realExternalValidatorKeyPresentBefore = realExternalBefore.KeyPresent,
                realExternalValidatorValueCountBefore = realExternalBefore.ValueCount,
                realExternalNotifierValuePresentBefore = realExternalBefore.NotifierValuePresent,
                realExternalValidatorReadableAfter = realExternalAfter.Readable,
                realExternalValidatorKeyPresentAfter = realExternalAfter.KeyPresent,
                realExternalValidatorValueCountAfter = realExternalAfter.ValueCount,
                realExternalNotifierValuePresentAfter = realExternalAfter.NotifierValuePresent,
                realExternalValidatorChangedByProbe = changed,
                isolatedExternalValidatorReadableAfter = isolatedExternalAfter.Readable,
                isolatedExternalValidatorPresentAfter = isolatedExternalAfter.KeyPresent,
                temporaryCloneDeleted = deleted
            };
        }
        finally
        {
            if (chrome is not null) chrome.Dispose();
            if (!cleanupRecorded) _ = TryDeleteDirectory(cloneRoot);
        }
    }

    private static object InitialResult(
        string state,
        DateTimeOffset observedAtUtc,
        string? lastUsedProfile,
        string? chromeVersion,
        ExternalValidatorSnapshot external) => new
    {
        schemaVersion = 1,
        capability = "chrome-isolated-profile-clone-readonly-source-v1",
        observedAtUtc,
        state,
        lastUsedProfile,
        chromeVersion,
        sourceProfileMutated = false,
        copiedBrowsingDatabases = 0,
        chatGptNavigationPerformed = false,
        repairAttempted = false,
        realExternalValidatorReadableBefore = external.Readable,
        realExternalValidatorKeyPresentBefore = external.KeyPresent,
        realExternalValidatorValueCountBefore = external.ValueCount,
        realExternalNotifierValuePresentBefore = external.NotifierValuePresent,
        realExternalValidatorChangedByProbe = (bool?)null,
        temporaryCloneDeleted = (bool?)null
    };

    private static ExternalValidatorSnapshot ReadExternalValidator(string? profileName)
    {
        if (string.IsNullOrWhiteSpace(profileName) || profileName.Length > 64 || profileName.IndexOfAny(new[] { '\\', '/' }) >= 0)
            return ExternalValidatorSnapshot.Unavailable;

        try
        {
            using var baseKey = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry32);
            var path = $@"{ChromeRegistryRoot}\PreferenceMACs\{profileName}\extensions.settings";
            using var key = baseKey.OpenSubKey(path, writable: false);
            if (key is null)
                return new ExternalValidatorSnapshot(true, false, 0, false, EmptyDigest, EmptyDigest);

            var names = key.GetValueNames().OrderBy(static name => name, StringComparer.Ordinal).ToArray();
            var storeBuilder = new StringBuilder();
            string? notifierMaterial = null;
            foreach (var name in names)
            {
                var value = key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames)?.ToString() ?? string.Empty;
                storeBuilder.Append(name.Length).Append(':').Append(name).Append('|')
                    .Append(value.Length).Append(':').Append(value).Append('\n');
                if (string.Equals(name, NativeHostConstants.ExtensionId, StringComparison.Ordinal))
                    notifierMaterial = value;
            }

            return new ExternalValidatorSnapshot(
                true,
                true,
                names.Length,
                notifierMaterial is not null,
                Digest(storeBuilder.ToString()),
                notifierMaterial is null ? EmptyDigest : Digest(notifierMaterial));
        }
        catch
        {
            return ExternalValidatorSnapshot.Unavailable;
        }
    }

    private static bool? CompareExternalValidators(ExternalValidatorSnapshot before, ExternalValidatorSnapshot after)
    {
        if (!before.Readable || !after.Readable) return null;
        return before.KeyPresent != after.KeyPresent
            || before.ValueCount != after.ValueCount
            || before.NotifierValuePresent != after.NotifierValuePresent
            || !string.Equals(before.StoreDigest, after.StoreDigest, StringComparison.Ordinal)
            || !string.Equals(before.NotifierDigest, after.NotifierDigest, StringComparison.Ordinal);
    }

    private static string EmptyDigest => Digest(string.Empty);

    private static string Digest(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static async Task<Uri?> WaitForDevToolsEndpointAsync(string cloneRoot, Process process, TimeSpan timeout)
    {
        var path = Path.Combine(cloneRoot, "DevToolsActivePort");
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (process.HasExited) return null;
            try
            {
                if (File.Exists(path))
                {
                    var lines = File.ReadAllLines(path);
                    if (lines.Length >= 2 && int.TryParse(lines[0], out var port) && port is > 0 and <= 65535)
                    {
                        var wsPath = lines[1].Trim();
                        if (wsPath.StartsWith("/", StringComparison.Ordinal)) return new Uri($"ws://127.0.0.1:{port}{wsPath}");
                    }
                }
            }
            catch { }
            await Task.Delay(100);
        }
        return null;
    }

    private static async Task<JsonDocument> SendCommandAsync(ClientWebSocket socket, int id, string method, TimeSpan timeout)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new Dictionary<string, object?> { ["id"] = id, ["method"] = method }, JsonOptions.Default));
        using var cts = new CancellationTokenSource(timeout);
        await socket.SendAsync(bytes, WebSocketMessageType.Text, true, cts.Token);
        while (true)
        {
            var text = await ReceiveTextAsync(socket, cts.Token);
            using var candidate = JsonDocument.Parse(text);
            if (!candidate.RootElement.TryGetProperty("id", out var idNode) || !idNode.TryGetInt32(out var responseId) || responseId != id) continue;
            if (candidate.RootElement.TryGetProperty("error", out var error)) throw new InvalidOperationException(error.GetRawText());
            return JsonDocument.Parse(text);
        }
    }

    private static async Task<string> ReceiveTextAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        var buffer = new byte[8192];
        using var stream = new MemoryStream();
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close) throw new IOException("Chrome DevTools WebSocket closed before response.");
            stream.Write(buffer, 0, result.Count);
            if (stream.Length > 2 * 1024 * 1024) throw new InvalidDataException("Chrome DevTools response exceeded diagnostic size bound.");
            if (result.EndOfMessage) return Encoding.UTF8.GetString(stream.ToArray());
        }
    }

    private static List<ExtensionInfo> ParseExtensions(JsonDocument response)
    {
        var list = new List<ExtensionInfo>();
        if (!response.RootElement.TryGetProperty("result", out var result) || result.ValueKind != JsonValueKind.Object) return list;
        if (!result.TryGetProperty("extensions", out var extensions) || extensions.ValueKind != JsonValueKind.Array) return list;
        foreach (var item in extensions.EnumerateArray().Take(256))
        {
            if (item.ValueKind != JsonValueKind.Object) continue;
            var id = StringValue(item, "id");
            if (!string.IsNullOrWhiteSpace(id)) list.Add(new ExtensionInfo(id, StringValue(item, "version"), BooleanValue(item, "enabled")));
        }
        return list;
    }

    private static RegistrationSnapshot ReadRegistrationSnapshot(string securePreferencesPath)
    {
        using var document = ReadJsonShared(securePreferencesPath);
        var root = document.RootElement;
        var keys = Array.Empty<string>();
        var registrationPresent = false;
        var rawUnpackedCount = 0;
        if (TryGetPath(root, new[] { "extensions", "settings" }, out var settings) && settings.ValueKind == JsonValueKind.Object)
        {
            foreach (var entry in settings.EnumerateObject().Take(4096))
            {
                if (entry.Value.ValueKind != JsonValueKind.Object) continue;
                if (IntegerValue(entry.Value, "location") == 4) rawUnpackedCount++;
                if (!string.Equals(entry.Name, NativeHostConstants.ExtensionId, StringComparison.Ordinal)) continue;
                registrationPresent = true;
                keys = entry.Value.EnumerateObject()
                    .Select(static property => property.Name)
                    .Where(static name => name.Length is > 0 and <= 96 && name.All(static ch => char.IsLetterOrDigit(ch) || ch == '_' || ch == '-'))
                    .Distinct(StringComparer.Ordinal)
                    .OrderBy(static name => name, StringComparer.Ordinal)
                    .Take(MaxRecordKeys)
                    .ToArray();
            }
        }

        var legacy = HasNonEmptyStringAtPath(root, "protection", "macs", "extensions", "settings", NativeHostConstants.ExtensionId);
        var encrypted = HasNonEmptyStringAtPath(root, "protection", "macs", "extensions", "settings_encrypted_hash", NativeHostConstants.ExtensionId);
        return new RegistrationSnapshot(registrationPresent, legacy, encrypted, rawUnpackedCount, keys);
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

    private static string? FindChromeExecutable()
    {
        foreach (var basePath in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) })
        {
            if (string.IsNullOrWhiteSpace(basePath)) continue;
            var candidate = Path.Combine(basePath, "Google", "Chrome", "Application", "chrome.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private static string? ReadProductVersion(string? path)
    {
        try
        {
            var value = path is null ? null : FileVersionInfo.GetVersionInfo(path).ProductVersion;
            return !string.IsNullOrWhiteSpace(value) && value.Length <= 64 ? value : null;
        }
        catch { return null; }
    }

    private static void CopyShared(string source, string destination)
    {
        using var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        input.CopyTo(output);
        output.Flush(flushToDisk: true);
    }

    private static async Task WaitForExitAsync(Process process, TimeSpan timeout)
    {
        if (process.HasExited) return;
        using var cts = new CancellationTokenSource(timeout);
        try { await process.WaitForExitAsync(cts.Token); } catch (OperationCanceledException) { }
    }

    private static void EnsureStopped(Process? process)
    {
        if (process is null) return;
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(3000);
            }
        }
        catch { }
    }

    private static bool TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
            return !Directory.Exists(path);
        }
        catch { return false; }
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

    private static bool HasNonEmptyStringAtPath(JsonElement root, params string[] path) =>
        TryGetPath(root, path, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString());

    private static string? StringValue(JsonElement root, string name) =>
        root.TryGetProperty(name, out var node) && node.ValueKind == JsonValueKind.String ? node.GetString() : null;

    private static bool? BooleanValue(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var node)) return null;
        return node.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null };
    }

    private static int? IntegerValue(JsonElement root, string name) =>
        root.TryGetProperty(name, out var node) && node.ValueKind == JsonValueKind.Number && node.TryGetInt32(out var value) ? value : null;

    private sealed record ExtensionInfo(string Id, string? Version, bool? Enabled);
    private readonly record struct RegistrationSnapshot(bool RegistrationPresent, bool LegacyAuthenticatorPresent, bool EncryptedAuthenticatorPresent, int RawUnpackedRegistrationCount, string[] RecordKeys);
    private readonly record struct ExternalValidatorSnapshot(bool Readable, bool KeyPresent, int? ValueCount, bool? NotifierValuePresent, string? StoreDigest, string? NotifierDigest)
    {
        public static ExternalValidatorSnapshot Unavailable => new(false, false, null, null, null, null);
    }

    private sealed class ProbeException(string code) : Exception(code)
    {
        public string Code { get; } = code;
    }
}
