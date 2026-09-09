using System.Diagnostics;
using System.IO.Compression;
using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Setup;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var silent = args.Any(arg => string.Equals(arg, "--silent", StringComparison.OrdinalIgnoreCase));
        var uninstall = args.Any(arg => string.Equals(arg, "--uninstall", StringComparison.OrdinalIgnoreCase));
        var skipStartup = args.Any(arg => string.Equals(arg, "--skip-startup", StringComparison.OrdinalIgnoreCase));

        if (silent)
        {
            try
            {
                if (uninstall) SetupEngine.Uninstall();
                else SetupEngine.Install(skipStartup);
                return 0;
            }
            catch (Exception error)
            {
                SetupLog.Write("Silent setup failed", error);
                return 1;
            }
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new SetupForm(uninstall, skipStartup));
        return 0;
    }
}

internal sealed class SetupForm : Form
{
    private readonly bool _uninstall;
    private readonly bool _skipStartup;
    private readonly Label _status;
    private readonly ProgressBar _progress;
    private readonly Button _openChrome;
    private readonly Button _close;

    public SetupForm(bool uninstall, bool skipStartup)
    {
        _uninstall = uninstall;
        _skipStartup = skipStartup;
        Text = "ChatGPT Response Notifier Setup";
        StartPosition = FormStartPosition.CenterScreen;
        Width = 560;
        Height = 275;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;

        var title = new Label
        {
            Left = 24,
            Top = 22,
            Width = 500,
            Height = 30,
            Font = new Font(Font.FontFamily, 14, FontStyle.Bold),
            Text = uninstall ? "Removing ChatGPT Response Notifier" : "Installing ChatGPT Response Notifier"
        };
        Controls.Add(title);

        _status = new Label
        {
            Left = 24,
            Top = 66,
            Width = 500,
            Height = 72,
            Text = uninstall ? "Removing installed files..." : "Installing the Windows helper and Chrome extension files..."
        };
        Controls.Add(_status);

        _progress = new ProgressBar
        {
            Left = 24,
            Top = 145,
            Width = 500,
            Height = 18,
            Style = ProgressBarStyle.Marquee,
            MarqueeAnimationSpeed = 25
        };
        Controls.Add(_progress);

        _openChrome = new Button
        {
            Left = 24,
            Top = 185,
            Width = 190,
            Height = 32,
            Text = "Open Chrome extensions",
            Enabled = false
        };
        _openChrome.Click += (_, _) =>
        {
            try { Process.Start(new ProcessStartInfo("chrome://extensions/") { UseShellExecute = true }); } catch { }
        };
        Controls.Add(_openChrome);

        _close = new Button
        {
            Left = 424,
            Top = 185,
            Width = 100,
            Height = 32,
            Text = "Close",
            Enabled = false
        };
        _close.Click += (_, _) => Close();
        Controls.Add(_close);

        Shown += async (_, _) => await RunAsync();
    }

    private async Task RunAsync()
    {
        try
        {
            if (_uninstall)
            {
                await Task.Run(SetupEngine.Uninstall);
                _status.Text = "ChatGPT Response Notifier was removed from this Windows user account.";
            }
            else
            {
                var result = await Task.Run(() => SetupEngine.Install(_skipStartup));
                _status.Text = $"Installed {result.Version}. Windows helper is running.\n\nChrome extension files: {result.ExtensionPath}\nReload the existing unpacked extension once if Chrome still shows the previous version.";
                _openChrome.Enabled = true;
            }
            _progress.Style = ProgressBarStyle.Continuous;
            _progress.Value = 100;
        }
        catch (Exception error)
        {
            SetupLog.Write("Interactive setup failed", error);
            _status.Text = $"Setup failed: {error.Message}\n\nA diagnostic log was written to LocalAppData.";
            _progress.Style = ProgressBarStyle.Continuous;
            _progress.Value = 0;
        }
        finally
        {
            _close.Enabled = true;
        }
    }
}

internal sealed record SetupResult(string Version, string HostPath, string ExtensionPath);

internal static class SetupEngine
{
    private const string PayloadResourceName = "ChatGPTResponseNotifier.Payload.zip";

    public static SetupResult Install(bool skipStartup)
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), "ChatGPTResponseNotifier", "setup-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempRoot);
        try
        {
            ExtractEmbeddedPayload(tempRoot);
            var installed = BundleInstaller.InstallExtractedBundle(tempRoot);

            StopExistingHosts();
            if (!skipStartup) StartupRegistration.Register(installed.HostExecutablePath);
            StartHelper(installed.HostExecutablePath);
            WaitForHelperAsync(TimeSpan.FromSeconds(12)).GetAwaiter().GetResult();

            return new SetupResult(installed.Version, installed.HostExecutablePath, installed.ExtensionPath);
        }
        finally
        {
            try { Directory.Delete(tempRoot, recursive: true); } catch { }
        }
    }

    public static void Uninstall()
    {
        StopExistingHosts();
        try { StartupRegistration.Unregister(); } catch { }
        try
        {
            if (Directory.Exists(NativeHostInstaller.InstallRoot))
                Directory.Delete(NativeHostInstaller.InstallRoot, recursive: true);
        }
        catch (Exception error)
        {
            SetupLog.Write("Could not remove the complete install root", error);
            throw;
        }
    }

    private static void ExtractEmbeddedPayload(string destination)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadResourceName)
            ?? throw new InvalidDataException("Setup payload is missing from this executable.");
        using var archive = new ZipArchive(stream, ZipArchiveMode.Read, leaveOpen: false);
        foreach (var entry in archive.Entries)
        {
            var target = Path.GetFullPath(Path.Combine(destination, entry.FullName));
            var root = Path.GetFullPath(destination) + Path.DirectorySeparatorChar;
            if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Setup payload contains an unsafe path.");
            if (string.IsNullOrEmpty(entry.Name))
            {
                Directory.CreateDirectory(target);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            entry.ExtractToFile(target, overwrite: true);
        }
    }

    private static void StopExistingHosts()
    {
        foreach (var process in Process.GetProcessesByName("ChatGPTResponseNotifier.Host"))
        {
            using (process)
            {
                try
                {
                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(3000);
                }
                catch (Exception error)
                {
                    SetupLog.Write($"Could not stop old helper process {process.Id}", error);
                }
            }
        }
    }

    private static void StartHelper(string executable)
    {
        var process = Process.Start(new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(executable)!
        });
        if (process is null) throw new InvalidOperationException("Windows helper could not be started after installation.");
    }

    private static async Task WaitForHelperAsync(TimeSpan timeout)
    {
        using var timeoutSource = new CancellationTokenSource(timeout);
        Exception? lastError = null;
        while (!timeoutSource.IsCancellationRequested)
        {
            try
            {
                using var socket = new ClientWebSocket();
                socket.Options.SetRequestHeader("Origin", LocalBridgeConstants.ExtensionOrigin);
                await socket.ConnectAsync(new Uri(LocalBridgeConstants.WebSocketUrl), timeoutSource.Token);

                var requestId = Guid.NewGuid().ToString("N");
                var payload = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { type = "ping", requestId }, JsonOptions.Default));
                await socket.SendAsync(payload, WebSocketMessageType.Text, true, timeoutSource.Token);

                var buffer = new byte[8192];
                for (var attempt = 0; attempt < 3; attempt += 1)
                {
                    var result = await socket.ReceiveAsync(buffer, timeoutSource.Token);
                    if (result.MessageType != WebSocketMessageType.Text) continue;
                    using var doc = JsonDocument.Parse(new ReadOnlyMemory<byte>(buffer, 0, result.Count));
                    var root = doc.RootElement;
                    if (root.TryGetProperty("type", out var type) && type.GetString() == "pong" &&
                        root.TryGetProperty("requestId", out var id) && id.GetString() == requestId)
                        return;
                }
                lastError = new InvalidDataException("Helper WebSocket connected but did not return the expected pong.");
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                lastError = error;
            }
            await Task.Delay(250, timeoutSource.Token);
        }
        throw new TimeoutException("Installed Windows helper did not become reachable on the localhost bridge.", lastError);
    }
}

internal static class SetupLog
{
    public static void Write(string message, Exception error)
    {
        try
        {
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ChatGPTResponseNotifier", "Data");
            Directory.CreateDirectory(root);
            File.AppendAllText(Path.Combine(root, "setup.log"), $"{DateTimeOffset.Now:o} {message}\r\n{error}\r\n\r\n");
        }
        catch { }
    }
}
