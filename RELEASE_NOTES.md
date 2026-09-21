# ChatGPT Response Notifier 0.9.51

- Fixes a remaining auto-continue race where a monitored chat could emit `BLOCKED_HUMAN` just after the watchdog's final pre-send check and still receive another automatic Continue.
- Status runtime v11 re-checks the exact parent prompt after an automatic Continue is submitted, so a terminal status that lands during Send immediately stops the watchdog.
- Monitor runtime v9 also reports the previous prompt's terminal status while an automatic follow-up is current; worker-owned parent/child lineage keeps a later-arriving `BLOCKED_HUMAN` authoritative instead of treating the automatic follow-up as a new human request.
- A genuinely new human request still starts a fresh watchdog normally.
- Preserves the 30-minute no-code deadline, three-send allowance, traffic governor, terminal-status semantics, and no-F5 hot runtime activation.

