# ChatGPT Response Notifier 0.9.63

- Build automation / Auto Continue remains stored independently for each ChatGPT conversation instead of becoming a tab-wide preference.
- ChatGPT SPA navigation now invalidates only the notifier-owned automation controls when the conversation changes, forcing the green/gray indicator and countdown to reread the newly selected chat's saved state.
- A paused chat stays paused when you leave and return; another chat can remain enabled at the same time.
- Route refresh is local-only and does not add ChatGPT network traffic, foreground tabs, or change the existing automation safety model.
