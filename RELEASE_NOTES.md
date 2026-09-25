# ChatGPT Response Notifier 0.9.81

- Fixes the live `COMPLETE_APPLIED` miss reproduced on Glass when a long-running ChatGPT response crosses an extension update boundary.
- Preserves an already-observed terminal footer when Chrome throws while finishing a cloned SSE response; a late stream read error can no longer erase the status token before the worker parks the watchdog.
- Reinstalls the current status parser and terminal page authority into already-open ChatGPT tabs after an extension update, then forces bounded rechecks so a response already in progress is still evaluated by the new runtime.
- Repeats that bounded terminal refresh after a `stream-read-error`, covering the exact failure path observed in live runtime evidence without adding ChatGPT polling or extra requests.
- Keeps the 0.9.80 watchdog rules: definitive COMPLETE/BLOCKED/PLANNING statuses stop the timer, and a later trusted manual / Continue / Project send explicitly starts a new 30-minute timer.
