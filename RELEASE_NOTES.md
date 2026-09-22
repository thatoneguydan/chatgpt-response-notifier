# ChatGPT Response Notifier 0.9.61

- Quick Continue's **Continue** action now re-arms a fresh 30-minute watchdog countdown from the user action.
- Selecting a saved project or sending a custom project through the **Project** control does the same.
- These explicit user actions reset the normal three auto-continue allowance and can re-arm a watchdog that had stopped on a prior terminal response.
- Clicking the countdown / “continues left” text still resets the allowance; when no timer is active, it now also starts a fresh 30-minute countdown.
- A deliberately paused conversation remains paused; these controls do not silently defeat the operator Pause override.
- Attachment runtime advances to v14 so the behavior hot-activates on already-open ChatGPT tabs after the managed notifier update.
