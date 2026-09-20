# ChatGPT Response Notifier 0.9.43

- Separates the user-facing 30-minute auto-continue deadline from the watchdog's internal one-minute safety rechecks, so an overdue chat no longer jumps back to a fake 1:00 countdown while still showing the full Continue budget.
- Keeps an overdue watchdog visibly due and surfaces the current hold reason, such as waiting for generation to finish, the request to settle, the response to stabilize, page observation, or connection recovery.
- Preserves the v0.9.41 settlement-aware send gate, exact-prompt checks, three-send cap, profile traffic governor, and page-side Stop-generating vetoes; internal observation retries still occur once per minute without consuming a Continue.
- Records the successful ordinary Windows restart observation for the fixed-ID notifier and standalone Quick Continue installations; no reload, reinstall, or re-registration was needed.

