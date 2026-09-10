using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace ChatGPTResponseNotifier.Host;

internal static class ChromeWindowForeground
{
    private const int SwRestore = 9;
    private const int SwShow = 5;

    private delegate bool EnumWindowsProc(nint hWnd, nint lParam);

    public static bool TryForeground(
        string? expectedTitle,
        int? expectedLeft,
        int? expectedTop,
        int? expectedWidth,
        int? expectedHeight)
    {
        var candidates = EnumerateChromeWindows();
        if (candidates.Count == 0) return false;

        var hasBounds = expectedLeft.HasValue
            && expectedTop.HasValue
            && expectedWidth.HasValue
            && expectedHeight.HasValue;
        var expected = NormalizeTitle(expectedTitle);

        var titleMatches = string.IsNullOrWhiteSpace(expected)
            ? Array.Empty<WindowCandidate>()
            : candidates.Where(candidate => TitleMatches(candidate.Title, expected)).ToArray();

        WindowCandidate? target = null;
        if (titleMatches.Length > 0)
        {
            target = hasBounds
                ? titleMatches.OrderBy(candidate => BoundsDistance(candidate, expectedLeft!.Value, expectedTop!.Value, expectedWidth!.Value, expectedHeight!.Value)).First()
                : titleMatches[0];
        }
        else if (candidates.Count == 1)
        {
            target = candidates[0];
        }
        else if (hasBounds)
        {
            var ranked = candidates
                .Select(candidate => new
                {
                    Candidate = candidate,
                    Distance = BoundsDistance(candidate, expectedLeft!.Value, expectedTop!.Value, expectedWidth!.Value, expectedHeight!.Value)
                })
                .OrderBy(item => item.Distance)
                .ToArray();

            if (ranked.Length > 0)
            {
                var nearestIsDistinct = ranked.Length == 1 || ranked[1].Distance - ranked[0].Distance >= 24;
                if (nearestIsDistinct) target = ranked[0].Candidate;
            }
        }

        if (target is null) return false;
        return Foreground(target);
    }

    private static List<WindowCandidate> EnumerateChromeWindows()
    {
        var windows = new List<WindowCandidate>();
        EnumWindows((hWnd, lParam) =>
        {
            if (!IsWindowVisible(hWnd)) return true;

            var className = GetClassNameText(hWnd);
            if (!className.StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) return true;

            _ = GetWindowThreadProcessId(hWnd, out var processId);
            if (processId == 0 || !IsChromeProcess(processId)) return true;
            if (!GetWindowRect(hWnd, out var rect)) return true;

            windows.Add(new WindowCandidate(
                hWnd,
                processId,
                GetWindowTitle(hWnd),
                rect.Left,
                rect.Top,
                rect.Right - rect.Left,
                rect.Bottom - rect.Top));
            return true;
        }, nint.Zero);
        return windows;
    }

    private static bool Foreground(WindowCandidate target)
    {
        try
        {
            if (IsIconic(target.Handle))
            {
                _ = ShowWindow(target.Handle, SwRestore);
            }
            else
            {
                _ = ShowWindow(target.Handle, SwShow);
            }

            // The helper receives the user's notification click, so it is eligible to
            // perform this user-initiated foreground handoff. Grant Chrome the same
            // foreground privilege as an additional fallback before activating it.
            _ = AllowSetForegroundWindow(target.ProcessId);
            _ = BringWindowToTop(target.Handle);
            var activated = SetForegroundWindow(target.Handle);
            return activated || GetForegroundWindow() == target.Handle;
        }
        catch (Exception error)
        {
            FileLog.Write("Chrome foreground handoff failed", error);
            return false;
        }
    }

    private static bool IsChromeProcess(uint processId)
    {
        try
        {
            using var process = Process.GetProcessById(checked((int)processId));
            return string.Equals(process.ProcessName, "chrome", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static bool TitleMatches(string actualTitle, string expectedTitle)
    {
        var actual = NormalizeTitle(actualTitle);
        if (string.IsNullOrWhiteSpace(actual) || string.IsNullOrWhiteSpace(expectedTitle)) return false;
        return actual.Contains(expectedTitle, StringComparison.OrdinalIgnoreCase)
            || expectedTitle.Contains(actual, StringComparison.OrdinalIgnoreCase);
    }

    private static string NormalizeTitle(string? title)
    {
        var value = string.Join(' ', (title ?? string.Empty).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        foreach (var suffix in new[] { " - Google Chrome", " — Google Chrome", " – Google Chrome" })
        {
            if (value.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
            {
                value = value[..^suffix.Length].Trim();
                break;
            }
        }
        return value;
    }

    private static long BoundsDistance(WindowCandidate candidate, int left, int top, int width, int height)
    {
        return Math.Abs((long)candidate.Left - left)
            + Math.Abs((long)candidate.Top - top)
            + Math.Abs((long)candidate.Width - width)
            + Math.Abs((long)candidate.Height - height);
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

    private sealed record WindowCandidate(
        nint Handle,
        uint ProcessId,
        string Title,
        int Left,
        int Top,
        int Width,
        int Height);

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

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(nint hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(nint hWnd, int command);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool BringWindowToTop(nint hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(nint hWnd);

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AllowSetForegroundWindow(uint processId);
}
