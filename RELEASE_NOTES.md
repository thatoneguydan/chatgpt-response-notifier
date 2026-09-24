# ChatGPT Response Notifier 0.9.69

- A new ChatGPT request while the green automation control is active now re-arms a stopped or missing auto-continue watchdog instead of inheriting the previous turn's stopped state.
- During the short request/DOM ordering window, the prior prompt and its terminal footer are withheld from the new request so an old `COMPLETE_*` footer cannot immediately stop the freshly re-armed watchdog.
- Normal active watchdogs are not re-armed on every request, so automatic continuations still retain the existing three-send cap instead of resetting their budget.
- A terminal status that belongs to the newly rendered prompt remains authoritative; explicit operator pause and `BLOCKED_HUMAN` behavior are unchanged.