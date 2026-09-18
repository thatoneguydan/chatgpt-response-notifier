using System.Windows;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

internal readonly record struct ToastShowResult(bool Accepted, bool Presented, string PresentationState);
internal readonly record struct ToastDismissConversationResult(
    int RemovedCount,
    int RemainingCount,
    IReadOnlyList<string> RemovedNotificationIds);

internal sealed class ToastManager
{
    private const double MarginRight = 16;
    private const double MarginBottom = 16;
    private const double Gap = 10;

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
            _acceptedStore.Remember(record.Id);
            AddWindow(record, persist: false);
        }
        Restack();
    }

    public ToastShowResult Show(NotificationRecord record)
    {
        record.Validate();

        var existing = _windows.FirstOrDefault(window => window.Record.Id == record.Id);
        if (existing is not null)
        {
            _acceptedStore.Remember(record.Id);
            return new ToastShowResult(true, false, "already-open");
        }

        if (_acceptedStore.Contains(record.Id))
        {
            return new ToastShowResult(true, false, "dismissed-tombstone");
        }

        AddWindow(record, persist: true);
        CompletionChime.Play();
        return new ToastShowResult(true, true, "presented");
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

    private void AddWindow(NotificationRecord record, bool persist)
    {
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
            _acceptedStore.Remember(record.Id);
        }

        window.Show();
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
