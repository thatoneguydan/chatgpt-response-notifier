# ChatGPT Response Notifier 0.9.68

- `INCOMPLETE_CONTINUE` and the other incomplete work-status codes now preserve the existing auto-continue countdown and attempts-used state instead of clearing or replenishing them before a continuation is confirmed.
- If an incomplete status is observed after an older runtime has already lost its watchdog timer, the notifier repairs the state with a bounded retry rather than going inert.
- Work-status handling now defaults recognized non-stop statuses to continuation; only `PLANNING_ACTIVE`, `COMPLETE_APPLIED`, `COMPLETE_NO_CHANGES`, and `BLOCKED_HUMAN` are explicit status-driven stops.
- Explicit operator resets, explicit terminal/blocked states, and the existing three-send watchdog cap remain authoritative.
