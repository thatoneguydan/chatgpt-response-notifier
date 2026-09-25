# ChatGPT Response Notifier 0.9.79

- Makes definitive `COMPLETE_APPLIED`, `COMPLETE_NO_CHANGES`, `BLOCKED_HUMAN`, and `PLANNING_ACTIVE` watchdog stops serialize through the canonical watchdog mutation queue instead of racing normal page snapshots.
- Latches a definitive terminal stop against late stale monitor snapshots and clears that latch only when a genuinely newer ChatGPT request begins.
- Resets auto-continue attempts and clears watchdog alarms/timers as part of the definitive stop path.
- Rejects stale timer overviews by watchdog revision as well as monitor-state revision, preventing an older countdown from replacing a newer terminal-stop state.
- Forces the updated countdown/status runtime into already-open ChatGPT tabs after the extension update.
