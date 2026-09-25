# ChatGPT Response Notifier 0.9.80

- Makes definitive `COMPLETE_APPLIED`, `COMPLETE_NO_CHANGES`, `BLOCKED_HUMAN`, and `PLANNING_ACTIVE` states storage-authoritative: once observed, stale monitor/request writes cannot reopen the watchdog until a trusted manual submission or explicit operator reset rearms it.
- Adds a second page-to-worker terminal stop authority that bypasses prompt-key timing races while retaining the existing status grammar and definitive-stop policy.
- Treats trusted manual sends and Quick Continue / Project sends as fresh user work and explicitly rearms the watchdog to a new 30-minute countdown after the new user turn appears.
- Replaces the shared legacy timer node with a versioned single-owner status surface. Older extension contexts can no longer repaint the active timer after an update, eliminating active/due flicker from orphaned UI runtimes.
- Removes the persistent `Auto-continue due` state. When a deadline is due, the status owner immediately asks the worker to execute it and shows `Sending auto-continue…`; genuine safety blockers are shown as blocked/retry states instead.
- Preserves the three-send cap for extension-generated automatic continuations because only trusted user submissions explicitly reset the fresh-work watchdog budget.
