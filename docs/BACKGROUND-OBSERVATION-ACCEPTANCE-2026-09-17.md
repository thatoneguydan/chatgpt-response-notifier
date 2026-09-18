# Hidden/background observation acceptance — 2026-09-17

Roadmap position: **ChatGPT Response Notifier → Workstream 1/5 — Foundation and Conversation Identity → Stage 1/1 — Trustworthy observation across page states → Step 2/2 — Accept hidden/background behavior → Gate 1/1**.

Owner/checkpoint: DevelopmentInfrastructure #478.

## What is already proven

| Scenario | Evidence | Acceptance state |
| --- | --- | --- |
| Foreground / ordinary visible page | Current canonical source passes the complete extension behavior suite, durable notification pipeline tests, installed-Chrome fresh-load, and runtime-evidence validation. | Deterministic source proof complete. |
| Inactive/hidden tab | `tests/extension/hidden-tab-completion.behavior.test.mjs` proves hidden completion bypasses both the 150 ms page throttle and `requestAnimationFrame`, including a visible→hidden transition. The response-stream observer remains the notification path when rendered DOM is delayed. | Deterministic source proof complete. |
| Unfocused / occluded / another Windows virtual desktop | Historical DevelopmentInfrastructure #439 live v0.9.27 acceptance recorded `visibility=hidden`, `pageHasFocus=false`, and `windowFocused=false` with notification before Chrome regained focus. Fresh 2026-09-17 acceptance on the current live runtime contradicts treating that as current proof: another app focused on the same desktop works, but moving Chrome/ChatGPT to another Windows virtual desktop does not produce the expected notification. | **Current cross-desktop acceptance failed. #439 is historical-only evidence.** |
| Frozen / discarded | Current lifecycle/worker tests identify frozen/discarded pages explicitly and the completed Workstream 4 scheduler defers them as page-unobservable rather than declaring generation failure or authorizing timer-only recovery. | Safety/defer acceptance complete. A frozen renderer is not required to manufacture a terminal notification while frozen. |
| Minimized Chrome window | Fresh 2026-09-17 physical acceptance on the current live runtime: notification arrived while Chrome remained minimized. | **Physical acceptance passed.** |

## Current-live equivalence for the minimized test

The accepted live Glass source remains `0b4d045c92accc62c7914b2c0bcf2b0a33a71741` (v0.9.29), while current canonical source is `984e93c52b177a275d72bc3c033d84b40de3b68a`.

The files that own the passive coded-completion → durable-notification path are byte-identical between those commits:

- `extension/content-script.js`
- `extension/response-stream-status-main.js`
- `extension/response-stream-status-bridge.js`
- `extension/response-stream-status-background.js`
- `extension/coordinator-background.js`
- `extension/delivery-reliability-background.js`
- `extension/history-background.js`
- `extension/service-worker.js`
- `extension/hidden-window-diagnostics-main.js`
- `extension/hidden-window-diagnostics-page.js`

The manifest keeps the same permissions, host permissions, service worker and response-stream/hidden-diagnostics entries; canonical source only adds the separate `observation-relay.js` content-script entry. Later monitor/recovery/diagnostic source differs, so a **successful** minimized notification on the accepted live runtime is valid positive evidence for the unchanged notification path. A failure on the older installed source must not be used to diagnose or modify current canonical source without first reconciling that source difference.

## Fresh current-runtime result and diagnostic boundary

Physical acceptance on 2026-09-17 establishes a state-specific failure rather than a generic unfocused/minimized failure:

- another app focused on the same Windows desktop: notification works;
- Chrome minimized: notification works;
- Chrome/ChatGPT on another Windows virtual desktop: notification does not appear.

This means Workstream 1/5 remains open specifically on the cross-virtual-desktop path. Do not repeat the minimized or same-desktop unfocused tests. Do not assume the failure is Windows toast presentation: first inspect retained runtime evidence for the failed response and locate the first missing boundary among request/page observation, classification, durable notification queue/helper acknowledgement, and native presentation.

Because later canonical monitor/recovery/diagnostic source differs from the accepted live runtime, a failure on the installed source is evidence of a live defect but is not by itself sufficient to select a current-source code repair. Diagnose the missing boundary first.
