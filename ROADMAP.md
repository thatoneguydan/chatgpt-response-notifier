# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. Source authority: this repository. Historical incident authority: DevelopmentInfrastructure #283. Status-contract v2 authority: #432. Explicit-interruption regression authority: #434. Timestamp/quick-prompt rollout authority: #435. Quick-prompt layout / persistent timeout-recovery authority: #436. Post-refresh continuation regression authority: #437. Hidden-tab rAF hardening authority: #438. Hidden-tab end-to-end stall follow-up authority: #439.

## Current checkpoint — 2026-09-15, v0.9.25 live; #439 active

Notifier **v0.9.25** is the installed/live baseline on `GLASS\dan`.

DevelopmentInfrastructure **#438** removed the hidden-tab `requestAnimationFrame()` dependency. v0.9.24 then removed the remaining hidden-tab 150 ms completion-timer dependency and added lifecycle diagnostics. Its required virtual-desktop live test still stalled until the Chrome window became visible.

v0.9.25 moved the wake into the extension background worker: successful conversation-request completion directly probed the exact Chrome document through the status observer. Exact validation, publication, protected Glass deployment, and post-install runtime evidence all passed. The required live acceptance test still failed.

Fresh v0.9.25 evidence isolated the remaining boundary. At `2026-09-15T19:52:13.047Z` the background worker received request completion; at `19:52:13.048Z` Chrome reported `frozen=false;discarded=false;active=true`; the exact-document status probe then ran for its full 30-second budget and ended at `19:52:43.324Z` with `terminal-code-not-observed`. The coded terminal DOM status did not appear until `19:55:26.545Z`, when the Chrome window was made visible again. Therefore Chrome is continuing to run the extension while the virtual-desktop window is occluded, but ChatGPT defers the final rendered assistant DOM in that state.

DevelopmentInfrastructure **#439** remains active. Candidate **v0.9.26** moves coded-notification evidence ahead of the deferred paint boundary without adding new ChatGPT traffic: a `document_start` MAIN-world observer tees only the page's already-running conversation response stream, keeps only a short rolling tail while scanning for the existing terminal status grammar, and forwards only a validated status code through an isolated-world bridge. Exact tab/document/request context and the existing build enrollment gate the notification. The durable notification/outbox path is unchanged. Automatic Continue remains DOM-verified and is not authorized from stream evidence. When ChatGPT eventually paints the same prompt, the later DOM notification is suppressed as a duplicate.

## #439 active hardening contract

- A coded completion notification must not depend on ChatGPT painting the final assistant DOM when the Chrome window is occluded on another Windows virtual desktop.
- The stream observer may inspect only the conversation response that ChatGPT itself already initiated; it must not issue a second ChatGPT request, poll session/API endpoints, replay prompts, attach a debugger, or foreground Chrome.
- The MAIN-world observer may retain only a bounded rolling tail needed to detect a split terminal token. Raw prompt/assistant response content must not cross the isolated-world bridge, enter durable extension storage, or appear in diagnostics.
- A stream-derived notification requires a recognized status code, exact Chrome tab/document/request context, the current conversation identity, and an enabled/non-paused build enrollment.
- Stream evidence is notification-only. Automatic Continue remains authorized only after the existing DOM terminal identity checks and user/safety vetoes pass.
- The ordinary DOM delivery path remains as fallback. If stream evidence already queued the same prompt's notification, the later DOM notification is suppressed rather than presented twice.
- Existing open ChatGPT tabs must receive the new MAIN observer and isolated bridge at extension startup/update without requiring a page refresh.
- Preserve durable helper acknowledgment, notification history, recovery finalization, manual-stop behavior, bounded continuation, rollback, stable extension identity/root, and no-focus-stealing behavior.
- Add deterministic regression coverage proving the existing fetch is invoked exactly once, split status tokens are detected, unrelated requests are ignored, invalid codes are rejected by the isolated bridge, raw response content does not cross the bridge, and the stream path contains no continuation command.
- Promotion requires exact-head validation, release, protected Glass deployment, and read-only post-install evidence gates.
- Keep #439 open through a real Windows-virtual-desktop live test after v0.9.26 is loaded.

## Accepted behavior retained from #437/#438/#439

- Verified timeout/system recovery and silent-stop recovery use separate final eligibility rules.
- An interrupted response remains attributable across a reload when the same response is still present.
- Automatic recovery Continue and coded-status Continue are timestamped at send time using the local quick-prompt format.
- Automatic continuation remains bounded and guarded by exact request identity and the existing user/safety vetoes.
- Hidden generic completion checks no longer wait on `requestAnimationFrame()` or the 150 ms page timer after entering their hidden-tab path.
- Lifecycle diagnostics record sanitized request-completion and frozen/discarded state without prompt or assistant content.
- The v0.9.25 exact-document completion probe remains as a DOM fallback/diagnostic path.
- Existing stable extension identity/root, updater, rollback, notification delivery, localhost bridge, prompt binding, duplicate suppression, and manual-stop behavior are retained.

## Accepted proof

- **v0.9.22 exact-head validation:** run `35001614683`; candidate artifact `10409554404`; digest `sha256:554d39626bdaa7498543dcc1b1bd252670afbf8e62feb0d15fa200904f17f4de`.
- **v0.9.23 exact-head validation:** run `35005655994`; candidate artifact `10411761761`; digest `sha256:723079f6bea3ad84db24a6c936550e94e0d706dc5d436c63b9ef4d40d171da89`.
- **v0.9.24 exact-head validation:** run `35009988034`; candidate artifact `10413207070`; digest `sha256:ae1b36c6ef37aa45d0fb1a0685377cbc930d9ac2000a6f87cded7d5a59cea4cc`; candidate source `027b316dd788217b8359d63209159c2c3e5a7066`.
- **v0.9.24 publication:** notifier PR #53 merged as `ed171c856eac03d132d77908096023b010fa9e80`; release `v0.9.24` published; managed update manifest advanced on `main`.
- **v0.9.24 protected deployment:** Glass PR #140 / run `35011382942`; installed source `027b316dd788217b8359d63209159c2c3e5a7066`; installed version 0.9.24; helper listener owned; rollback available; extension identity retained.
- **v0.9.24 post-install evidence:** runtime-evidence run `35009987984` attempt 2 / job `104525713574`; evidence reported installed/current/historical extension 0.9.24 and live runtime identity.
- **Failed v0.9.24 virtual-desktop acceptance evidence:** runtime-evidence run `35009987984` attempt 3 / artifact `10414237424`; digest `sha256:f0390b7d698c6ecd99fd4b5d1fb9d70586c8ac15f1d566ecf7f6fcc4a0e9c1a8`. Request completion and lifecycle evidence occurred at `19:17:05Z` with `frozen=false;discarded=false`; coded observation/claim/queue began only at `19:19:42Z` when the Chrome window returned to view.
- **v0.9.25 exact-head validation:** run `35014435547`; candidate artifact `10415485185`; digest `sha256:053e4f665f405e25c4522f23995b804618969cab83f1244be3845cb4f9d19120`; candidate source `f11abf536993f13149e6af5ac498accea2311be4`.
- **v0.9.25 publication:** notifier PR #54 merged as `67afa1c7afc2b0fbe4bd7d4716b259f4742c11da`; release `v0.9.25` published; managed update manifest advanced on `main`.
- **v0.9.25 protected deployment:** Glass PR #141 / run `35014861130`; installed source `f11abf536993f13149e6af5ac498accea2311be4`; installed version 0.9.25; helper listener owned; rollback available; extension identity retained.
- **v0.9.25 post-install evidence:** runtime-evidence run `35014435664` attempt 2 / job `104537361267`; safe evidence reported installed/current/historical extension 0.9.25 and live runtime identity.
- **Failed v0.9.25 virtual-desktop acceptance evidence:** runtime-evidence run `35014435664`, fresh job `104541311424`, artifact `10416016114`, digest `sha256:767003ab7e5e7443c4a345c03f83d1d9781d4608d4b1d217c7508d3c47cf2a01`. Request completion occurred at `19:52:13.047Z`; exact-document DOM probe ended `terminal-code-not-observed` at `19:52:43.324Z`; rendered coded status arrived only at `19:55:26.545Z` after the window became visible.

## Program structure

| Workstream | Scope | Current state |
| --- | --- | --- |
| Workstream 1/5 — Foundation and Conversation Identity | Completion sensor, stable chat routing, loopback helper protocol. | Active #439 passive response-stream notification path; v0.9.25 live, v0.9.26 candidate. |
| Workstream 2/5 — Native Toast UX | Persistent notifications, timestamps, quick prompts, click/dismiss routing. | Complete through v0.9.25; v0.9.26 changes only the notification evidence source for occluded coded completions. |
| Workstream 3/5 — Installation, Release, and Acceptance | Installer, stable root, updater, rollback, release publication. | Complete through v0.9.25; candidate v0.9.26 must pass existing gates. |
| Workstream 4/5 — Reliable Background Automation | Durable ownership, guarded continuation, recovery, delivery/outbox. | Durable outbox retained; stream evidence may notify early but cannot authorize Continue. |
| Workstream 5/5 — Status Contract and Bounded Recovery | Contract retention, current-run recognition, bounded recovery, proof/rollout. | Existing DOM identity and continuation safety remain authoritative; #439 is notification-timing only. |

## Retained recovery defaults

- missing-footer grace: 30 seconds;
- silent-stop evidence: at least 90 seconds idle plus two consistent inspections at least 30 seconds apart;
- ambiguous-thinking diagnostic: 15 minutes without forced retry;
- silent-stop reload cap: 3;
- explicit-interruption reload cap: 5;
- explicit-interruption retry spacing after a surviving reload: 5 minutes;
- recovery continuation cap: 1 per incident;
- format-repair prompts: 0;
- profile-wide action spacing: at least 30 seconds;
- generation-producing action ceiling: 12 per trusted human-started run;
- reset only by a genuinely new trusted human request or explicit Resume.

## Continuing work

Validate, publish, and protected-deploy candidate v0.9.26 from the accepted v0.9.25 baseline. Keep #439 open until a real coded completion notification arrives while the Chrome window remains on another Windows virtual desktop. If v0.9.26 still fails, use the new sanitized response-stream diagnostics to determine whether ChatGPT's transport bypassed the wrapped fetch/XHR path or whether request/context correlation rejected the observed terminal token before changing architecture again.
