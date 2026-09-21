# ChatGPT Response Notifier 0.9.54

- Deep-debug follow-up to v0.9.53: watchdog state now carries a monotonic logical revision, so reversed asynchronous toolbar messages cannot repaint a newer terminal stop when two durable writes share the same `Date.now()` millisecond.
- All remaining worker-owned watchdog mutations now use the same per-conversation queue, including operator Pause/disable clearing and the manual auto-continue allowance reset.
- Attachment runtime v12 uses logical watchdog revisions first and retains timestamp ordering only for legacy records that predate v0.9.54; revision ordering is scoped to the enrollment lifecycle so Pause/Resume can legitimately restart the watchdog sequence.
- New-chat Project monitoring now carries browser-observed request-start evidence across the `/` → `/c/<id>` runtime transition; a replacement page runtime can reconstruct freshness from a completed/error phase instead of silently missing auto-enrollment.
- Status policy is unchanged and remains generic: only `INCOMPLETE_LIMIT`, `INCOMPLETE_TOOL_FAILURE`, `INCOMPLETE_CONTINUE`, and `INCOMPLETE_HANDOFF` auto-continue; every other recognized terminal status, including `BLOCKED_HUMAN` and both `COMPLETE_*` codes, stops.
- Companion Quick Continue 1.2.4 replaces permanent page-global install guards with versioned runtime handoff, restores a detached toolbar, removes owned listeners on disposal, ignores notifier-only countdown mutations, and prevents its own clock update from continuously retriggering the full-page MutationObserver.
- Validation and release now syntax-check and execute the standalone Quick Continue suite in addition to the full notifier suite, so the companion runtime cannot ship behind a notifier-only green check.
- Preserves the 30-minute hard no-code deadline, three-send allowance, exact-parent pre-Send terminal recheck, traffic governor, and notifier hot activation without a manual page refresh.
