# ChatGPT Response Notifier 0.9.44

- Makes the 30-minute monitored-chat watchdog a hard no-code deadline: if no recognized GitHub status code is present when the deadline arrives, it sends the configured Continue follow-up even if ChatGPT is still generating, using tools, unsettled, manually stopped, or lacks stable-terminal/silent-idle proof.
- Preserves blockers that make automatic submission unsafe or impossible: page/runtime unavailable, offline/auth/approval/rate-limit state, an existing user draft/upload, conversation/prompt identity mismatch, user-paused automation, and the profile-wide traffic breaker/governor.
- Keeps the immediate pre-send status-code race check, exact conversation/prompt binding, three-send watchdog cap, and 30-minute reset after each successfully confirmed watchdog Continue.
- Rearms persisted overdue watchdog deadlines immediately when the extension runtime starts, so a stale v0.9.43 settlement retry cannot keep an already-due chat waiting after upgrade.

