# Hidden/background observation acceptance — 2026-09-17

Roadmap position: **ChatGPT Response Notifier → Workstream 1/5 — Foundation and Conversation Identity → Stage 1/1 — Trustworthy observation across page states → Step 2/2 — Accept hidden/background behavior → Gate 1/1**.

Owner/checkpoint: DevelopmentInfrastructure #478.

## What is already proven

| Scenario | Evidence | Acceptance state |
| --- | --- | --- |
| Foreground / ordinary visible page | Current canonical source passes the complete extension behavior suite, durable notification pipeline tests, installed-Chrome fresh-load, and runtime-evidence validation. | Deterministic source proof complete. |
| Inactive/hidden tab | `tests/extension/hidden-tab-completion.behavior.test.mjs` proves hidden completion bypasses both the 150 ms page throttle and `requestAnimationFrame`, including a visible→hidden transition. The response-stream observer remains the notification path when rendered DOM is delayed. | Deterministic source proof complete. |
| Unfocused / occluded / another Windows virtual desktop | Historical #439 supplied an earlier pass. Fresh 2026-09-17 evidence then reproduced a current failure, traced it to the page-owned coded-status fallback after successful request/stream completion, and repaired it in PR #95 with worker-owned bounded post-request DOM inspection. After protected deployment and verified worker Reload, a new physical test produced the native notification while Chrome remained on another Windows virtual desktop. | **Physical acceptance passed on the current loaded candidate.** |
| Frozen / discarded | Current lifecycle/worker tests identify frozen/discarded pages explicitly and the completed Workstream 4 scheduler defers them as page-unobservable rather than declaring generation failure or authorizing timer-only recovery. | Safety/defer acceptance complete. A frozen renderer is not required to manufacture a terminal notification while frozen. |
| Minimized Chrome window | Fresh 2026-09-17 physical acceptance on the current live runtime: notification arrived while Chrome remained minimized. | **Physical acceptance passed.** |

## Accepted live candidate

The accepted loaded Glass candidate is `68ee2533a8a26568a8cfbf0cc4099edc70879b9f` (v0.9.29). It combines canonical main through PR #95 with the accepted PR #80 `Extension-v2` persistence lineage. Exact candidate validation run `35294236369` passed source/build/isolated Setup, runtime evidence and Store-package validation. Protected Glass deploy PR #167 / run `35294426595` installed that exact source, and read-only PR #168 verified installed-source/helper/listener/runtime health without mutation.

Because this was a same-version replacement, Chrome initially kept the old worker. Pre/post-deploy read-only evidence retained runtime suffix `369d2099`; after operator Reload, the suffix changed to `f9539c6f` while exact installed source stayed `68ee2533...`. The final physical acceptance therefore exercised the repaired worker, not stale JavaScript.

## Failure, repair and final acceptance

Fresh physical testing first established a state-specific failure:

- another app focused on the same Windows desktop: notification worked;
- Chrome minimized: notification worked;
- Chrome/ChatGPT on another Windows virtual desktop: notification initially failed.

Retained live evidence showed that the failed request completed HTTP 200 while the page was hidden/unfocused, diagnostic page queries still replied, and the matching response stream reached EOF/DONE but contained no status-code candidate. That ruled out Windows toast presentation and a generally frozen page. The first missing boundary was the fallback coded-status observation after a known successful request: it remained page-owned and did not emit completion on the non-current virtual desktop.

PR #95 repaired that boundary by reusing the existing persistent worker scheduler. A successful answer-request completion now triggers bounded local DOM inspections tied to exact request/conversation/prompt/assistant identity; a proven status is routed through the existing coordinator and notification/Continue policy without creating ChatGPT traffic.

After protected deployment of exact candidate `68ee2533...` and independent proof that Chrome loaded a new worker, the repeated other-Windows-virtual-desktop test **passed**: the native notification arrived without returning to the Chrome desktop.

Workstream 1/5 is complete. The same test exposed a separate Workstream 2 click-UX result: clicking the notification opened the designed current-desktop fallback Chrome window rather than surfacing the existing tab. That result belongs to DevelopmentInfrastructure #442 and does not reopen background observation acceptance.
