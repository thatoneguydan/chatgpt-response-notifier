# ChatGPT Response Notifier 0.9.58

- Fixes monitored chats continuing after a valid terminal footer such as `COMPLETE_APPLIED` or `COMPLETE_NO_CHANGES` was visibly present.
- The page-side terminal parser now treats duplicate rendered copies of the same footer as one semantic footer instead of rejecting the response as ambiguous.
- Conflicting terminal codes in one response still fail closed; quoted/non-terminal status text still does not count as a footer.
- DOM fallback ignores hidden/control-only branches before evaluating the terminal block, reducing false negatives from duplicate ChatGPT render trees.
- Status runtime advances to v14 so already-open monitored chats receive the parser repair through the existing hot-activation path.
- The status policy is unchanged: only the four `INCOMPLETE_*` continuation codes auto-continue; `COMPLETE_*`, `BLOCKED_HUMAN`, and `PLANNING_ACTIVE` stop.
