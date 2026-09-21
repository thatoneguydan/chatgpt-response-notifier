# ChatGPT Response Notifier 0.9.56

- Fixes prompt/request ordering races that could make the auto-continue status flicker or remain stopped after a new human message.
- Terminal watchdog tombstones are now truly prompt-scoped: a stale terminal snapshot from an older prompt cannot overwrite a watchdog that already tracks a different prompt at the same or newer page-global request timestamp.
- A stopped prompt no longer absorbs a newer request timestamp merely because ChatGPT has not yet rendered the new user turn; once the genuinely new prompt appears, it starts a fresh watchdog normally.
- Preserves the automatic parent→child protection: a late terminal status on the parent still stops an automatic Continue child.
- Preserves generic status policy, the 30-minute hard no-code deadline, three-send allowance, user-draft/upload vetoes, exact-parent terminal rechecks, and no-focus/no-API behavior.
