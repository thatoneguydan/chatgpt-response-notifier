# Watchdog lifecycle correction — 2026-09-25

The watchdog timer is bound to generation request lifecycle, not the Monitor toggle.

- Enabling Monitor alone leaves the watchdog waiting for a real request.
- A ChatGPT conversation POST starts the 30-minute deadline.
- For a monitored `/` new-chat page, the request start is retained until ChatGPT assigns the `/c/<conversation>` route, then the same request start anchors the timer.
- Quick Continue and Project actions retain their explicit fresh-turn arming path.
- Definitive GitHub work statuses (`PLANNING_ACTIVE`, `COMPLETE_APPLIED`, `COMPLETE_NO_CHANGES`, `BLOCKED_HUMAN`) directly park the watchdog.
- Timer presentation has one owner: a compact fallback chip. Legacy/canonical timer text and the pseudo-status are suppressed from document start to avoid geometry flicker.
