# ChatGPT Response Notifier 0.9.41

- Makes the 30-minute coded-work watchdog settlement-aware: reaching the timer only wakes the watchdog and no longer authorizes a Continue while the response is still generating or the request has not settled.
- Requires positively settled no-code evidence before watchdog continuation: either a stable assistant response after the existing missing-footer grace or the existing two-confirmation silent-stop proof.
- Adds independent page-side Stop-generating vetoes before composer mutation and immediately before Send, preserving fail-closed behavior if the page state changes during the watchdog action.
- Preserves the existing 30-minute wake interval, three-send watchdog cap, recoverable `INCOMPLETE_*` continuation behavior, request-owned delivery deduplication, profile traffic governor, and no-ChatGPT-API/no-background-polling design.
