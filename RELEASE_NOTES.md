# ChatGPT Response Notifier 0.9.50

- Fixes the timer/reset control hover affordance that was not visibly distinguishable in the live ChatGPT theme.
- Replaces the theme-dependent outer box-shadow with a real 1px border reserved at rest as transparent and changed to the control's current text color on hover.
- The reserved border prevents geometry shift; there is no animation.
- Preserves the v0.9.49 opaque clickable timer, three-send allowance reset behavior, terminal-stop preservation, and no-F5 hot activation.
- Attachment runtime v10 hot-activates the corrected hover treatment in already-open ChatGPT tabs.

