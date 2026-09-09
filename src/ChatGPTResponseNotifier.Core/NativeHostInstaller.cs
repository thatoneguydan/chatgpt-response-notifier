namespace ChatGPTResponseNotifier.Core;

public static class NativeHostInstaller
{
    public const string InstallRootOverrideEnvironmentVariable = "CHATGPT_RESPONSE_NOTIFIER_INSTALL_ROOT";

    public static string InstallRoot
    {
        get
        {
            var overrideRoot = Environment.GetEnvironmentVariable(InstallRootOverrideEnvironmentVariable);
            if (!string.IsNullOrWhiteSpace(overrideRoot)) return Path.GetFullPath(overrideRoot);
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ChatGPTResponseNotifier");
        }
    }

    public static string HostVersionsRoot => Path.Combine(InstallRoot, "Host");
    public static string ExtensionRoot => Path.Combine(InstallRoot, "Extension");
    public static string DataRoot => Path.Combine(InstallRoot, "Data");
    public static string InstallStatePath => Path.Combine(DataRoot, "install-state.json");

    public static string HostVersionRoot(string version) => Path.Combine(HostVersionsRoot, SanitizeVersion(version));
    public static string HostExecutablePath(string version) => Path.Combine(HostVersionRoot(version), "ChatGPTResponseNotifier.Host.exe");

    private static string SanitizeVersion(string value)
    {
        var version = (value ?? string.Empty).Trim();
        if (version.Length is < 1 or > 64) throw new InvalidDataException("Install version is invalid.");
        if (version.Any(ch => !(char.IsLetterOrDigit(ch) || ch is '.' or '-' or '_')))
            throw new InvalidDataException("Install version contains unsupported characters.");
        return version;
    }
}
