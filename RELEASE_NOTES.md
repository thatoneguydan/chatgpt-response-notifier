# ChatGPT Response Notifier 0.9.72

- Restores the auto-continue timer and attempts-remaining text above the Quick Continue toolbar when the canonical countdown control is temporarily hidden or replaced during notifier hot reinjection.
- Adds a local-only status fallback that reads the notifier's existing automation overview, keeps the countdown moving once per second, and yields immediately whenever the canonical countdown is visible again.
- The fallback retains the existing click-to-reset behavior for auto-continue attempts and uses only extension-local messaging; it does not poll ChatGPT or add conversation/network requests.
- Continue and Project actions continue to enable monitoring and arm only after the new user turn exists, preserving the previous-response race fix from 0.9.71.
- Definitive current-turn GitHub status footers continue to stop the watchdog through prompt-identity-checked reconciliation.
