using Microsoft.Win32;

namespace ChatGPTResponseNotifier.Core;

public static class StartupRegistration
{
    public static void Register(string hostExecutablePath)
    {
        var fullPath = Path.GetFullPath(hostExecutablePath);
        using var key = Registry.CurrentUser.CreateSubKey(LocalBridgeConstants.StartupRegistrySubKey, writable: true)
            ?? throw new InvalidOperationException("Could not open the per-user Windows startup registry key.");
        key.SetValue(LocalBridgeConstants.StartupRegistryValueName, $"\"{fullPath}\"", RegistryValueKind.String);
    }

    public static string? ReadCommand()
    {
        using var key = Registry.CurrentUser.OpenSubKey(LocalBridgeConstants.StartupRegistrySubKey, writable: false);
        return key?.GetValue(LocalBridgeConstants.StartupRegistryValueName) as string;
    }

    public static void Unregister()
    {
        using var key = Registry.CurrentUser.OpenSubKey(LocalBridgeConstants.StartupRegistrySubKey, writable: true);
        key?.DeleteValue(LocalBridgeConstants.StartupRegistryValueName, throwOnMissingValue: false);
    }
}
