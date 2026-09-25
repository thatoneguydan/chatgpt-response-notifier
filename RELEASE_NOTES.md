# ChatGPT Response Notifier 0.9.78

- Retains the 0.9.77 fixes for paused-timer flicker, definitive `COMPLETE_APPLIED` / `BLOCKED_HUMAN` watchdog stops, attempt reset, and compact timer presentation.
- Fixes the local Quick Continue updater so an explicit update request waits for any already-running check instead of returning an older cached `current` snapshot.
- After the active check finishes, the waiting request performs its own fresh cache-busted feed read, allowing a newly published Quick Continue release to install immediately.
- Ships alongside ChatGPT Quick Continue 1.2.18, which preserves each `\n` in manual-message templates as exactly one composer line break.
