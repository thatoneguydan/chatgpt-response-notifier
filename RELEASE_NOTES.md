# ChatGPT Response Notifier 0.9.46

- Fixes the live-update gap exposed after v0.9.45: an already-open ChatGPT tab no longer needs F5 to receive the repaired watchdog toolbar/runtime.
- Adds an attachment-runtime identity handshake containing both page-runtime version and installed extension version.
- On worker startup after an extension update, verifies the attachment, monitor, status, and bounded-recovery page runtimes in every existing non-frozen ChatGPT tab.
- If any watchdog page runtime is stale, re-injects only the runtimes that have safe dispose/idempotent replacement semantics and verifies the replacement before considering the page current.
- Does not re-inject legacy detector/persistence/recovery scripts that lack safe disposal, does not reload or foreground tabs, and creates no ChatGPT network traffic.
- Preserves v0.9.45's monotonic watchdog state repair and v0.9.44's hard 30-minute no-code contract.

