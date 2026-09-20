# ChatGPT Response Notifier 0.9.45

- Stops monitored-chat watchdog state from moving backward when an older request snapshot arrives after a newer request or automatic Continue has already advanced the conversation.
- Prevents repeated stale recoverable-status observations from clearing a newly scheduled watchdog deadline back into `Auto-continue waiting`.
- Persists the next 30-minute deadline atomically after a successful no-code watchdog Continue, removing the transient zero-deadline state that could be rendered as `Auto-continue waiting`.
- Gives successful recoverable-code watchdog Continues their next 30-minute deadline immediately instead of exposing an unscheduled waiting gap.
- Rejects out-of-order watchdog overview updates in the toolbar when their persisted watchdog `updatedAt` is older than the state already displayed.
- Preserves v0.9.44's hard 30-minute no-code contract, three-send cap, exact conversation/prompt checks, immediate pre-send status-code race check, and profile traffic protections.

