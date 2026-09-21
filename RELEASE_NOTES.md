# ChatGPT Response Notifier 0.9.55

- Prevents false terminal stops when a GitHub status token appears inside assistant prose: the DOM fallback now accepts only one exact status-only terminal block at the end of the assistant response, preserving the strict footer contract.
- Cleans up extension-generated Continue text when a Send click produces an error or no confirmed user turn, so the watchdog cannot mistake its own unsent prompt for a user draft and pause itself.
- Status page runtime advances to v13 so hot reinjection replaces stale page logic on already-open ChatGPT tabs.
- Preserves generic status policy: only `INCOMPLETE_LIMIT`, `INCOMPLETE_TOOL_FAILURE`, `INCOMPLETE_CONTINUE`, and `INCOMPLETE_HANDOFF` auto-continue; recognized terminal stop statuses still stop.
- Preserves the 30-minute hard no-code deadline, three-send allowance, exact-parent pre-Send terminal recheck, traffic governor, and notifier hot activation without a manual page refresh.
