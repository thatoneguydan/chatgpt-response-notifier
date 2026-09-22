# ChatGPT Response Notifier 0.9.59

- Fixes a remaining terminal-stop failure proven by this chat continuing to receive 30-minute watchdog prompts after v0.9.58 and a visible `COMPLETE_NO_CHANGES` footer.
- Both watchdog page runtimes now inspect the complete assistant turn, not only the nested node carrying `data-message-author-role="assistant"`.
- The fallback also checks rendered Markdown/prose roots inside the turn, covering ChatGPT layouts where visible response content is a sibling of the role marker.
- Full-turn fallback accepts one unambiguous status code even when ChatGPT appends UI metadata after the footer, while conflicting status codes still fail closed.
- Monitor runtime advances to v12 and status runtime to v15 so the repair hot-activates on already-open chats.
- Status policy is unchanged: only the four recoverable `INCOMPLETE_*` codes auto-continue; terminal stop codes remain terminal.
