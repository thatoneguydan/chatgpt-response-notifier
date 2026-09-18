using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace ChatGPTResponseNotifier.Core;

public sealed record InstalledBundle(string Version, string SourceCommit, string HostExecutablePath, string ExtensionPath);

public sealed record UpdateInstallRequest(string Version, string SourceCommit, string ArchivePath, string ArchiveSha256);

public static class BundleInstaller
{
    private sealed class BundleManifest
    {
        public int SchemaVersion { get; init; }
        public string Project { get; init; } = string.Empty;
        public string Version { get; init; } = string.Empty;
        public string SourceCommit { get; init; } = string.Empty;
        public List<BundleFileRecord> Files { get; init; } = new();
    }

    private sealed class BundleFileRecord
    {
        public string Path { get; init; } = string.Empty;
        public long Bytes { get; init; }
        public string Sha256 { get; init; } = string.Empty;
    }

    public static InstalledBundle InstallArchive(UpdateInstallRequest request)
    {
        ValidateRequest(request);
        var archivePath = Path.GetFullPath(request.ArchivePath);
        if (!File.Exists(archivePath)) throw new FileNotFoundException("Update archive does not exist.", archivePath);

        var archiveHash = HashFile(archivePath);
        if (!archiveHash.Equals(request.ArchiveSha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Update archive SHA-256 does not match the published digest.");

        var tempRoot = Path.Combine(Path.GetTempPath(), "ChatGPTResponseNotifier", "update-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempRoot);
        try
        {
            ZipFile.ExtractToDirectory(archivePath, tempRoot);
            return InstallExtractedBundle(tempRoot, request.Version, request.SourceCommit);
        }
        finally
        {
            try { Directory.Delete(tempRoot, recursive: true); } catch { }
        }
    }

    public static InstalledBundle InstallExtractedBundle(string bundleRoot, string? expectedVersion = null, string? expectedSourceCommit = null)
    {
        bundleRoot = Path.GetFullPath(bundleRoot);
        var manifestPath = Path.Combine(bundleRoot, "bundle-manifest.json");
        if (!File.Exists(manifestPath)) throw new InvalidDataException("Bundle manifest is missing.");

        var manifest = JsonSerializer.Deserialize<BundleManifest>(File.ReadAllText(manifestPath), JsonOptions.Default)
            ?? throw new InvalidDataException("Bundle manifest could not be parsed.");
        ValidateManifest(manifest, expectedVersion, expectedSourceCommit);
        VerifyBundleFiles(bundleRoot, manifest);

        var bundledHost = Path.Combine(bundleRoot, "ChatGPTResponseNotifier.Host.exe");
        var bundledExtension = Path.Combine(bundleRoot, "extension");
        if (!File.Exists(bundledHost)) throw new InvalidDataException("Bundle helper executable is missing.");
        if (!Directory.Exists(bundledExtension)) throw new InvalidDataException("Bundle extension directory is missing.");

        Directory.CreateDirectory(NativeHostInstaller.InstallRoot);
        Directory.CreateDirectory(NativeHostInstaller.HostVersionsRoot);
        Directory.CreateDirectory(NativeHostInstaller.DataRoot);

        var hostRoot = NativeHostInstaller.HostVersionRoot(manifest.Version);
        Directory.CreateDirectory(hostRoot);
        var installedHost = NativeHostInstaller.HostExecutablePath(manifest.Version);
        ReplaceHostExecutable(bundledHost, installedHost);

        UpdateDirectoryPreservingRoot(bundledExtension, NativeHostInstaller.ExtensionRoot);

        var state = new
        {
            schemaVersion = 1,
            version = manifest.Version,
            sourceCommit = manifest.SourceCommit,
            installedAtUtc = DateTimeOffset.UtcNow,
            hostExecutablePath = installedHost,
            extensionPath = NativeHostInstaller.ExtensionRoot,
            transport = "localhost-websocket"
        };
        File.WriteAllText(NativeHostInstaller.InstallStatePath, JsonSerializer.Serialize(state, new JsonSerializerOptions(JsonOptions.Default) { WriteIndented = true }));

        return new InstalledBundle(manifest.Version, manifest.SourceCommit, installedHost, NativeHostInstaller.ExtensionRoot);
    }

    public static string? ReadInstalledExtensionVersion()
    {
        var manifestPath = Path.Combine(NativeHostInstaller.ExtensionRoot, "manifest.json");
        if (!File.Exists(manifestPath)) return null;
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(manifestPath));
            return document.RootElement.TryGetProperty("version", out var version) && version.ValueKind == JsonValueKind.String
                ? version.GetString()
                : null;
        }
        catch
        {
            return null;
        }
    }

    public static string? ReadInstalledSourceCommit()
    {
        if (!File.Exists(NativeHostInstaller.InstallStatePath)) return null;
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(NativeHostInstaller.InstallStatePath));
            if (!document.RootElement.TryGetProperty("sourceCommit", out var source) || source.ValueKind != JsonValueKind.String) return null;
            var value = (source.GetString() ?? string.Empty).Trim().ToLowerInvariant();
            return value.Length == 40 && value.All(Uri.IsHexDigit) ? value : null;
        }
        catch
        {
            return null;
        }
    }

    private static void ValidateVersion(string version)
    {
        var parts = version.Split('.');
        if (parts.Length < 2 || parts.Length > 4 || parts.Any(part => !int.TryParse(part, out var value) || value < 0))
            throw new InvalidDataException("Update version is invalid.");
    }

    private static void ValidateRequest(UpdateInstallRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Version)) throw new InvalidDataException("Update version is required.");
        ValidateVersion(request.Version);
        if (string.IsNullOrWhiteSpace(request.SourceCommit)) throw new InvalidDataException("Update source commit is required.");
        if (string.IsNullOrWhiteSpace(request.ArchivePath)) throw new InvalidDataException("Update archive path is required.");
        if (request.ArchiveSha256.Length != 64 || request.ArchiveSha256.Any(ch => !Uri.IsHexDigit(ch)))
            throw new InvalidDataException("Update archive SHA-256 is invalid.");
    }

    private static void ValidateManifest(BundleManifest manifest, string? expectedVersion, string? expectedSourceCommit)
    {
        if (manifest.SchemaVersion != 1) throw new InvalidDataException("Unsupported bundle manifest schema.");
        if (!string.Equals(manifest.Project, "ChatGPT Response Notifier", StringComparison.Ordinal))
            throw new InvalidDataException("Bundle project identity is invalid.");
        if (string.IsNullOrWhiteSpace(manifest.Version)) throw new InvalidDataException("Bundle version is missing.");
        if (string.IsNullOrWhiteSpace(manifest.SourceCommit)) throw new InvalidDataException("Bundle source commit is missing.");
        if (!string.IsNullOrWhiteSpace(expectedVersion) && !string.Equals(manifest.Version, expectedVersion, StringComparison.Ordinal))
            throw new InvalidDataException("Bundle version does not match the requested update.");
        if (!string.IsNullOrWhiteSpace(expectedSourceCommit) && !string.Equals(manifest.SourceCommit, expectedSourceCommit, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Bundle source commit does not match the requested update.");
    }

    private static void VerifyBundleFiles(string bundleRoot, BundleManifest manifest)
    {
        if (manifest.Files.Count == 0) throw new InvalidDataException("Bundle manifest has no file inventory.");
        foreach (var record in manifest.Files)
        {
            var relative = record.Path.Replace('/', Path.DirectorySeparatorChar);
            if (Path.IsPathRooted(relative)) throw new InvalidDataException("Bundle inventory contains an absolute path.");
            var full = Path.GetFullPath(Path.Combine(bundleRoot, relative));
            var rootPrefix = bundleRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!full.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Bundle inventory escapes the bundle root.");
            if (!File.Exists(full)) throw new InvalidDataException($"Bundle file is missing: {record.Path}");
            var info = new FileInfo(full);
            if (info.Length != record.Bytes) throw new InvalidDataException($"Bundle file size mismatch: {record.Path}");
            if (!HashFile(full).Equals(record.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException($"Bundle file SHA-256 mismatch: {record.Path}");
        }
    }

    private static string HashFile(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static void ReplaceHostExecutable(string source, string destination)
    {
        if (File.Exists(destination))
        {
            try
            {
                if (new FileInfo(source).Length == new FileInfo(destination).Length &&
                    HashFile(source).Equals(HashFile(destination), StringComparison.OrdinalIgnoreCase))
                {
                    // Reinstalling the exact same candidate must be idempotent. A running
                    // helper can keep its image locked briefly after shutdown; rewriting an
                    // identical binary buys nothing and creates an avoidable race.
                    return;
                }
            }
            catch (IOException)
            {
                // If the existing file cannot be read reliably, fall through to the
                // bounded replacement path rather than assuming identity.
            }
            catch (UnauthorizedAccessException)
            {
                // Same as above: never treat an unverifiable file as identical.
            }
        }

        Exception? lastError = null;
        for (var attempt = 0; attempt < 25; attempt += 1)
        {
            try
            {
                File.Copy(source, destination, overwrite: true);
                return;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                lastError = error;
                if (attempt == 24) break;
                Thread.Sleep(100);
            }
        }

        throw new IOException("Notifier helper executable could not be replaced after a bounded unlock wait.", lastError);
    }

    private static void UpdateDirectoryPreservingRoot(string source, string destination)
    {
        var parent = Path.GetDirectoryName(destination) ?? throw new InvalidOperationException("Extension destination has no parent directory.");
        Directory.CreateDirectory(parent);

        var hadExistingRoot = Directory.Exists(destination);
        var rollback = destination + ".rollback-" + Guid.NewGuid().ToString("N");
        try
        {
            if (hadExistingRoot)
            {
                CopyDirectory(source: destination, destination: rollback);
            }
            else
            {
                Directory.CreateDirectory(destination);
            }

            CopyExtensionDirectoryManifestLast(source, destination);
        }
        catch (Exception installError)
        {
            if (hadExistingRoot && Directory.Exists(rollback))
            {
                try
                {
                    CopyExtensionDirectoryManifestLast(rollback, destination);
                }
                catch (Exception rollbackError)
                {
                    throw new AggregateException("Extension update failed and the in-place rollback also failed.", installError, rollbackError);
                }
            }
            else if (!hadExistingRoot && Directory.Exists(destination))
            {
                try { Directory.Delete(destination, recursive: true); } catch { }
            }

            throw;
        }
        finally
        {
            if (Directory.Exists(rollback))
            {
                try { Directory.Delete(rollback, recursive: true); } catch { }
            }
        }
    }

    private static void CopyExtensionDirectoryManifestLast(string source, string destination)
    {
        var manifestSource = Path.Combine(source, "manifest.json");
        if (!File.Exists(manifestSource)) throw new InvalidDataException("Extension manifest is missing from the staged directory.");

        Directory.CreateDirectory(destination);
        foreach (var directory in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(Path.Combine(destination, Path.GetRelativePath(source, directory)));
        }

        foreach (var file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(source, file);
            if (string.Equals(relative, "manifest.json", StringComparison.OrdinalIgnoreCase)) continue;
            var target = Path.Combine(destination, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, overwrite: true);
        }

        // Chrome commonly has this exact directory registered as an unpacked
        // extension. Keep the root continuously present, make every referenced
        // asset available first, and publish the new manifest/version last.
        File.Copy(manifestSource, Path.Combine(destination, "manifest.json"), overwrite: true);
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var directory in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(Path.Combine(destination, Path.GetRelativePath(source, directory)));
        }
        foreach (var file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(destination, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, overwrite: true);
        }
    }
}
