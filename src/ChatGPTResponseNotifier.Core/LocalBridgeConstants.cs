namespace ChatGPTResponseNotifier.Core;

public static class LocalBridgeConstants
{
    public const int DefaultPort = 38473;
    public const string Path = "/bridge";
    public const string ExtensionOrigin = "chrome-extension://lciedmoiiapbgemklkpoadimhffaaaah";
    public const string StartupRegistrySubKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    public const string StartupRegistryValueName = "ChatGPTResponseNotifier";

    public static int Port
    {
        get
        {
            // Acceptance tests install the helper under an isolated root while the
            // operator's real helper may already own the production port. Never honor
            // the test-port override for a normal installed helper; production launch
            // paths must therefore remain pinned to DefaultPort.
            if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("CHATGPT_RESPONSE_NOTIFIER_INSTALL_ROOT")))
                return DefaultPort;

            var raw = Environment.GetEnvironmentVariable("CHATGPT_RESPONSE_NOTIFIER_TEST_BRIDGE_PORT");
            return int.TryParse(raw, out var port) && port is >= 1024 and <= 65535
                ? port
                : DefaultPort;
        }
    }

    public static string WebSocketUrl => $"ws://127.0.0.1:{Port}{Path}";
}
