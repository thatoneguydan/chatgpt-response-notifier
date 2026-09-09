namespace ChatGPTResponseNotifier.Core;

public static class LocalBridgeConstants
{
    public const int Port = 38473;
    public const string Path = "/bridge";
    public const string ExtensionOrigin = "chrome-extension://lciedmoiiapbgemklkpoadimhffaaaah";
    public const string WebSocketUrl = "ws://127.0.0.1:38473/bridge";
    public const string StartupRegistrySubKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    public const string StartupRegistryValueName = "ChatGPTResponseNotifier";
}
