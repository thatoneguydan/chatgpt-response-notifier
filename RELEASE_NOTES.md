# ChatGPT Response Notifier 0.9.77

- Treats definitive `COMPLETE_APPLIED`, `COMPLETE_NO_CHANGES`, `BLOCKED_HUMAN`, and `PLANNING_ACTIVE` stream status as authoritative watchdog-stop evidence before DOM/UI timing can race it.
- Clears the watchdog timer and resets remaining auto-continue attempts when a definitive status stops the run.
- Prevents stale overview replies from briefly restoring a countdown after Monitor is turned off.
- Keeps the compact timer surface and 30-minute hard-deadline behavior unchanged for active monitored runs.
- Ships alongside ChatGPT Quick Continue 1.2.18, which preserves each `\n` in manual-message templates as exactly one composer line break instead of letting contenteditable insertion multiply blank lines.
