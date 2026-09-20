# ChatGPT Response Notifier 0.9.47

- Automatically enrolls fresh project-continuation requests that use the canonical-GitHub-state project prompt, so chats started from the standalone Project button do not begin unmonitored.
- Preserves explicit operator Pause: a project-start signal cannot silently re-enable a conversation the user paused.
- Fixes the new-chat provisional-monitoring race where ChatGPT could assign the new conversation URL before the request-start callback armed the provisional record.
- An enabled provisional Monitor choice now survives URL assignment and early snapshots until the next ChatGPT request binds it to the conversation or the tab closes.
- Navigation alone still does not bind a provisional record to a conversation.
- Requires no standalone Quick Continue update; the notifier recognizes the Project prompt already emitted by the installed standalone extension.
- Preserves v0.9.46 hot page-runtime activation, v0.9.45 monotonic watchdog state, and the hard 30-minute no-code contract.

