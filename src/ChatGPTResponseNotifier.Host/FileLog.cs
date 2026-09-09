using System.IO;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

internal static class FileLog
{
    private static readonly object Sync = new();
    private static string LogPath => Path.Combine(NativeHostInstaller.InstallRoot, "Logs", "host.log");

    public static void Write(string message, Exception? error = null)
    {
        try
        {
            lock (Sync)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
                var text = $"{DateTimeOffset.Now:O} {message}";
                if (error is not null) text += $" | {error.GetType().Name}: {error.Message}";
                File.AppendAllText(LogPath, text + Environment.NewLine);
                TrimIfNeeded();
            }
        }
        catch
        {
            // Logging must never break the localhost bridge or UI.
        }
    }

    private static void TrimIfNeeded()
    {
        var file = new FileInfo(LogPath);
        if (!file.Exists || file.Length < 512 * 1024) return;
        var lines = File.ReadAllLines(LogPath);
        File.WriteAllLines(LogPath, lines.Skip(Math.Max(0, lines.Length / 2)));
    }
}
