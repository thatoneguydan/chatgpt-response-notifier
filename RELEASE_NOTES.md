# ChatGPT Response Notifier 0.9.57

- Fixes the green monitoring indicator becoming unclickable after an extension reload while its countdown kept running.
- Gives each live attachment-script execution a shared-DOM ownership token so only the newest runtime may render or mutate the monitoring indicator and auto-continue countdown.
- Moves the current controls to a new runtime-owned DOM namespace and permanently hides older indicator/status nodes, preventing a stale pre-reload content-script world from repainting current state.
- Guards countdown ticks, indicator maintenance, state messages, budget resets, and Monitor/Pause/Resume clicks on current UI ownership.
- Advances the hot-page attachment runtime to v13 so already-open chats receive the ownership repair without foregrounding or reloading the ChatGPT page.
- Preserves the durable operator Pause gate in the background worker: paused conversations remain unable to send watchdog Continue actions.

