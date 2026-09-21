# ChatGPT Response Notifier 0.9.54

- Deep-debug follow-up to v0.9.53: watchdog state now carries a monotonic logical revision, so reversed asynchronous toolbar messages cannot repaint a newer terminal stop when two durable writes share the same `Date.now()` millisecond.
- All remaining worker-owned watchdog mutations now use the same per-conversation queue, including operator Pause/disable clearing and the manual auto-continue allowance reset.
- Attachment runtime v12 uses logical watchdog revisions first and retains timestamp ordering only for legacy records that predate v0.9.54.
- Status policy is unchanged and remains generic: only `INCOMPLETE_LIMIT`, `INCOMPLETE_TOOL_FAILURE`, `INCOMPLETE_CONTINUE`, and `INCOMPLETE_HANDOFF` auto-continue; every other recognized terminal status, including `BLOCKED_HUMAN` and both `COMPLETE_*` codes, stops.
- Companion Quick Continue 1.2.4 replaces permanent page-global install guards with versioned runtime handoff, restores a detached toolbar, removes owned listeners on disposal, ignores notifier-only countdown mutations, and prevents its own clock update from continuously retriggering the full-page MutationObserver.
- Preserves the 30-minute hard no-code deadline, three-send allowance, exact-parent pre-Send terminal recheck, traffic governor, and notifier hot activation without a manual page refresh.
