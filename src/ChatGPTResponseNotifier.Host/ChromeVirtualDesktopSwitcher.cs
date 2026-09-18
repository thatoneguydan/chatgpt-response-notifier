using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace ChatGPTResponseNotifier.Host;

internal readonly record struct VirtualDesktopSwitchResult(
    bool Success,
    string State,
    int OsBuild,
    int CandidateCount,
    string DesktopIdSuffix);

internal static class ChromeVirtualDesktopSwitcher
{
    private const int MinimumSupportedBuild = 26100;
    private const int MaximumExclusiveSupportedBuild = 27000;
    private const int BoundsDistanceLimit = 96;
    private const int BoundsUniquenessMargin = 24;
    private const string ChromeWindowClassPrefix = "Chrome_WidgetWin_";

    private static readonly Guid ClsidImmersiveShell = new("C2F03A33-21F5-47FA-B4BB-156362A2F239");
    private static readonly Guid ClsidVirtualDesktopManagerInternal = new("C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B");
    private static readonly Guid ClsidVirtualDesktopManager = new("AA509086-5CA9-4C25-8F95-589D3C07B48A");

    public static VirtualDesktopSwitchResult TrySwitchToMatchedChromeWindowDesktop(
        string? expectedTitle,
        int? expectedLeft,
        int? expectedTop,
        int? expectedWidth,
        int? expectedHeight)
    {
        var build = Environment.OSVersion.Version.Build;
        if (!OperatingSystem.IsWindows()
            || build < MinimumSupportedBuild
            || build >= MaximumExclusiveSupportedBuild)
        {
            return new VirtualDesktopSwitchResult(false, "unsupported-build", build, 0, string.Empty);
        }

        if (string.IsNullOrWhiteSpace(expectedTitle)
            || !expectedLeft.HasValue
            || !expectedTop.HasValue
            || !expectedWidth.HasValue
            || !expectedHeight.HasValue
            || expectedWidth <= 0
            || expectedHeight <= 0)
        {
            return new VirtualDesktopSwitchResult(false, "missing-window-identity", build, 0, string.Empty);
        }

        var candidates = EnumerateMatchingChromeWindows(
            expectedTitle,
            expectedLeft.Value,
            expectedTop.Value,
            expectedWidth.Value,
            expectedHeight.Value);

        if (candidates.Count == 0)
        {
            return new VirtualDesktopSwitchResult(false, "window-not-found", build, 0, string.Empty);
        }

        var ranked = candidates
            .Select(candidate => new
            {
                Candidate = candidate,
                Distance = BoundsDistance(
                    candidate,
                    expectedLeft.Value,
                    expectedTop.Value,
                    expectedWidth.Value,
                    expectedHeight.Value)
            })
            .OrderBy(item => item.Distance)
            .ToArray();

        if (ranked[0].Distance > BoundsDistanceLimit)
        {
            return new VirtualDesktopSwitchResult(false, "window-bounds-mismatch", build, ranked.Length, string.Empty);
        }

        if (ranked.Length > 1 && ranked[1].Distance - ranked[0].Distance < BoundsUniquenessMargin)
        {
            return new VirtualDesktopSwitchResult(false, "window-ambiguous", build, ranked.Length, string.Empty);
        }

        var target = ranked[0].Candidate;
        return SwitchToWindowDesktop(target.Handle, build, ranked.Length);
    }

    public static (bool Supported, int OsBuild, string State) Capability()
    {
        var build = Environment.OSVersion.Version.Build;
        var supported = OperatingSystem.IsWindows()
            && build >= MinimumSupportedBuild
            && build < MaximumExclusiveSupportedBuild;
        return (supported, build, supported ? "supported" : "unsupported-build");
    }

    private static VirtualDesktopSwitchResult SwitchToWindowDesktop(nint hWnd, int build, int candidateCount)
    {
        object? shellObject = null;
        object? internalObject = null;
        object? publicObject = null;
        IObjectArray? desktops = null;
        IVirtualDesktop? targetDesktop = null;

        try
        {
            var publicType = Type.GetTypeFromCLSID(ClsidVirtualDesktopManager, throwOnError: true)
                ?? throw new InvalidOperationException("Virtual desktop manager COM type is unavailable.");
            publicObject = Activator.CreateInstance(publicType)
                ?? throw new InvalidOperationException("Virtual desktop manager COM instance could not be created.");
            var publicManager = (IVirtualDesktopManager)publicObject;

            var desktopId = publicManager.GetWindowDesktopId(hWnd);
            if (desktopId == Guid.Empty)
            {
                return new VirtualDesktopSwitchResult(false, "desktop-id-unavailable", build, candidateCount, string.Empty);
            }

            var desktopSuffix = Suffix(desktopId);
            if (publicManager.IsWindowOnCurrentVirtualDesktop(hWnd))
            {
                return new VirtualDesktopSwitchResult(true, "already-current-desktop", build, candidateCount, desktopSuffix);
            }

            var shellType = Type.GetTypeFromCLSID(ClsidImmersiveShell, throwOnError: true)
                ?? throw new InvalidOperationException("Immersive shell COM type is unavailable.");
            shellObject = Activator.CreateInstance(shellType)
                ?? throw new InvalidOperationException("Immersive shell COM instance could not be created.");
            var serviceProvider = (IServiceProvider)shellObject;

            var service = ClsidVirtualDesktopManagerInternal;
            var iid = typeof(IVirtualDesktopManagerInternalPrefix).GUID;
            internalObject = serviceProvider.QueryService(ref service, ref iid);
            var internalManager = (IVirtualDesktopManagerInternalPrefix)internalObject;

            internalManager.GetDesktops(out desktops);
            desktops.GetCount(out var count);
            var desktopIid = typeof(IVirtualDesktop).GUID;
            for (uint index = 0; index < count; index += 1)
            {
                desktops.GetAt(index, ref desktopIid, out var candidateObject);
                var candidateDesktop = (IVirtualDesktop)candidateObject;
                if (candidateDesktop.GetId() == desktopId)
                {
                    targetDesktop = candidateDesktop;
                    break;
                }

                ReleaseCom(candidateObject);
            }

            if (targetDesktop is null)
            {
                return new VirtualDesktopSwitchResult(false, "desktop-not-found", build, candidateCount, desktopSuffix);
            }

            internalManager.SwitchDesktop(targetDesktop);

            for (var attempt = 0; attempt < 10; attempt += 1)
            {
                if (publicManager.IsWindowOnCurrentVirtualDesktop(hWnd))
                {
                    return new VirtualDesktopSwitchResult(true, "switched", build, candidateCount, desktopSuffix);
                }

                Thread.Sleep(50);
            }

            return new VirtualDesktopSwitchResult(false, "switch-unverified", build, candidateCount, desktopSuffix);
        }
        catch (COMException error)
        {
            FileLog.Write("Virtual desktop COM switch failed", error);
            return new VirtualDesktopSwitchResult(false, "com-failure", build, candidateCount, string.Empty);
        }
        catch (Exception error)
        {
            FileLog.Write("Virtual desktop switch failed", error);
            return new VirtualDesktopSwitchResult(false, "switch-failure", build, candidateCount, string.Empty);
        }
        finally
        {
            if (targetDesktop is not null) ReleaseCom(targetDesktop);
            if (desktops is not null) ReleaseCom(desktops);
            if (internalObject is not null) ReleaseCom(internalObject);
            if (publicObject is not null) ReleaseCom(publicObject);
            if (shellObject is not null) ReleaseCom(shellObject);
        }
    }

    private static List<WindowCandidate> EnumerateMatchingChromeWindows(
        string expectedTitle,
        int expectedLeft,
        int expectedTop,
        int expectedWidth,
        int expectedHeight)
    {
        var expected = NormalizeTitle(expectedTitle);
        if (string.IsNullOrWhiteSpace(expected)) return new List<WindowCandidate>();

        var sessionId = Process.GetCurrentProcess().SessionId;
        var windows = new List<WindowCandidate>();
        EnumWindows((hWnd, _) =>
        {
            if (!IsWindowVisible(hWnd)) return true;

            var className = GetClassNameText(hWnd);
            if (!className.StartsWith(ChromeWindowClassPrefix, StringComparison.Ordinal)) return true;

            _ = GetWindowThreadProcessId(hWnd, out var processId);
            if (processId == 0 || !IsChromeProcessInSession(processId, sessionId)) return true;

            var title = NormalizeTitle(GetWindowTitle(hWnd));
            if (!string.Equals(title, expected, StringComparison.OrdinalIgnoreCase)) return true;
            if (!GetWindowRect(hWnd, out var rect)) return true;

            windows.Add(new WindowCandidate(
                hWnd,
                rect.Left,
                rect.Top,
                rect.Right - rect.Left,
                rect.Bottom - rect.Top));
            return true;
        }, nint.Zero);

        return windows;
    }

    private static bool IsChromeProcessInSession(uint processId, int sessionId)
    {
        try
        {
            using var process = Process.GetProcessById(checked((int)processId));
            return process.SessionId == sessionId
                && string.Equals(process.ProcessName, "chrome", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static string NormalizeTitle(string? title)
    {
        var value = string.Join(' ', (title ?? string.Empty).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        foreach (var suffix in new[] { " - Google Chrome", " — Google Chrome", " – Google Chrome" })
        {
            if (value.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
            {
                return value[..^suffix.Length].Trim();
            }
        }

        return value.Trim();
    }

    private static long BoundsDistance(WindowCandidate candidate, int left, int top, int width, int height) =>
        Math.Abs((long)candidate.Left - left)
        + Math.Abs((long)candidate.Top - top)
        + Math.Abs((long)candidate.Width - width)
        + Math.Abs((long)candidate.Height - height);

    private static string Suffix(Guid value)
    {
        var text = value.ToString("N");
        return text.Length <= 8 ? text : text[^8..];
    }

    private static string GetWindowTitle(nint hWnd)
    {
        var length = GetWindowTextLength(hWnd);
        if (length <= 0) return string.Empty;
        var buffer = new StringBuilder(Math.Min(length + 1, 4096));
        _ = GetWindowText(hWnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    private static string GetClassNameText(nint hWnd)
    {
        var buffer = new StringBuilder(256);
        _ = GetClassName(hWnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    private static void ReleaseCom(object value)
    {
        try
        {
            if (Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
        }
        catch
        {
        }
    }

    private sealed record WindowCandidate(
        nint Handle,
        int Left,
        int Top,
        int Width,
        int Height);

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("6D5140C1-7436-11CE-8034-00AA006009FA")]
    private interface IServiceProvider
    {
        [return: MarshalAs(UnmanagedType.Interface)]
        object QueryService(ref Guid service, ref Guid riid);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("53F5CA0B-158F-4124-900C-057158060B27")]
    private interface IVirtualDesktopManagerInternalPrefix
    {
        int GetCount();
        void MoveViewToDesktop(nint view, IVirtualDesktop desktop);
        bool CanViewMoveDesktops(nint view);
        IVirtualDesktop GetCurrentDesktop();
        void GetDesktops(out IObjectArray desktops);

        [PreserveSig]
        int GetAdjacentDesktop(IVirtualDesktop from, int direction, out IVirtualDesktop desktop);

        void SwitchDesktop(IVirtualDesktop desktop);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("3F07F4BE-B107-441A-AF0F-39D82529072C")]
    private interface IVirtualDesktop
    {
        bool IsViewVisible(nint view);
        Guid GetId();
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B")]
    private interface IVirtualDesktopManager
    {
        bool IsWindowOnCurrentVirtualDesktop(nint topLevelWindow);
        Guid GetWindowDesktopId(nint topLevelWindow);
        void MoveWindowToDesktop(nint topLevelWindow, ref Guid desktopId);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("92CA9DCD-5622-4BBA-A805-5E9F541BD8C9")]
    private interface IObjectArray
    {
        void GetCount(out uint count);
        void GetAt(uint index, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object value);
    }

    private delegate bool EnumWindowsProc(nint hWnd, nint lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsProc callback, nint lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(nint hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(nint hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(nint hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(nint hWnd, StringBuilder className, int maxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(nint hWnd, out uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(nint hWnd, out Rect rect);
}
