# ChatGPT Response Notifier 0.9.64

- The existing Windows helper now also manages releases for the separate ChatGPT Quick Continue extension when that extension is installed at its stable user-profile path.
- Quick Continue updates are accepted only from the pinned repository release route with the published SHA-256 digest, preserve the installed config defaults, and publish the extension manifest last.
- A narrow loopback update endpoint lets Quick Continue detect the helper-installed version without opening the notifier's privileged WebSocket bridge to another extension.
- Quick Continue 1.2.9 adds a small service worker that checks only the loopback helper, reloads its own extension when the installed version changes, and reinjects the current runtime into already-open ChatGPT tabs.
- If the notifier helper is unavailable, Quick Continue's Continue/Project/timestamp features keep working; only managed update delivery pauses.
