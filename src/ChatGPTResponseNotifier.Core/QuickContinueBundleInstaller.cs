using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace ChatGPTResponseNotifier.Core;

public static class QuickContinueBundleInstaller
{
    private static readonly string[] RequiredFiles =
    {
        "manifest.json",
        "background.js",
        "prompt-format.js",
        "config.js",
        "content-script.js",
        "hover-edit-script.js",
        "conversation-state.js"
    };

    public static string InstallRoot
    {
        get
        {
            var overridden = Environment.GetEnvironmentVariable("CHATGPT_QUICK_CONTINUE_INSTALL_ROOT");
            if (!string.IsNullOrWhiteSpace(overridden)) return Path.GetFullPath(overridden);
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ChatGPTQuickContinue", "Extension");
        }
    }

    public static string? ReadInstalledVersion()
    {
        var manifestPath = Path.Combine(InstallRoot, "manifest.json");
        if (!File.Exists(manifestPath)) return null;
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(manifestPath));
            if (!document.RootElement.TryGetProperty("name", out var name)
                || !string.Equals(name.GetString(), "ChatGPT Quick Continue", StringComparison.Ordinal)) return null;
            return document.RootElement.TryGetProperty("version", out var version) && version.ValueKind == JsonValueKind.String
                ? version.GetString()
                : null;
        }
        catch
        {
            return null;
        }
    }

    public static string InstallArchive(UpdateInstallRequest request)
    {
        if (ReadInstalledVersion() is null)
            throw new InvalidOperationException("Quick Continue is not installed at the managed extension path.");

        var archivePath = Path.GetFullPath(request.ArchivePath);
        if (!File.Exists(archivePath)) throw new FileNotFoundException("Quick Continue update archive does not exist.", archivePath);
        if (!HashFile(archivePath).Equals(request.ArchiveSha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Quick Continue update archive SHA-256 does not match the published digest.");

        var tempRoot = Path.Combine(Path.GetTempPath(), "ChatGPTQuickContinue", "update-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempRoot);
        try
        {
            ZipFile.ExtractToDirectory(archivePath, tempRoot);
            ValidateStagedExtension(tempRoot, request.Version);
            InstallStagedExtension(tempRoot);
            return ReadInstalledVersion() ?? throw new InvalidDataException("Quick Continue version could not be read after update.");
        }
        finally
        {
            try { Directory.Delete(tempRoot, recursive: true); } catch { }
        }
    }

    private static void ValidateStagedExtension(string root, string expectedVersion)
    {
        foreach (var file in RequiredFiles)
        {
            if (!File.Exists(Path.Combine(root, file))) throw new InvalidDataException($"Quick Continue update is missing required file: {file}");
        }

        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "manifest.json")));
        var manifest = document.RootElement;
        var name = manifest.TryGetProperty("name", out var nameNode) ? nameNode.GetString() : null;
        var version = manifest.TryGetProperty("version", out var versionNode) ? versionNode.GetString() : null;
        if (!string.Equals(name, "ChatGPT Quick Continue", StringComparison.Ordinal))
            throw new InvalidDataException("Quick Continue update manifest identity is invalid.");
        if (!string.Equals(version, expectedVersion, StringComparison.Ordinal))
            throw new InvalidDataException("Quick Continue update manifest version does not match the published update.");
    }

    private static void InstallStagedExtension(string source)
    {
        var destination = InstallRoot;
        var rollback = destination + ".rollback-" + Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        CopyDirectory(destination, rollback);

        try
        {
            Directory.CreateDirectory(destination);
            foreach (var directory in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
                Directory.CreateDirectory(Path.Combine(destination, Path.GetRelativePath(source, directory)));

            foreach (var file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
            {
                var relative = Path.GetRelativePath(source, file);
                if (string.Equals(relative, "manifest.json", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(relative, "config.json", StringComparison.OrdinalIgnoreCase)
                    && File.Exists(Path.Combine(destination, "config.json"))) continue;
                var target = Path.Combine(destination, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                File.Copy(file, target, overwrite: true);
            }

            File.Copy(Path.Combine(source, "manifest.json"), Path.Combine(destination, "manifest.json"), overwrite: true);
        }
        catch (Exception installError)
        {
            try
            {
                if (Directory.Exists(rollback))
                {
                    Directory.Delete(destination, recursive: true);
                    CopyDirectory(rollback, destination);
                }
            }
            catch (Exception rollbackError)
            {
                throw new AggregateException("Quick Continue update failed and rollback also failed.", installError, rollbackError);
            }
            throw;
        }
        finally
        {
            try { if (Directory.Exists(rollback)) Directory.Delete(rollback, recursive: true); } catch { }
        }
    }

    private static void CopyDirectory(string source, string destination)
    {
        if (!Directory.Exists(source)) return;
        Directory.CreateDirectory(destination);
        foreach (var directory in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(Path.Combine(destination, Path.GetRelativePath(source, directory)));
        foreach (var file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(destination, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, overwrite: true);
        }
    }

    private static string HashFile(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }
}
