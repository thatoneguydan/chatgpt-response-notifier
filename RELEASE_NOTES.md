# ChatGPT Response Notifier 0.9.70

- The notifier now tolerates the current ChatGPT web UI when legacy `conversation-turn-*`, composer, Send, or Stop selectors are absent, using only DOM that ChatGPT already rendered in the page.
- Existing hot-runtime injections also receive the compatibility layer, so already-open ChatGPT tabs do not need a manual extension reload just to regain turn/composer detection.
- This compatibility path does not poll ChatGPT APIs, fetch conversation state, or create extra server requests; existing request-lifecycle observation remains passive over requests the page itself makes.
- Recovery reloads are now forced to bypass cache, matching a hard `Ctrl+F5`-style refresh, and the persistent recovery action gate is raised to at least 60 seconds between recovery actions so hard refreshes cannot repeat more frequently than once per minute.
- The existing fail-open new-request rearm behavior remains in place, preventing an old stopped watchdog from winning when a fresh active request is underway.