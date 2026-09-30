# ChatGPT Response Notifier 0.9.100

- Stops ordinary composer text mutations before they reach the notifier's downstream MutationObservers, eliminating per-keystroke callback churn in the monitor, terminal-status reader, watchdog authority and Quick Continue bridge.
- Preserves draft safety with one lightweight signal only when the composer crosses empty/non-empty state, rather than republishing monitor state for every character typed.
- Hot updates and programmatic reinjections now preserve the strict `page-dom-compat → composer typing guard → live readers` order, including already-open ChatGPT tabs.
- Adds a Chromium regression that types forty successive composer values with no additional downstream observer callbacks after the initial draft transition, then proves draft-empty and real assistant mutations are still observed.

## Previous: 0.9.99

- Prevents draft typing from waking the rendered terminal-code observer, watchdog terminal scan and Quick Continue terminal bridge. Draft/upload/send controls remain observed by their existing monitor and dispatch owners.
- Draft-only monitor publications reuse the submitted conversation state instead of recloning replies. They still read draft/upload/request controls; assistant changes, structural mutations and explicit safety queries read fresh conversation state.
- Quick Continue 1.2.30 centers Simple between Continue and Project, displays its independent countdown immediately, removes redundant on/off messages, and starts on fresh chats before they receive a conversation ID.
- Hot updates retire surviving runtime closures through a shared DOM lifecycle signal, guard queued/async work after disposal, and remove stale toolbar copies before mounting the new singleton.
- Scrolling repositions the toolbar without rereading the draft or rewriting availability. The JSON editor measures visible timer rows so its frame clears them.

## Earlier 0.9.98 changes

- Stops the notifier's own once-per-second countdown/status DOM updates from waking its expensive conversation and terminal-status MutationObservers. On long chats, those self-induced scans could repeatedly traverse and clone the conversation even while ChatGPT itself was idle, causing typing and scrolling lag.
- Installs one isolated-world MutationObserver filter before live readers. Mutations wholly inside the Quick Continue/notifier toolbar are dropped, while real ChatGPT page mutations and the notifier's `data-watchdog-settings` control signal still pass through.
- Applies the same filter during hot-tab runtime replacement, after stale observers are disposed and before new monitor/status/watchdog observers are created, so already-open ChatGPT tabs do not retain the unfiltered generation after an update.
- Adds deterministic ordering checks and a Chromium regression that produces repeated toolbar churn with zero observer callbacks, then mutates a real assistant turn and proves the observer still fires.

## Previous: 0.9.97

- Stops ordinary trusted clicks and keystrokes on ChatGPT from dismissing every native completion notification for the current conversation. Live Glass helper evidence from 0.9.96 showed `toast-dismiss-conversation-applied` firing repeatedly during normal interaction, which could erase a correctly presented toast before it was seen.
- Removes the rendered-terminal detector's arbitrary four-ancestor limit. A visible final GitHub status can now be found through arbitrarily deep presentation wrappers while still stopping at the first ancestor containing a different user or assistant turn.
- Adds bounded, content-free live terminal proof diagnostics that record whether a real rendered/stream terminal message reached the worker and whether the persisted watchdog actually became stopped. Prompt text, response text, titles, and conversation URLs are not recorded.
- Adds deterministic and Chromium regressions for deep same-turn footer nesting and for preventing generic page interaction from dismissing native notifications. Installed normal-profile behavior on Glass remains the acceptance authority for this regression.

## Previous: 0.9.96

- Moves both managed update manifests from the branch-based raw-content CDN to GitHub's repository-contents API using the raw media type, so the long-lived Windows helper reads the canonical current branch state rather than a stale raw edge.
- Performs each manifest read through a fresh one-request connection with cache-busting, no-cache/no-store, `Connection: close`, and an explicit GitHub API version. A helper process can no longer stay pinned to an old feed view across releases.
- Fixes the deployment failure exposed by Quick Continue 1.2.27, where the Glass helper repeatedly reported `availableVersion=1.2.24` even while an independent request from the same machine saw the published 1.2.27 feed.
- Applies the same authoritative manifest transport to the notifier's own updater so both managed release paths share the hardened behavior.

## Previous: 0.9.95

- Fixes the live `COMPLETE_APPLIED` miss reproduced on Glass with notifier 0.9.94: the current ChatGPT DOM can render the final status footer as a sibling of the semantic assistant marker, while the rendered-terminal detector was scanning only inside that marker.
- Expands terminal detection only through ancestors that still belong to the same assistant turn, so a visible sibling footer is recognized without allowing a neighboring user or assistant turn to supply the status.
- Preserves exact status grammar, code/quote/list/tool exclusions, conflicting-code rejection, and the existing identity-bound watchdog parking and notification authority.
- Adds a regression for the current semantic-wrapper shape with a sibling `COMPLETE_APPLIED` footer, trailing action chrome, and a neighboring user turn.

## Previous: 0.9.94

- Fixes the watchdog getting stuck at zero with `cadence-page-identity-missing` when ChatGPT temporarily stops exposing the current turn identity even though the conversation URL and composer are still usable.
- Falls back to the durable watchdog record's prompt identity only when the sender is still attached to the same conversation and that watchdog remains active; a conflicting live page prompt still fails closed before any send.
- Carries the recovered prompt identity through reservation, pre-send validation, and finalization so a successful auto-continue consumes exactly one attempt and immediately establishes the next 30-minute cadence window.

## Previous: 0.9.93

- Fixes a terminal-status acknowledgement race where successful notification delivery could mark a rendered footer handled even when watchdog parking failed, leaving the visible 30-minute timer running after `COMPLETE_APPLIED`, `COMPLETE_NO_CHANGES`, `BLOCKED_HUMAN`, or `PLANNING_ACTIVE`.
- Requires explicit persisted `stopped:true` proof before the page observer retires terminal-footer retries. Notification delivery remains independent and can no longer masquerade as watchdog-stop success.
- Adds a tightly bounded same-request prompt-key recovery for transient DOM/watchdog identity skew: the request must already be completed, the rendered assistant identity and revision must still match exactly, and the persisted watchdog must carry the exact same request-start timestamp.

## Previous: 0.9.92

- Makes managed notifier updates converge the actual running helper process as well as the files on disk. Update checks are now serialized, and any stale helper generation self-heals to the versioned host executable that matches the installed extension state.
- Adds `runningHostVersion` to the localhost helper handshake, derived from the helper process executable generation rather than mutable extension files.
- Strengthens release acceptance so a release cannot pass merely because the new extension manifest is present on disk; both the installed extension and the helper process serving the bridge must report the expected version.
- Unblocks the already-published Quick Continue 1.2.24 deployment after the 0.9.91 release exposed that the previous acceptance could mistake updated disk state for updated helper code.

## Previous: 0.9.91

- Removes MV3 service-worker cold-start page mutations from both extensions. Quick Continue no longer reinjects `runtime-reset.js` merely because its background worker wakes, so the canonical toolbar is not disposed and rebuilt during normal browsing.
- Retires the notifier-owned legacy Quick Prompts injector. Notifier worker restarts and completed navigations can no longer create a competing toolbar that briefly appears before the standalone Quick Continue surface suppresses it.
- Pairs with Quick Continue 1.2.24 and adds regression coverage requiring routine worker wakes to remain page-DOM side-effect free while reserving destructive runtime replacement for actual extension install/update events.

## Previous: 0.9.90

- Restores watchdog restart after a definitive terminal status. A real extension-observed ChatGPT conversation POST now establishes a new operator-prompt boundary before watchdog reconciliation, so the previous response's `COMPLETE_*`, `BLOCKED_HUMAN`, or `PLANNING_ACTIVE` stop cannot remain permanently sticky across a new user interaction.
- Keeps stale same-turn DOM writes unable to reopen a stopped watchdog; only a genuinely newer request boundary releases the prior terminal stop.
- Pairs with Quick Continue 1.2.23, which submits through the live composer form path used by Enter instead of relying on a synthetic Send-button click that current ChatGPT can ignore.

## Previous: 0.9.89

- Makes the watchdog send interval crash-safe and duplicate-safe by reserving each automatic Continue durably before the page click, so concurrent wakeups, lost response ports, and unconfirmed sends cannot replay within the same 30-minute interval.
- Binds each reservation to the exact conversation, prompt, tab, and document, consumes the retry budget before dispatch, and treats uncertain click outcomes as consumed attempts with a conservative full 30-minute floor.
- Migrates prior watchdog cadence state without granting immediate send authority, preserves definitive stop states, and fixes terminal-stop ordering so stopped watchdogs cannot inherit an old send count or timer.
- Adds runnable acceptance regressions for stale alarms, concurrent wakes, unconfirmed clicks, and response-port loss; all assert that at most one Continue can be sent per interval.

## Previous: 0.9.88

- Enforces one automatic Continue authority: only the 30-minute watchdog may send an automatic continuation. Legacy coded-completion and status-observer routes now hand recoverable statuses back to the watchdog instead of immediately sending another response.
- Removes the watchdog persistence invariant's hidden 60-second `incomplete-awaiting-continuation` fallback alarm. The invariant may preserve state but can no longer invent a retry cadence or schedule alarms.
- Migrates persisted 0.9.87 short-cadence watchdog records on worker startup, clearing the poisoned one-minute retry marker and restoring the correct 30-minute deadline when a prior automatic send timestamp is available.
- Adds regression coverage that fails if the invariant creates an alarm again or if the legacy `CHATGPT_CONTINUE_COMMAND` path can send for an automatic work-status code.

## Previous: 0.9.87

- Removes direct Continue authority from bounded stale/error recovery. Only the 30-minute watchdog may send automatic Continue messages, preventing recovery incidents from creating 30–60 second Continue cascades.
- Changes stale-chat recovery to one cache-bypassing hard refresh (`bypassCache: true`, equivalent to a Ctrl+F5-style reload), then observes whether work resumes. If it remains stale, recovery yields to the existing watchdog instead of sending or scheduling another recovery Continue.
- Keeps the watchdog timer authoritative across stale recovery: a successful automatic Continue remains followed by the normal 30-minute watchdog window rather than a recovery-owned short cadence.
- After the watchdog retry budget is exhausted and a hard refresh still leaves the automatic generation stale, the watchdog is parked and a Needs attention notification is raised instead of continuing indefinitely.
- Adds regression coverage proving stale recovery has no message-send command, performs only the hard-refresh path, and cannot admit a recovery Continue action.

## Previous: 0.9.86

- Adds a live rendered-footer authority that detects the final GitHub status from connected ChatGPT DOM instead of depending on detached-clone line breaks. This covers segmented/sibling footer markup that was visibly present but still reported as `terminal-code-not-observed`.
- Routes a confirmed definitive rendered status directly to both watchdog parking and the durable notification outbox, so `PLANNING_ACTIVE`, `COMPLETE_APPLIED`, `COMPLETE_NO_CHANGES`, and `BLOCKED_HUMAN` no longer depend on a second fragile DOM query before stopping or notifying.
- Keeps terminal delivery identity-bound to the current conversation, prompt, assistant turn, and revision, with coordinator claim/dedupe before a toast is queued.
- Makes the response-stream bridge replaceable across extension updates; an already-open tab can no longer retain a dead pre-update bridge guard that silently blocks the stream fallback.
- Hot-binds and verifies the rendered terminal observer in already-open ChatGPT tabs without refreshing or foregrounding them.

## Previous: 0.9.85

- Replaces the watchdog countdown with a durable single-owner DOM surface that can take over an already-open ChatGPT tab even when the pre-update timer runtime is still executing with a dead extension context.
- Moves the live timer into a new DOM namespace that the stale 0.9.84-and-earlier timer code cannot delete or repaint, while statically hiding those legacy timer rows so they cannot flicker back into view.
- Adds a document-level timer ownership lease. Future timer runtimes detect when a newer owner has claimed the page and relinquish their intervals, listeners, and row instead of competing for the toolbar.
- Requires timer runtime v8 from both Quick Continue and watchdog authority bootstrap paths, so already-open tabs cannot be treated as healthy while a stale v7 timer surface is still present.
- Preserves the existing backend behavior where Pause clears the active watchdog and Stop cancels only the current timer while Monitor stays enabled.

## Previous: 0.9.84

- Rebinds the complete critical isolated-world runtime set in already-open ChatGPT tabs after an extension update, so a page refresh is no longer required for new monitor/status/control code to take ownership.
- Runs the page DOM compatibility adapter before every hot-injected turn reader, including Quick Continue and watchdog page authority, so current semantic `data-turn` nodes remain visible during no-refresh updates.
- Disposes stale timer, monitor, status, Quick Continue, and watchdog owners once per extension version and clears legacy listener guards before binding the new version.
- Restores live Stop, Monitor/Pause, trusted-manual-send rearming, terminal-code parking, and completion notification observation after an extension update without foregrounding or reloading the ChatGPT tab.

## Previous: 0.9.83

- Restores assistant/user turn text extraction on ChatGPT's current semantic `data-turn` DOM while retaining legacy `data-message-author-role` compatibility.
- Restores definitive GitHub status detection so `PLANNING_ACTIVE`, `COMPLETE_APPLIED`, `COMPLETE_NO_CHANGES`, and `BLOCKED_HUMAN` can park the watchdog instead of allowing unwanted auto-continues.
- Restores the rendered-status input used by completion notification delivery on current ChatGPT turns.
- Uses semantic message/turn IDs when available so prompt identity remains stable across current ChatGPT DOM shapes and rerenders.

## Previous: 0.9.82

- Unifies the timer surface so the notifier owns one full-width, black, right-aligned and wrapping countdown with a separate Stop control. Stop cancels the current timer while Monitor stays enabled.
- Keeps a definitive `PLANNING_ACTIVE`, `COMPLETE_APPLIED`, `COMPLETE_NO_CHANGES`, or `BLOCKED_HUMAN` stop parked through late same-turn request and action events.
- Routes a stream read failure through an exact request-and-turn-bound rendered-status observation. The test-toast button now waits for the Windows helper to confirm actual presentation.
- Updates Quick Continue 1.2.19 to preserve exact line breaks through editor insertion, avoid hidden composer selection, and ignore countdown-only toolbar mutations.

## Previous: 0.9.81

- Fixes the live `COMPLETE_APPLIED` miss reproduced on Glass when a long-running ChatGPT response crosses an extension update boundary.
- Preserves an already-observed terminal footer when Chrome throws while finishing a cloned SSE response; a late stream read error can no longer erase the status token before the worker parks the watchdog.
- Reinstalls the current status parser and terminal page authority into already-open ChatGPT tabs after an extension update, then forces bounded rechecks so a response already in progress is still evaluated by the new runtime.
- Repeats that bounded terminal refresh after a `stream-read-error`, covering the exact failure path observed in live runtime evidence without adding ChatGPT polling or extra requests.
- Keeps the 0.9.80 watchdog rules: definitive COMPLETE/BLOCKED/PLANNING statuses stop the timer, and a later trusted manual / Continue / Project send explicitly starts a new 30-minute timer.
