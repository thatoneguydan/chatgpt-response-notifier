namespace ChatGPTResponseNotifier.Core;

public static class NativeHostConstants
{
    public const string HostName = "com.dantylersmith.chatgpt_response_notifier";
    public const string ExtensionId = "lciedmoiiapbgemklkpoadimhffaaaah";
    public const string ExtensionOrigin = "chrome-extension://" + ExtensionId + "/";
    public const int MaxMessageBytes = 1024 * 1024;
    public const int StateSchemaVersion = 1;
}
