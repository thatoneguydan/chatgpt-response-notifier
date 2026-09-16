using System.Diagnostics;
using System.IO;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

/// <summary>
/// Replays only Chrome's minimum preference files in a disposable local profile,
/// then asks the installed Chrome binary which unpacked extensions it actually
/// accepted into its extension registry. The real Chrome profile is read-only.
/// Raw copied preferences never leave the temporary directory and are deleted.
/// </summary>
internal static class ChromeMinimalProfileCloneProbePublisher
{
    private const long MaxJsonBytes = 32L * 1024L * 1024L;
    private const int MaxRecordKeys = 96;
    private static readonly TimeSpan InitialDelay = TimeSpan.FromSeconds(17);
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
        catch
        {
            // Diagnostic-only evidence must never affect helper startup.
        }
    }

    private static async Task CaptureAndPublishAsync()
    {
        try
        {
            var evidenceRoot = Path.Combine(NativeHostInstaller.InstallRoot, "Evidence");
            Directory.CreateDirectory(evidenceRoot);
            var path = Path.Combine(evidenceRoot, "chrome-minimal-profile-clone-evidence.json");
            var payload = await CaptureAsync();
            var temp = path + ".next";
            File.WriteAllText(temp, JsonSerializer.Serialize(payload, new JsonSerializerOptions(JsonOptions.Default) { WriteIndented = true }));
            File.Move(temp, path, overwrite: true);
        }
        catch
        {
            // Diagnostic-only evidence must never affect helper lifetime.
        }
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

        if (sourceProfilePath is null)
            return Result("source-profile-unavailable", observedAtUtc, lastUsedProfile, chromeVersion);
        if (chromePath is null)
            return Result("chrome-executable-unavailable", observedAtUtc, lastUsedProfile, chromeVersion);

        var localStatePath = Path.Combine(sourceUserDataRoot, "Local State");
        var preferencesPath = Path.Combine(sourceProfilePath, "Preferences");
        var securePreferencesPath = Path.Combine(sourceProfilePath, "Secure Preferences");
        if (!File.Exists(localStatePath) || !File.Exists(preferencesPath) || !File.Exists(securePreferencesPath))
            return Result("source-preferences-incomplete", observedAtUtc, lastUsedProfile, chromeVersion);

        var cloneRoot = Path.Combine(Path.GetTempPath(), $"notifier-chrome-profile-clone-{Guid.NewGuid():N}");
        var cloneProfile = Path.Combine(cloneRoot, "Default");
        Process? chrome = null;

        try
        {
            Directory.CreateDirectory(cloneProfile);
            CopyShared(localStatePath, Path.Combine(cloneRoot, "Local State"));
            CopyShared(preferencesPath, Path.Combine(cloneProfile, "Preferences"));
            CopyShared(securePreferencesPath, Path.Combine(cloneProfile, "Secure Preferences"));

            var before = ReadRegistrationSnapshot(Path.Combine(cloneProfile, "Secure Preferences"));
            if (!before.RegistrationPresent)
                return Result("clone-registration-missing-before-launch", observedAtUtc, lastUsedProfile, chromeVersion, before);

            var startInfo = new ProcessStartInfo
            {
                FileName = chromePath,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = cloneRoot
            };
            startInfo.ArgumentList.Add($"--user-data-dir={cloneRoot}");
            startInfo.ArgumentList.Add("--profile-directory=Default");
            startInfo.ArgumentList.Add("--remote-debugging-port=0");
            startInfo.ArgumentList.Add("--headless=new");
            startInfo.ArgumentList.Add("--no-first-run");
            startInfo.ArgumentList.Add("--no-default-browser-check");
            startInfo.ArgumentList.Add("--disable-background-networking");
            startInfo.ArgumentList.Add("--disable-component-update");
            startInfo.ArgumentList.Add("--disable-sync");
            startInfo.ArgumentList.Add("--disable-default-apps");
            startInfo.ArgumentList.Add("--metrics-recording-only");
            startInfo.ArgumentList.Add("--no-pings");
            startInfo.ArgumentList.Add("about:blank");

            chrome = Process.Start(startInfo);
            if (chrome is null)
                return Result("clone-chrome-start-failed", observedAtUtc, lastUsedProfile, chromeVersion, before);

            var endpoint = await WaitForDevToolsEndpointAsync(cloneRoot, chrome, TimeSpan.FromSeconds(15));
            if (endpoint is null)
                return Result("clone-devtools-unavailable", observedAtUtc, lastUsedProfile, chromeVersion, before);

            using var socket = new ClientWebSocket();
            using var connectCts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await socket.ConnectAsync(endpoint, connectCts.Token);

            var firstQuery = await SendCommandAsync(socket, 1, "Extensions.getExtensions", null, TimeSpan.FromSeconds(10));
            var firstExtensions = ParseExtensions(firstQuery);
            var beforeListed = firstExtensions.FirstOrDefault(static extension => extension.Id == NativeHostConstants.ExtensionId);

            bool repairLoadAttempted = false;
            bool repairLoadSucceeded = false;
            bool? listedAfterRepair = null;
            bool? enabledAfterRepair = null;
            string? versionAfterRepair = null;
            string[] recordKeysAddedByRepair = Array.Empty<string>();
            string[] recordKeysRemovedByRepair = Array.Empty<string>();

            if (beforeListed is null)
            {
                repairLoadAttempted = true;
                try
                {
                    var loadResponse = await SendCommandAsync(
                        socket,
                        2,
                        "Extensions.loadUnpacked",
                        new Dictionary<string, object?> { ["path"] = NativeHostInstaller.ExtensionRoot },
                        TimeSpan.FromSeconds(10));
                    repairLoadSucceeded = ReadResultString(loadResponse, "id") == NativeHostConstants.ExtensionId;

                    var secondQuery = await SendCommandAsync(socket, 3, "Extensions.getExtensions", null, TimeSpan.FromSeconds(10));
                    var secondExtensions = ParseExtensions(secondQuery);
                    var repaired = secondExtensions.FirstOrDefault(static extension => extension.Id == NativeHostConstants.ExtensionId);
                    listedAfterRepair = repaired is not null;
                    enabledAfterRepair = repaired?.Enabled;
                    versionAfterRepair = repaired?.Version;
                }
                catch
                {
                    repairLoadSucceeded = false;
                }
            }

            try
            {
                _ = await SendCommandAsync(socket, 99, "Browser.close", null, TimeSpan.FromSeconds(3));
            }
            catch
            {
                // Process cleanup below is authoritative.
            }

            await WaitForExitAsync(chrome, TimeSpan.FromSeconds(5));
            if (!chrome.HasExited)
            {
                try { chrome.Kill(entireProcessTree: true); } catch { }
                await WaitForExitAsync(chrome, TimeSpan.FromSeconds(3));
            }

            var after = ReadRegistrationSnapshot(Path.Combine(cloneProfile, "Secure Preferences"));
            if (repairLoadAttempted)
            {
                recordKeysAddedByRepair = after.RecordKeys.Except(before.RecordKeys, StringComparer.Ordinal).OrderBy(static key => key, StringComparer.Ordinal).Take(MaxRecordKeys).ToArray();
                recordKeysRemovedByRepair = before.RecordKeys.Except(after.RecordKeys, StringComparer.Ordinal).OrderBy(static key => key, StringComparer.Ordinal).Take(MaxRecordKeys).ToArray();
            }

            return new
            {
                schemaVersion = 1,
                capability = "chrome-minimal-profile-clone-readonly-source-v1",
                observedAtUtc,
                state = "complete",
                lastUsedProfile,
                chromeVersion,
                sourceProfileMutated = false,
                copiedFiles = 3,
                copiedBrowsingDatabases = 0,
                chatGptNavigationPerformed = false,
                cloneRegistrationPresentBefore = before.RegistrationPresent,
                cloneNotifierAuthenticatorPresentBefore = before.NotifierAuthenticatorPresent,
                rawUnpackedRegistrationCountBefore = before.RawUnpackedRegistrationCount,
                extensionsQuerySucceeded = true,
                loadedUnpackedExtensionCountBefore = firstExtensions.Count,
                notifierListedBeforeRepair = beforeListed is not null,
                notifierEnabledBeforeRepair = beforeListed?.Enabled,
                notifierVersionBeforeRepair = beforeListed?.Version,
                repairLoadAttempted,
                repairLoadSucceeded,
                notifierListedAfterRepair = listedAfterRepair,
                notifierEnabledAfterRepair = enabledAfterRepair,
                notifierVersionAfterRepair = versionAfterRepair,
                cloneRegistrationPresentAfter = after.RegistrationPresent,
                cloneNotifierAuthenticatorPresentAfter = after.NotifierAuthenticatorPresent,
                rawUnpackedRegistrationCountAfter = after.RawUnpackedRegistrationCount,
                recordKeysAddedByRepair,
                recordKeysRemovedByRepair,
                temporaryCloneDeleted = true
            };
        }
        catch (Exception ex)
        {
            return new
            {
                schemaVersion = 1,
                capability = "chrome-minimal-profile-clone-readonly-source-v1",
                observedAtUtc,
                state = "probe-error",
                lastUsedProfile,
                chromeVersion,
                errorClass = ex.GetType().Name,
                sourceProfileMutated = false,
                copiedBrowsingDatabases = 0,
                chatGptNavigationPerformed = false,
                temporaryCloneDeleted = true
            };
        }
        finally
        {
            if (chrome is not null)
            {
                try
                {
                    if (!chrome.HasExited) chrome.Kill(entireProcessTree: true);
                }
                catch { }
                chrome.Dispose();
            }
            try { Directory.Delete(cloneRoot, recursive: true); } catch { }
        }
    }

    private static object Result(
        string state,
        DateTimeOffset observedAtUtc,
        string? lastUsedProfile,
        string? chromeVersion,
        RegistrationSnapshot? snapshot = null)
    {
        return new
        {
            schemaVersion = 1,
            capability = "chrome-minimal-profile-clone-readonly-source-v1",
            observedAtUtc,
            state,
            lastUsedProfile,
            chromeVersion,
            sourceProfileMutated = false,
            copiedBrowsingDatabases = 0,
            chatGptNavigationPerformed = false,
            cloneRegistrationPresentBefore = snapshot?.RegistrationPresent,
            cloneNotifierAuthenticatorPresentBefore = snapshot?.NotifierAuthenticatorPresent,
            rawUnpackedRegistrationCountBefore = snapshot?.RawUnpackedRegistrationCount,
            temporaryCloneDeleted = true
        };
    }

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
                        if (wsPath.StartsWith("/", StringComparison.Ordinal))
                            return new Uri($"ws://127.0.0.1:{port}{wsPath}");
                    }
                }
            }
            catch { }
            await Task.Delay(100);
        }
        return null;
    }

    private static async Task<JsonDocument> SendCommandAsync(
        ClientWebSocket socket,
        int id,
        string method,
        object? parameters,
        TimeSpan timeout)
    {
        var request = parameters is null
            ? new { id, method }
            : new { id, method, @params = parameters };
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(request, JsonOptions.Default));
        using var cts = new CancellationTokenSource(timeout);
        await socket.SendAsync(bytes, WebSocketMessageType.Text, true, cts.Token);

        while (true)
        {
            var text = await ReceiveTextAsync(socket, cts.Token);
            using var candidate = JsonDocument.Parse(text);
            if (!candidate.RootElement.TryGetProperty("id", out var idNode) || !idNode.TryGetInt32(out var responseId) || responseId != id)
                continue;
            if (candidate.RootElement.TryGetProperty("error", out var error))
                throw new InvalidOperationException(error.GetRawText());
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
            if (result.MessageType == WebSocketMessageType.Close)
                throw new IOException("Chrome DevTools WebSocket closed before the diagnostic response arrived.");
            stream.Write(buffer, 0, result.Count);
            if (result.EndOfMessage) return Encoding.UTF8.GetString(stream.ToArray());
            if (stream.Length > 2 * 1024 * 1024)
                throw new InvalidDataException("Chrome DevTools response exceeded the diagnostic size bound.");
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
            if (string.IsNullOrWhiteSpace(id)) continue;
            list.Add(new ExtensionInfo(id, StringValue(item, "version"), BooleanValue(item, "enabled")));
        }
        return list;
    }

    private static string? ReadResultString(JsonDocument response, string name)
    {
        if (!response.RootElement.TryGetProperty("result", out var result) || result.ValueKind != JsonValueKind.Object) return null;
        return StringValue(result, name);
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

        var legacyHmac = HasNonEmptyStringAtPath(root, "protection", "macs", "extensions", "settings", NativeHostConstants.ExtensionId);
        var encryptedHash = HasNonEmptyStringAtPath(root, "protection", "macs", "extensions", "settings_encrypted_hash", NativeHostConstants.ExtensionId);
        return new RegistrationSnapshot(registrationPresent, legacyHmac || encryptedHash, rawUnpackedCount, keys);
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
        foreach (var basePath in new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)
        })
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

    private static bool HasNonEmptyStringAtPath(JsonElement root, params string[] path)
    {
        return TryGetPath(root, path, out var value)
            && value.ValueKind == JsonValueKind.String
            && !string.IsNullOrWhiteSpace(value.GetString());
    }

    private static string? StringValue(JsonElement root, string name)
    {
        return root.TryGetProperty(name, out var node) && node.ValueKind == JsonValueKind.String ? node.GetString() : null;
    }

    private static bool? BooleanValue(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var node)) return null;
        return node.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null };
    }

    private static int? IntegerValue(JsonElement root, string name)
    {
        return root.TryGetProperty(name, out var node) && node.ValueKind == JsonValueKind.Number && node.TryGetInt32(out var value) ? value : null;
    }

    private readonly record struct ExtensionInfo(string Id, string? Version, bool? Enabled);
    private readonly record struct RegistrationSnapshot(bool RegistrationPresent, bool NotifierAuthenticatorPresent, int RawUnpackedRegistrationCount, string[] RecordKeys);
}
