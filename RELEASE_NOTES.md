# ChatGPT Response Notifier 0.9.42

- Simplifies the Quick Continue monitoring light to two visual states: gray when automation is inactive, paused, guarded, or ready to start; green only while automation is actively monitoring and allowed to continue.
- Adds a compact status line above the Quick Continue and Project controls for active chats, showing the notifier watchdog's persisted minute:second countdown and the number of automatic Continues remaining.
- Shows `Auto-continues exhausted` after the three-send watchdog budget is spent, and keeps waiting/due states tied to the real persisted watchdog record instead of a cosmetic independent timer.
- Preserves the v0.9.41 settlement-aware watchdog safety checks, three-send cap, profile traffic governor, and no-ChatGPT-API/no-background-polling design.
