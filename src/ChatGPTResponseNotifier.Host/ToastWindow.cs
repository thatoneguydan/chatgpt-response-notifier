using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
using ChatGPTResponseNotifier.Core;

namespace ChatGPTResponseNotifier.Host;

internal sealed class ToastWindow : Window
{
    public NotificationRecord Record { get; }
    public bool SuppressCloseEvent { get; set; }
    private Button? _moveHereButton;
    private TextBlock? _clickStateText;
    public int? TargetTabId { get; private set; }

    public event EventHandler? ToastClicked;
    public event EventHandler? ToastMoveHereRequested;
    public event EventHandler? ToastDismissed;

    public ToastWindow(NotificationRecord record)
    {
        Record = record;
        TargetTabId = record.TargetTabId;
        Width = 350;
        SizeToContent = SizeToContent.Height;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        ShowInTaskbar = false;
        Topmost = true;
        ShowActivated = false;
        Focusable = false;

        Content = BuildContent(record);

        // Closing the helper process (including a managed-update handoff) must
        // not be interpreted as a user dismissal. Explicit user actions below
        // raise ToastDismissed/ToastClicked themselves; ordinary window teardown
        // leaves the persisted pending-notification state intact for restoration.
    }

    private UIElement BuildContent(NotificationRecord record)
    {
        var close = new Button
        {
            Content = "×",
            Width = 24,
            Height = 24,
            Padding = new Thickness(0),
            Margin = new Thickness(8, 0, 0, 0),
            Background = Brushes.Transparent,
            Foreground = new SolidColorBrush(Color.FromRgb(70, 70, 70)),
            BorderThickness = new Thickness(0),
            FontSize = 16,
            Cursor = Cursors.Hand,
            ToolTip = "Dismiss"
        };
        close.Click += (_, e) =>
        {
            e.Handled = true;
            SuppressCloseEvent = true;
            ToastDismissed?.Invoke(this, EventArgs.Empty);
        };

        var title = new TextBlock
        {
            Text = record.Title,
            FontSize = 13.5,
            FontWeight = FontWeights.SemiBold,
            Foreground = new SolidColorBrush(Color.FromRgb(30, 30, 30)),
            TextWrapping = TextWrapping.Wrap,
            VerticalAlignment = VerticalAlignment.Center
        };
        var completedAt = new TextBlock
        {
            Text = FormatCompletedAt(record.CompletedAt),
            Margin = new Thickness(8, 0, 0, 0),
            Foreground = new SolidColorBrush(Color.FromRgb(92, 92, 92)),
            FontSize = 10.5,
            VerticalAlignment = VerticalAlignment.Center
        };
        Grid.SetColumn(title, 0);
        Grid.SetColumn(completedAt, 1);
        Grid.SetColumn(close, 2);

        var header = new Grid();
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        header.Children.Add(title);
        header.Children.Add(completedAt);
        header.Children.Add(close);

        var stack = new StackPanel();
        stack.Children.Add(header);
        if (!string.IsNullOrWhiteSpace(record.StatusCode))
        {
            stack.Children.Add(new TextBlock
            {
                Text = record.StatusCode,
                Margin = new Thickness(0, 4, 0, 0),
                Foreground = new SolidColorBrush(Color.FromRgb(92, 92, 92)),
                FontFamily = new FontFamily("Consolas"),
                FontSize = 10.5,
                FontWeight = FontWeights.SemiBold,
                TextWrapping = TextWrapping.Wrap
            });
        }

        _clickStateText = new TextBlock
        {
            Visibility = Visibility.Collapsed,
            Margin = new Thickness(0, 6, 0, 0),
            Foreground = new SolidColorBrush(Color.FromRgb(92, 92, 92)),
            FontSize = 10.5,
            TextWrapping = TextWrapping.Wrap
        };
        stack.Children.Add(_clickStateText);

        _moveHereButton = new Button
        {
            Content = "Move this tab here",
            Visibility = Visibility.Collapsed,
            HorizontalAlignment = HorizontalAlignment.Left,
            Margin = new Thickness(0, 7, 0, 0),
            Padding = new Thickness(9, 3, 9, 3),
            FontSize = 10.5,
            Cursor = Cursors.Hand
        };
        _moveHereButton.Click += (_, e) =>
        {
            e.Handled = true;
            ToastMoveHereRequested?.Invoke(this, EventArgs.Empty);
        };
        stack.Children.Add(_moveHereButton);

        // Preview remains persisted in NotificationRecord for popup history and
        // future toast layouts, but is intentionally not rendered here.
        var border = new Border
        {
            Margin = new Thickness(6),
            Padding = new Thickness(12, 9, 9, 9),
            CornerRadius = new CornerRadius(9),
            Background = new SolidColorBrush(Color.FromRgb(248, 248, 248)),
            BorderBrush = new SolidColorBrush(Color.FromRgb(210, 210, 210)),
            BorderThickness = new Thickness(1),
            Effect = new DropShadowEffect
            {
                BlurRadius = 14,
                ShadowDepth = 2,
                Opacity = 0.22
            },
            Cursor = Cursors.Hand,
            Child = stack
        };
        border.MouseLeftButtonUp += (_, e) =>
        {
            if (FindAncestor<Button>(e.OriginalSource as DependencyObject) is not null) return;
            e.Handled = true;
            SuppressCloseEvent = true;
            ToastClicked?.Invoke(this, EventArgs.Empty);
        };
        return border;
    }

    public void SetClickState(string state, int? targetTabId = null)
    {
        if (targetTabId is >= 0) TargetTabId = targetTabId;
        if (_moveHereButton is null || _clickStateText is null) return;

        switch (state)
        {
            case "other-desktop":
                _clickStateText.Text = "This chat is on another Windows desktop.";
                _clickStateText.Visibility = Visibility.Visible;
                _moveHereButton.Visibility = TargetTabId is >= 0 ? Visibility.Visible : Visibility.Collapsed;
                break;
            case "move-failed":
                _clickStateText.Text = "Could not move the existing tab here. Click the notification to retry.";
                _clickStateText.Visibility = Visibility.Visible;
                _moveHereButton.Visibility = TargetTabId is >= 0 ? Visibility.Visible : Visibility.Collapsed;
                break;
            case "probe-timeout":
            case "route-timeout":
            case "unverified":
            case "visible-not-focused":
            case "target-changed":
            case "ambiguous":
            case "invalid":
            case "error":
                _clickStateText.Text = "Could not confirm the existing tab was shown. Click the notification to retry.";
                _clickStateText.Visibility = Visibility.Visible;
                _moveHereButton.Visibility = Visibility.Collapsed;
                break;
            case "pending":
                _clickStateText.Text = "Opening existing tab…";
                _clickStateText.Visibility = Visibility.Visible;
                _moveHereButton.Visibility = Visibility.Collapsed;
                break;
            default:
                _clickStateText.Text = string.Empty;
                _clickStateText.Visibility = Visibility.Collapsed;
                _moveHereButton.Visibility = Visibility.Collapsed;
                break;
        }
    }

    private static string FormatCompletedAt(DateTimeOffset value)
    {
        var local = value.ToLocalTime();
        return local.Date == DateTimeOffset.Now.Date
            ? local.ToString("t")
            : local.ToString("MMM d, t");
    }

    private static T? FindAncestor<T>(DependencyObject? node) where T : DependencyObject
    {
        while (node is not null)
        {
            if (node is T match) return match;
            node = VisualTreeHelper.GetParent(node);
        }
        return null;
    }
}
