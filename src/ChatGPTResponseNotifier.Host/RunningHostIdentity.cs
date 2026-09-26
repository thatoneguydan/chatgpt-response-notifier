using System.IO;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

internal static class RunningHostIdentity
{
    public static string? ReadVersion()
    {
        var processPath = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(processPath)) return null;

        try
        {
            var directory = Path.GetDirectoryName(Path.GetFullPath(processPath));
            var version = Path.GetFileName(directory)?.Trim();
            if (string.IsNullOrWhiteSpace(version)) return null;

            // Host executables are installed under Host/<version>/. Reuse the
            // public update parser's strict version comparison as validation so
            // an arbitrary parent directory can never masquerade as runtime ID.
            _ = PublicUpdateFeed.CompareVersions(version, "0.0.0");
            return version;
        }
        catch
        {
            return null;
        }
    }
}
