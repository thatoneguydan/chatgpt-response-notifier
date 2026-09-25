# ChatGPT Response Notifier 0.9.74

- Restores a readable surface behind the Quick Continue timer and attempts-remaining text instead of transparent text over the page.
- Uses one fixed 280px status-chip width when space allows, shrinking only on narrow viewports, so canonical and fallback timer states do not momentarily expand during reinjection.
- Clamps the status chip to an 8px viewport margin and wraps longer waiting-state text instead of allowing it to run off-screen.
- Suppresses the legacy reinjection pseudo-status text while the current local fallback owns status presentation, removing the split-second width jump.
- Hot-upgrades the status fallback in already-open ChatGPT tabs and retains the 0.9.73 request-error notification fix unchanged.