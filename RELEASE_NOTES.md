# ChatGPT Response Notifier 0.9.87

- Removes direct Continue authority from bounded stale/error recovery. Only the 30-minute watchdog may send automatic Continue messages, preventing recovery incidents from creating 30–60 second Continue cascades.
- Changes stale-chat recovery to one cache-bypassing hard refresh (`bypassCache: true`, equivalent to a Ctrl+F5-style reload), then observes whether work resumes. If it remains stale, recovery yields to the existing watchdog instead of sending or scheduling another recovery Continue.
- Keeps the watchdog timer authoritative across stale recovery: a successful automatic Continue remains followed by the normal 30-minute watchdog window rather than a recovery-owned short cadence.
- After the watchdog retry budget is exhausted and a hard refresh still leaves the automatic generation stale, the watchdog is parked and a Needs attention notification is raised instead of continuing indefinitely.
- Adds regression coverage proving stale recovery has no message-send command, performs only the hard-refresh path, and cannot admit a recovery Continue action.

## Previous: 0.9.86

- Adds a live rendered-footer authority that detects the final GitHub status from connected ChatGPT DOM instead of depending on detached-clone line breaks. This covers segmented/sibling footer markup that was visibly present but still reported as `terminal-code-not-observed`.
- Routes a confirmed definitive rendered status directly to both watchdog parking and the durable notification outbox, so `PLANNING_ACTIVE`, `COMPLETE_APPLIED`, `COMPLETE_NO_CHANGES`, and `BLOCKED_HUMAN` no longer depend on a second fragile DOM query before stopping or notifying.
- Keeps terminal delivery identity-bound to the current conversation, prompt, assistant turn, and revision, with coordinator claim/dedupe before a toast is queued.
- Makes the response-stream bridge replaceable across extension updates; an already-open tab can no longer retain a dead pre-update bridge guard that silently blocks the stream fallback.
- Hot-binds and verifies the rendered terminal observer in already-open ChatGPT tabs without refreshing or foregrounding them.

## Previous: 0.9.85

- Replaces the watchdog countdown with a durable single-owner DOM surface that can take over an already-open ChatGPT tab even when the pre-update timer runtime is still executing with a dead extension context.
- Moves the live timer into a new DOM namespace that the stale 0.9.84-and-earlier timer code cannot delete or repaint, while statically hiding those legacy timer rows so they cannot flicker back into view.
- Adds a document-level timer ownership lease. Future timer runtimes detect when a newer owner has claimed the page and relinquish their intervals, listeners, and row instead of competing for the toolbar.
- Requires timer runtime v8 from both Quick Continue and watchdog authority bootstrap paths, so already-open tabs cannot be treated as healthy while a stale v7 timer surface is still present.
- Preserves the existing backend behavior where Pause clears the active watchdog and Stop cancels only the current timer while monitoring remains enabled.

## Previous: 0.9.84

- Rebinds the complete critical isolated-world runtime set in already-open ChatGPT tabs after an extension update, so a page refresh is no longer required for new monitor/status/control code to take ownership.
- Runs the page DOM compatibility adapter before every hot-injected turn reader, including Quick Continue and watchdog page authority, so current semantic `data-turn` nodes remain visible during no-refresh updates.
- Disposes stale timer, monitor, status, Quick Continue, and watchdog owners once per extension version and clears legacy listener guards before binding the new version.
- Restores live Stop, Monitor/Pause, trusted-manual-send rearming, terminal-code parking, and completion notification observation after an extension update without foregrounding or reloading the ChatGPT tab.

## Previous: 0.9.83

- Restores assistant/user turn text extraction on ChatGPT's current semantic `data-turn` DOM while retaining legacy `data-message-author-role` compatibility.
- Restores definitive GitHub status detection so `PLANNING_ACTIVE`, `COMPLETE_APPLIED`, `COMPLETE_NO_CHANGES`, and `BLOCKED_HUMAN` can park the watchdog instead of allowing unwanted auto-continues.
- Restores the rendered-status input used by completion notification delivery on current ChatGPT turns.
- Uses semantic message/turn IDs when available so prompt identity remains stable across current ChatGPT DOM shapes and rerenders.

## Previous: 0.9.82

- Unifies the timer surface so the notifier owns one full-width, black, right-aligned and wrapping countdown with a separate Stop control. Stop cancels the current timer while Monitor stays enabled.
- Keeps a definitive `PLANNING_ACTIVE`, `COMPLETE_APPLIED`, `COMPLETE_NO_CHANGES`, or `BLOCKED_HUMAN` stop parked through late same-turn request and action events.
- Routes a stream read failure through an exact request-and-turn-bound rendered-status observation. The test-toast button now waits for the Windows helper to confirm actual presentation.
- Updates Quick Continue 1.2.19 to preserve exact line breaks through editor insertion, avoid hidden composer selection, and ignore countdown-only toolbar mutations.

## Previous: 0.9.81

- Fixes the live `COMPLETE_APPLIED` miss reproduced on Glass when a long-running ChatGPT response crosses an extension update boundary.
- Preserves an already-observed terminal footer when Chrome throws while finishing a cloned SSE response; a late stream read error can no longer erase the status token before the worker parks the watchdog.
- Reinstalls the current status parser and terminal page authority into already-open ChatGPT tabs after an extension update, then forces bounded rechecks so a response already in progress is still evaluated by the new runtime.
- Repeats that bounded terminal refresh after a `stream-read-error`, covering the exact failure path observed in live runtime evidence without adding ChatGPT polling or extra requests.
- Keeps the 0.9.80 watchdog rules: definitive COMPLETE/BLOCKED/PLANNING statuses stop the timer, and a later trusted manual / Continue / Project send explicitly starts a new 30-minute timer.