# Hidden/background observation acceptance — 2026-09-17

Roadmap position: **ChatGPT Response Notifier → Workstream 1/5 — Foundation and Conversation Identity → Stage 1/1 — Trustworthy observation across page states → Step 2/2 — Accept hidden/background behavior → Gate 1/1**.

Owner/checkpoint: DevelopmentInfrastructure #478.

## What is already proven

| Scenario | Evidence | Acceptance state |
| --- | --- | --- |
| Foreground / ordinary visible page | Current canonical source passes the complete extension behavior suite, durable notification pipeline tests, installed-Chrome fresh-load, and runtime-evidence validation. | Deterministic source proof complete. |
| Inactive/hidden tab | `tests/extension/hidden-tab-completion.behavior.test.mjs` proves hidden completion bypasses both the 150 ms page throttle and `requestAnimationFrame`, including a visible→hidden transition. The response-stream observer remains the notification path when rendered DOM is delayed. | Deterministic source proof complete. |
| Unfocused / occluded / another Windows virtual desktop | DevelopmentInfrastructure #439 live v0.9.27 acceptance recorded `visibility=hidden`, `pageHasFocus=false`, and `windowFocused=false` while the request/stream continued; the native notification arrived before Chrome regained focus. | Physical acceptance complete for that event. Do not repeat it merely for this gate. |
| Frozen / discarded | Current lifecycle/worker tests identify frozen/discarded pages explicitly and the completed Workstream 4 scheduler defers them as page-unobservable rather than declaring generation failure or authorizing timer-only recovery. | Safety/defer acceptance complete. A frozen renderer is not required to manufacture a terminal notification while frozen. |
| Minimized Chrome window | No retained independent physical acceptance was found in #439 or current canonical evidence. | **Only remaining Step 2 boundary.** |

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

## One remaining operator test

When convenient:

1. Use a normal notifier-eligible build chat response.
2. Immediately minimize the Chrome window and leave it minimized until the response finishes.
3. Do not restore Chrome, reload the tab, click Continue, or manually recover during the observation.
4. Record only whether the native notification arrived **before** Chrome was restored.

If it arrives while Chrome remains minimized, Step 2/2 is accepted and Workstream 1/5 can close. If it does not, preserve the observation as a live-runtime failure but do not infer a current-source root cause from it; reconcile/install current source only through the existing installation/release gate before repair selection.

No other hidden/background reproduction is required by this checkpoint.
