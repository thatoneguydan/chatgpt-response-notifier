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
        Width = 370;
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
        Closed += (_, _) =>
        {
            if (!SuppressCloseEvent) ToastDismissed?.Invoke(this, EventArgs.Empty);
        };
    }

    private UIElement BuildContent(NotificationRecord record)
    {
        var close = new Button
        {
            Content = "×",
            Width = 28,
            Height = 28,
            Padding = new Thickness(0),
            Margin = new Thickness(8, 0, 0, 0),
            Background = Brushes.Transparent,
            Foreground = new SolidColorBrush(Color.FromRgb(220, 220, 220)),
            BorderThickness = new Thickness(0),
            FontSize = 18,
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
            FontSize = 14,
            FontWeight = FontWeights.SemiBold,
            Foreground = Brushes.White,
            TextTrimming = TextTrimming.CharacterEllipsis,
            VerticalAlignment = VerticalAlignment.Center
        };
        Grid.SetColumn(title, 0);
        Grid.SetColumn(close, 1);

        var header = new Grid();
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        header.Children.Add(title);
        header.Children.Add(close);

        var preview = new TextBlock
        {
            Text = record.Preview,
            Margin = new Thickness(0, 8, 0, 0),
            Foreground = new SolidColorBrush(Color.FromRgb(220, 220, 220)),
            FontSize = 12.5,
            TextWrapping = TextWrapping.Wrap,
            MaxHeight = 76
        };

        var time = new TextBlock
        {
            Text = record.CompletedAt.ToLocalTime().ToString("h:mm tt"),
            Margin = new Thickness(0, 8, 0, 0),
            Foreground = new SolidColorBrush(Color.FromRgb(155, 155, 155)),
            FontSize = 10.5
        };

        var stack = new StackPanel();
        stack.Children.Add(header);
        stack.Children.Add(preview);
        stack.Children.Add(time);

        var border = new Border
        {
            Margin = new Thickness(10),
            Padding = new Thickness(14, 12, 12, 11),
            CornerRadius = new CornerRadius(12),
            Background = new SolidColorBrush(Color.FromRgb(31, 31, 31)),
            BorderBrush = new SolidColorBrush(Color.FromRgb(64, 64, 64)),
            BorderThickness = new Thickness(1),
            Effect = new DropShadowEffect
            {
                BlurRadius = 18,
                ShadowDepth = 3,
                Opacity = 0.38
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
