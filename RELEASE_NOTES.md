# ChatGPT Response Notifier 0.9.40

- Makes the Quick Continue monitoring indicator event-driven and state-preserving, eliminating the periodic refresh/fallback behavior that could make the light visibly flash.
- Retains the bounded 30-minute coded-work watchdog with at most three automatic continuation sends when no terminal GitHub status code appears, while recoverable incomplete codes continue through the existing guarded continuation path.
- Includes the accepted Windows virtual-desktop notification path: passive toasts use the directly reported current desktop, and an explicit toast click returns to the exact existing Chrome chat window rather than cloning or moving the conversation.
- Preserves request-owned delivery deduplication, bounded recovery, the profile-wide traffic governor, and the no-ChatGPT-API/no-background-polling design.
