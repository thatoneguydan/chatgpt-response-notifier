# ChatGPT Response Notifier 0.9.75

- Makes the 30-minute auto-continue countdown a hard continuation deadline instead of turning an expired timer into a wait for "current response identity."
- When ChatGPT's page state temporarily lags the visible conversation at the deadline, keeps the conversation binding but drops the stale prompt binding so Continue targets the conversation's current turn.
- Keeps the real safety vetoes intact: paused/stopped automation, authentication or approval gates, rate limits, offline/unobservable pages, drafts, and uploads still prevent an unsafe automatic send.
- Retains the 0.9.74 readable fixed-width timer/attempts chip, viewport clamping, and flicker/overflow fixes.
