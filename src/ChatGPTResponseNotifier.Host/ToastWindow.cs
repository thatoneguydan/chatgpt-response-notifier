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

    public event EventHandler? ToastClicked;
    public event EventHandler? ToastDismissed;

    public ToastWindow(NotificationRecord record)
    {
        Record = record;
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
        Grid.SetColumn(title, 0);
        Grid.SetColumn(close, 1);

        var header = new Grid();
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        header.Children.Add(title);
        header.Children.Add(close);

        // NotificationRecord.Preview and CompletedAt remain in the persisted/backend
        // model for popup history and future toast layouts; this compact toast only
        // renders the full title.
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
            Child = header
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
