using System.Windows;
using System.Windows.Interop;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

internal readonly record struct ToastShowResult(bool Accepted, bool Presented, string PresentationState, string DesktopPlacementState);
internal readonly record struct ToastDismissConversationResult(
    int RemovedCount,
    int RemainingCount,
    IReadOnlyList<string> RemovedNotificationIds);

internal sealed class ToastManager
{
    private const double MarginRight = 16;
    private const double MarginBottom = 16;
    private const double Gap = 10;
    private const string DeliveryTombstonePrefix = "delivery:";

    private readonly NotificationStateStore _store;
    private readonly AcceptedNotificationStore _acceptedStore;
    private readonly Func<object, Task> _sendEvent;
    private readonly List<ToastWindow> _windows = new();

    public ToastManager(NotificationStateStore store, AcceptedNotificationStore acceptedStore, Func<object, Task> sendEvent)
    {
        _store = store;
        _acceptedStore = acceptedStore;
        _sendEvent = sendEvent;
    }

    public int Count => _windows.Count;

    public void Restore()
    {
        foreach (var record in _store.Load().OrderBy(item => item.CompletedAt))
        {
            var deliveryTombstone = DeliveryTombstone(record);
            if (deliveryTombstone is not null && _acceptedStore.Contains(deliveryTombstone))
            {
                continue;
            }

            RememberAcceptance(record);
            AddWindow(record, persist: false);
        }
        Persist();
        Restack();
    }

    public ToastShowResult Show(NotificationRecord record)
    {
        record.Validate();

        var existing = _windows.FirstOrDefault(window => window.Record.Id == record.Id);
        if (existing is not null)
        {
            RememberAcceptance(record);
            return new ToastShowResult(true, false, "already-open", "not-applicable");
        }

        var deliveryKey = record.DeliveryKey.Trim();
        if (deliveryKey.Length > 0)
        {
            var sameResponse = _windows.FirstOrDefault(window =>
                string.Equals(window.Record.DeliveryKey.Trim(), deliveryKey, StringComparison.Ordinal));
            if (sameResponse is not null)
            {
                RememberAcceptance(record);
                return new ToastShowResult(true, false, "response-already-open", "not-applicable");
            }

            var deliveryTombstone = DeliveryTombstone(deliveryKey);
            if (_acceptedStore.Contains(deliveryTombstone))
            {
                _acceptedStore.Remember(record.Id);
                return new ToastShowResult(true, false, "response-already-accepted", "not-applicable");
            }
        }

        if (_acceptedStore.Contains(record.Id))
        {
            return new ToastShowResult(true, false, "dismissed-tombstone", "not-applicable");
        }

        var desktopPlacementState = AddWindow(record, persist: true);
        CompletionChime.Play();
        return new ToastShowResult(true, true, "presented", desktopPlacementState);
    }

    public ToastDismissConversationResult DismissConversation(string conversationId)
    {
        var matches = _windows
            .Where(window => window.Record.ConversationId == conversationId)
            .ToArray();
        var removedNotificationIds = matches
            .Select(window => window.Record.Id)
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .ToArray();

        foreach (var window in matches)
        {
            RemoveWindow(window, persist: false);
        }
        Persist();
        Restack();

        return new ToastDismissConversationResult(
            RemovedCount: matches.Length,
            RemainingCount: _windows.Count,
            RemovedNotificationIds: removedNotificationIds);
    }

    public void DismissEvent(string notificationId)
    {
        var window = _windows.FirstOrDefault(item => item.Record.Id == notificationId);
        if (window is null) return;
        RemoveWindow(window, persist: true);
        Restack();
    }

    public void ClearAll()
    {
        foreach (var window in _windows.ToArray()) RemoveWindow(window, persist: false);
        Persist();
    }

    public void ReportClickResult(string notificationId, string clickState, int? targetTabId)
    {
        var window = _windows.FirstOrDefault(item => item.Record.Id == notificationId);
        if (window is null) return;
        window.SetClickState(clickState, targetTabId);
        Restack();
    }

    private static string? DeliveryTombstone(NotificationRecord record) => DeliveryTombstone(record.DeliveryKey);

    private static string? DeliveryTombstone(string? deliveryKey)
    {
        var normalized = (deliveryKey ?? string.Empty).Trim();
        return normalized.Length == 0 ? null : DeliveryTombstonePrefix + normalized;
    }

    private void RememberAcceptance(NotificationRecord record)
    {
        _acceptedStore.Remember(record.Id);
        var deliveryTombstone = DeliveryTombstone(record);
        if (deliveryTombstone is not null) _acceptedStore.Remember(deliveryTombstone);
    }

    private string AddWindow(NotificationRecord record, bool persist)
    {
        var desktopTarget = WindowsVirtualDesktopSwitcher.CaptureCurrentDesktop();
        var window = new ToastWindow(record);
        window.ToastClicked += async (_, _) =>
        {
            window.SetClickState("pending", window.TargetTabId);
            Restack();
            await _sendEvent(new
            {
                type = "toast.clicked",
                notificationId = record.Id,
                conversationId = record.ConversationId,
                conversationUrl = record.ConversationUrl,
                targetTabId = window.TargetTabId,
                correlationId = Guid.NewGuid().ToString("N")
            });
        };
        window.ToastDismissed += async (_, _) =>
        {
            RemoveWindow(window, persist: true);
            Restack();
            await _sendEvent(new
            {
                type = "toast.dismissed",
                notificationId = record.Id,
                conversationId = record.ConversationId
            });
        };
        window.SizeChanged += (_, _) => Restack();
        _windows.Add(window);

        if (persist)
        {
            Persist();
            RememberAcceptance(record);
        }

        window.Show();
        var hwnd = new WindowInteropHelper(window).Handle;
        var placement = WindowsVirtualDesktopSwitcher.PlaceWindowOnDesktop(hwnd, desktopTarget);
        return placement.Reason;
    }

    private void RemoveWindow(ToastWindow window, bool persist)
    {
        if (!_windows.Remove(window)) return;
        window.SuppressCloseEvent = true;
        window.Close();
        if (persist) Persist();
    }

    private void Persist()
    {
        _store.Save(_windows.Select(window => window.Record));
    }

    private void Restack()
    {
        if (_windows.Count == 0) return;
        var workArea = SystemParameters.WorkArea;
        var y = workArea.Bottom - MarginBottom;

        foreach (var window in _windows.OrderByDescending(item => item.Record.CompletedAt))
        {
            window.Left = Math.Max(workArea.Left + 8, workArea.Right - MarginRight - window.ActualWidth);
            y -= window.ActualHeight;
            window.Top = Math.Max(workArea.Top + 8, y);
            y -= Gap;
        }
    }
}
