using System.Diagnostics;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

public static class Program
{
    private const string MutexName = "Local\\ChatGPTResponseNotifier.Host";

    [STAThread]
    public static int Main(string[] args)
    {
        try
        {
            if (args.Any(arg => string.Equals(arg, "--unregister-startup", StringComparison.OrdinalIgnoreCase)))
            {
                StartupRegistration.Unregister();
                return 0;
            }

            WaitForPreviousHostIfRequested(args);

            using var mutex = new Mutex(initiallyOwned: true, MutexName, out var createdNew);
            if (!createdNew) return 0;

            var app = new NativeHostApplication();
            return app.Run();
        }
        catch (Exception error)
        {
            FileLog.Write("Fatal localhost bridge host error", error);
            return 1;
        }
    }

    private static void WaitForPreviousHostIfRequested(string[] args)
    {
        var index = Array.FindIndex(args, arg => string.Equals(arg, "--wait-for-pid", StringComparison.OrdinalIgnoreCase));
        if (index < 0) return;
        if (index + 1 >= args.Length || !int.TryParse(args[index + 1], out var processId) || processId <= 0)
            throw new ArgumentException("--wait-for-pid requires a positive process ID.");

        try
        {
            using var process = Process.GetProcessById(processId);
            if (!process.WaitForExit(15000))
                throw new TimeoutException($"Previous notifier helper process {processId} did not exit within 15 seconds.");
        }
        catch (ArgumentException)
        {
            // The old helper already exited before the replacement process reached this point.
        }
    }
}
