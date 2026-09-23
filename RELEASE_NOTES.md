# ChatGPT Response Notifier 0.9.62

- Adds a final native-host dedupe guard immediately before a Windows notification is presented.
- Each completion notification now carries a stable delivery key derived from the ChatGPT conversation and assistant response identity, independent of the per-attempt notification UUID.
- If another delivery attempt for that same assistant response arrives while its toast is open, the helper accepts the request idempotently without creating or chiming a second toast.
- The helper also remembers accepted response keys, so a delayed retry after dismissal cannot recreate the same response notification.
- Existing notification-ID dedupe and upstream coordinator/delivery dedupe remain in place; this is an additional last-mile safeguard rather than a replacement.
- Older persisted notifications without a delivery key remain compatible.
