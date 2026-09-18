using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace ChatGPTResponseNotifier.Host;

// Narrow Windows 11 24H2+ virtual-desktop adapter derived from the MIT-licensed
// MScholtes/VirtualDesktop v1.21 interface layout (Copyright 2017 Markus Scholtes).
// Only the user-initiated "switch to the desktop containing this exact Chrome
// window" operation is exposed here. No window is moved between desktops.
internal readonly record struct DesktopPresentationTarget(
    string WindowTitle,
    int? Left,
    int? Top,
    int? Width,
    int? Height);

internal readonly record struct DesktopPresentationResult(
    bool Success,
    string Reason,
    int WindowsBuild,
    int? WindowsUbr);

internal static class WindowsVirtualDesktopSwitcher
{
    private const int Windows11_24H2Build = 26100;
    private const int Minimum26100Ubr = 2605;
    private const int SwRestore = 9;
    private const int GeometryTolerance = 48;

    private static readonly Guid ClsidImmersiveShell = new("C2F03A33-21F5-47FA-B4BB-156362A2F239");
    private static readonly Guid ClsidVirtualDesktopManagerInternal = new("C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B");
    private static readonly Guid ClsidVirtualDesktopManager = new("AA509086-5CA9-4C25-8F95-589D3C07B48A");

    public static DesktopPresentationResult PresentExistingChromeWindow(DesktopPresentationTarget target)
    {
        var build = Environment.OSVersion.Version.Build;
        var ubr = ReadWindowsUbr();
        if (!IsSupportedBuild(build, ubr))
        {
            return new(false, "unsupported-windows-build", build, ubr);
        }

        var expectedTitle = NormalizeTitle(target.WindowTitle);
        if (expectedTitle.Length == 0)
        {
            return new(false, "missing-window-title", build, ubr);
        }

        var resolution = ResolveChromeWindow(expectedTitle, target);
        if (resolution.Hwnd == IntPtr.Zero)
        {
            return new(false, resolution.Reason, build, ubr);
        }

        object? shellObject = null;
        object? managerObject = null;
        object? desktopObject = null;
        object? publicManagerObject = null;
        try
        {
            var shellType = Type.GetTypeFromCLSID(ClsidImmersiveShell, throwOnError: true)!;
            shellObject = Activator.CreateInstance(shellType)
                ?? throw new InvalidOperationException("immersive-shell-unavailable");
            var provider = (IServiceProvider10)shellObject;

            var service = ClsidVirtualDesktopManagerInternal;
            var iid = typeof(IVirtualDesktopManagerInternal).GUID;
            managerObject = provider.QueryService(ref service, ref iid);
            var manager = (IVirtualDesktopManagerInternal)managerObject;

            var publicManagerType = Type.GetTypeFromCLSID(ClsidVirtualDesktopManager, throwOnError: true)!;
            publicManagerObject = Activator.CreateInstance(publicManagerType)
                ?? throw new InvalidOperationException("virtual-desktop-manager-unavailable");
            var publicManager = (IVirtualDesktopManager)publicManagerObject;

            var desktopId = publicManager.GetWindowDesktopId(resolution.Hwnd);
            desktopObject = manager.FindDesktop(ref desktopId);

            manager.WaitForAnimationToComplete();
            manager.SwitchDesktopWithAnimation((IVirtualDesktop)desktopObject);
            manager.WaitForAnimationToComplete();

            if (IsIconic(resolution.Hwnd)) ShowWindow(resolution.Hwnd, SwRestore);
            _ = SetForegroundWindow(resolution.Hwnd);

            for (var attempt = 0; attempt < 12; attempt++)
            {
                if (publicManager.IsWindowOnCurrentVirtualDesktop(resolution.Hwnd))
                {
                    _ = SetForegroundWindow(resolution.Hwnd);
                    return new(true, "desktop-switched", build, ubr);
                }

                Thread.Sleep(50);
            }

            return new(false, "desktop-switch-not-confirmed", build, ubr);
        }
        catch (COMException)
        {
            return new(false, "virtual-desktop-com-failed", build, ubr);
        }
        catch (InvalidCastException)
        {
            return new(false, "virtual-desktop-interface-mismatch", build, ubr);
        }
        catch (Exception)
        {
            return new(false, "virtual-desktop-switch-failed", build, ubr);
        }
        finally
        {
            ReleaseCom(desktopObject);
            ReleaseCom(publicManagerObject);
            ReleaseCom(managerObject);
            ReleaseCom(shellObject);
        }
    }

    internal static bool IsSupportedBuild(int build, int? ubr) =>
        build > Windows11_24H2Build ||
        (build == Windows11_24H2Build && ubr is >= Minimum26100Ubr);

    private static int? ReadWindowsUbr()
    {
        try
        {
            var value = Registry.GetValue(
                @"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion",
                "UBR",
                null);
            return value is int number ? number : null;
        }
        catch
        {
            return null;
        }
    }

    private static WindowResolution ResolveChromeWindow(string expectedTitle, DesktopPresentationTarget target)
    {
        var candidates = new List<WindowCandidate>();
        _ = EnumWindows((hwnd, _) =>
        {
            if (!IsWindowVisible(hwnd)) return true;
            if (!string.Equals(ReadClassName(hwnd), "Chrome_WidgetWin_1", StringComparison.Ordinal)) return true;

            GetWindowThreadProcessId(hwnd, out var processId);
            if (processId == 0) return true;
            try
            {
                using var process = Process.GetProcessById(unchecked((int)processId));
                if (!string.Equals(process.ProcessName, "chrome", StringComparison.OrdinalIgnoreCase)) return true;
            }
            catch
            {
                return true;
            }

            var nativeTitle = NormalizeTitle(ReadWindowTitle(hwnd));
            if (!TitleMatches(expectedTitle, nativeTitle)) return true;
            GetWindowRect(hwnd, out var rect);
            candidates.Add(new WindowCandidate(hwnd, rect));
            return true;
        }, IntPtr.Zero);

        if (candidates.Count == 0) return new(IntPtr.Zero, "chrome-window-not-found");
        if (candidates.Count == 1) return new(candidates[0].Hwnd, "exact-title");

        if (HasCompleteGeometry(target))
        {
            var geometryMatches = candidates
                .Where(candidate => GeometryMatches(candidate.Rect, target))
                .ToArray();
            if (geometryMatches.Length == 1)
            {
                return new(geometryMatches[0].Hwnd, "title-and-geometry");
            }
        }

        return new(IntPtr.Zero, "chrome-window-ambiguous");
    }

    private static bool HasCompleteGeometry(DesktopPresentationTarget target) =>
        target.Left.HasValue && target.Top.HasValue &&
        target.Width is > 0 && target.Height is > 0;

    private static bool GeometryMatches(Rect rect, DesktopPresentationTarget target)
    {
        if (!HasCompleteGeometry(target)) return false;
        var width = rect.Right - rect.Left;
        var height = rect.Bottom - rect.Top;
        return Math.Abs(rect.Left - target.Left!.Value) <= GeometryTolerance &&
               Math.Abs(rect.Top - target.Top!.Value) <= GeometryTolerance &&
               Math.Abs(width - target.Width!.Value) <= GeometryTolerance &&
               Math.Abs(height - target.Height!.Value) <= GeometryTolerance;
    }

    private static bool TitleMatches(string expected, string actual)
    {
        if (string.Equals(expected, actual, StringComparison.Ordinal)) return true;
        const string chromeSuffix = " - Google Chrome";
        return actual.EndsWith(chromeSuffix, StringComparison.Ordinal) &&
               string.Equals(actual[..^chromeSuffix.Length], expected, StringComparison.Ordinal);
    }

    private static string NormalizeTitle(string? value) =>
        (value ?? string.Empty).Replace("\r", " ").Replace("\n", " ").Trim();

    private static string ReadWindowTitle(IntPtr hwnd)
    {
        var length = GetWindowTextLength(hwnd);
        if (length <= 0) return string.Empty;
        var builder = new StringBuilder(Math.Min(length + 1, 1024));
        _ = GetWindowText(hwnd, builder, builder.Capacity);
        return builder.ToString();
    }

    private static string ReadClassName(IntPtr hwnd)
    {
        var builder = new StringBuilder(256);
        _ = GetClassName(hwnd, builder, builder.Capacity);
        return builder.ToString();
    }

    private static void ReleaseCom(object? value)
    {
        if (value is null || !Marshal.IsComObject(value)) return;
        try { Marshal.FinalReleaseComObject(value); } catch { }
    }

    private readonly record struct WindowResolution(IntPtr Hwnd, string Reason);
    private readonly record struct WindowCandidate(IntPtr Hwnd, Rect Rect);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder className, int maxCount);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr hwnd, int command);

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("6D5140C1-7436-11CE-8034-00AA006009FA")]
    private interface IServiceProvider10
    {
        [return: MarshalAs(UnmanagedType.IUnknown)]
        object QueryService(ref Guid service, ref Guid riid);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B")]
    private interface IVirtualDesktopManager
    {
        [return: MarshalAs(UnmanagedType.Bool)]
        bool IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow);
        Guid GetWindowDesktopId(IntPtr topLevelWindow);
        void MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("3F07F4BE-B107-441A-AF0F-39D82529072C")]
    private interface IVirtualDesktop
    {
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("92CA9DCD-5622-4BBA-A805-5E9F541BD8C9")]
    private interface IObjectArray
    {
        void GetCount(out int count);
        void GetAt(int index, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object value);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("53F5CA0B-158F-4124-900C-057158060B27")]
    private interface IVirtualDesktopManagerInternal
    {
        int GetCount();
        void MoveViewToDesktop(IntPtr view, IVirtualDesktop desktop);
        bool CanViewMoveDesktops(IntPtr view);
        IVirtualDesktop GetCurrentDesktop();
        void GetDesktops(out IObjectArray desktops);
        [PreserveSig]
        int GetAdjacentDesktop(IVirtualDesktop from, int direction, out IVirtualDesktop desktop);
        void SwitchDesktop(IVirtualDesktop desktop);
        void SwitchDesktopAndMoveForegroundView(IVirtualDesktop desktop);
        IVirtualDesktop CreateDesktop();
        void MoveDesktop(IVirtualDesktop desktop, int index);
        void RemoveDesktop(IVirtualDesktop desktop, IVirtualDesktop fallback);
        IVirtualDesktop FindDesktop(ref Guid desktopId);
        void GetDesktopSwitchIncludeExcludeViews(IVirtualDesktop desktop, out IObjectArray include, out IObjectArray exclude);
        void SetDesktopName(IVirtualDesktop desktop, [MarshalAs(UnmanagedType.HString)] string name);
        void SetDesktopWallpaper(IVirtualDesktop desktop, [MarshalAs(UnmanagedType.HString)] string path);
        void UpdateWallpaperPathForAllDesktops([MarshalAs(UnmanagedType.HString)] string path);
        void CopyDesktopState(IntPtr view0, IntPtr view1);
        void CreateRemoteDesktop([MarshalAs(UnmanagedType.HString)] string path, out IVirtualDesktop desktop);
        void SwitchRemoteDesktop(IVirtualDesktop desktop, IntPtr switchType);
        void SwitchDesktopWithAnimation(IVirtualDesktop desktop);
        void GetLastActiveDesktop(out IVirtualDesktop desktop);
        void WaitForAnimationToComplete();
    }
}
