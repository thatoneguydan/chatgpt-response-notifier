# ChatGPT Response Notifier 0.9.53

- Fixes terminal timer/status flicker where one monitored chat could alternate between a durable `Auto-continue stopped` state and a stale/transient active or waiting state.
- Worker watchdog reconciliation and alarm handling now share one per-conversation mutation queue, preventing concurrent snapshot/alarm writes from moving durable watchdog state backward.
- Attachment runtime v11 rejects a same-conversation, same-enrollment overview that transiently drops an already-known watchdog record, while still accepting a genuinely newer watchdog or an explicit automation state revision.
- The behavior remains policy-driven: `INCOMPLETE_LIMIT`, `INCOMPLETE_TOOL_FAILURE`, `INCOMPLETE_CONTINUE`, and `INCOMPLETE_HANDOFF` are the auto-continue statuses; every other recognized terminal status is a stop.
- Preserves v0.9.52 exact-parent pre-Send terminal rechecks, the 30-minute hard no-code deadline, three-send allowance, traffic governor, and no-reload hot activation.
