# ChatGPT Response Notifier 0.9.48

- Fixes a terminal-status race where `BLOCKED_HUMAN` and other non-auto-continue GitHub status codes could briefly stop the watchdog and then be undone by a later same-request no-code snapshot.
- Terminal watchdog state is now parked as a durable prompt-scoped tombstone rather than deleting the watchdog record. The same prompt cannot restart its timer even if duplicate request-phase observations carry a newer timestamp.
- Monitor and status page runtimes keep a recognized terminal code sticky for the current prompt so transient DOM rerenders cannot regress it to no-code.
- Attachment runtime v8 uses generation-scoped indicator/status DOM IDs plus a shared suppression stylesheet. Older orphaned page runtimes may continue executing, but their stale timer/indicator nodes are hidden and cannot repaint the current visible controls.
- Preserves v0.9.47 Project-start enrollment and provisional monitoring, v0.9.46 no-F5 hot activation, v0.9.45 monotonic watchdog state, and the hard 30-minute no-code contract.

