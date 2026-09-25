# ChatGPT Response Notifier 0.9.76

- Starts the 30-minute auto-continue countdown from an actual ChatGPT request start, including the first prompt of a monitored new chat after its conversation URL is assigned.
- Turning Monitor on by itself no longer starts a countdown while a prompt is merely being drafted; the watchdog waits for the next real send.
- Definitive `COMPLETE_APPLIED`, `COMPLETE_NO_CHANGES`, `BLOCKED_HUMAN`, and `PLANNING_ACTIVE` footers now directly park the watchdog and clear its timer.
- Replaces competing timer/status surfaces with one compact content-sized chip and suppresses the legacy status before the toolbar mounts, eliminating the wide initial/periodic flicker and oversized status bar.
- Keeps the 0.9.75 hard-deadline behavior and existing safety vetoes unchanged.
