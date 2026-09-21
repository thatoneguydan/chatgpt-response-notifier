# ChatGPT Response Notifier 0.9.52

- Fixes a distinct watchdog failure where a terminal footer such as `COMPLETE_APPLIED` could already be visible but the monitor snapshot could miss it, leaving the 30-minute auto-continue deadline armed.
- Before any watchdog Send, the worker now performs an independent exact-parent-prompt terminal-status query through status runtime v12 instead of relying only on the monitor snapshot.
- Status runtime v12 and monitor runtime v10 add a raw rendered-line fallback for terminal footer recognition while preserving exclusions for code, quotes, lists, and tool output.
- A recognized non-auto terminal status found by the exact-prompt recheck parks the watchdog before composer mutation or Send; regression coverage proves a missed `COMPLETE_APPLIED` cannot reach the continuation command.
- Preserves the intentional 30-minute hard no-code deadline, recoverable `INCOMPLETE_*` behavior, three-send allowance, automatic parent/child lineage, profile traffic governor, and genuine later human-request behavior.
