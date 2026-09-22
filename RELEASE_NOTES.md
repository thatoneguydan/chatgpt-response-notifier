# ChatGPT Response Notifier 0.9.60

- Manual Monitor activation now immediately starts a fresh 30-minute auto-continue countdown, even when the current chat has no request-start timestamp to inherit.
- The countdown begins from the moment monitoring is manually enabled rather than from an older request timestamp.
- Manual activation preserves terminal-stop safety: a visible terminal status such as `BLOCKED_HUMAN` remains stopped and does not regain an auto-continue deadline.
- Adds regression coverage for idle manual activation and terminal-status preservation.
