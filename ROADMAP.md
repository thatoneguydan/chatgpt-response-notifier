# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. Source authority: this repository. Historical incident authority: DevelopmentInfrastructure #283. Status-contract v2 authority: #432. Explicit-interruption regression authority: #434. Timestamp/quick-prompt rollout authority: #435. Quick-prompt layout / persistent timeout-recovery authority: #436. Post-refresh continuation regression authority: #437. Hidden-tab rAF hardening authority: #438. Hidden-tab end-to-end stall follow-up authority: #439.

## Current checkpoint — 2026-09-15, v0.9.24 live; #439 active

Notifier **v0.9.24** is the installed/live baseline on `GLASS\dan`.

DevelopmentInfrastructure **#438** removed the hidden-tab `requestAnimationFrame()` dependency. Candidate v0.9.24 then removed the remaining hidden-tab 150 ms completion-timer dependency and added lifecycle diagnostics. Exact validation, publication, protected Glass deployment, and post-install runtime evidence all passed.

The required live acceptance test still failed when the Chrome window was left on another Windows virtual desktop. Sanitized runtime evidence made the failure boundary concrete: the ChatGPT conversation request completed at `2026-09-15T19:17:05Z` while Chrome reported `frozen=false;discarded=false`, but the coded terminal turn was not observed/claimed until `2026-09-15T19:19:42Z` when the window became visible again. The delivered turn used the durable `coded-completion-status-observer` path. Therefore this is not a Chrome frozen/discarded-page problem and not primarily the generic completion detector.

DevelopmentInfrastructure **#439** remains active. Candidate **v0.9.25** moves the coded completion wake across the page-timer boundary: after Chrome reports a successful conversation request completion, the extension background worker directly probes the exact Chrome document through the existing status observer. That observer waits on DOM MutationObserver evidence and exact terminal identity, then hands the result into the existing durable delivery / bounded-continuation pipeline. The existing page-side monitor publication path remains as fallback and dedupe.

## #439 active hardening contract

- A completed coded ChatGPT response must not depend on page `setTimeout()` or `requestAnimationFrame()` scheduling before entering the durable delivery pipeline.
- Successful conversation-request completion may wake the existing read-only status observer, but must use the exact Chrome `documentId` from the observed request.
- The direct completion probe must preserve exact conversation, document, prompt, assistant, revision, and status-code identity before claiming or acting on a turn.
- Missing Chrome document identity, unavailable runtime, incomplete terminal identity, frozen/discarded pages, closed tabs, and superseded conversations must fail safe to the existing observer/recovery paths.
- The existing page-side monitor remains a fallback; coordinator/observation identity continues to dedupe the same logical coded turn.
- Preserve latest-prompt binding, duplicate suppression, manual-stop suppression, durable helper acknowledgment, continuation/recovery guards, and no-foregrounding behavior.
- Do not add ChatGPT API/session polling, debugger attachment, prompt replay, Regenerate, refresh loops, or automatic focus stealing.
- Add deterministic regression coverage for exact-document request-completion routing plus missing-document and frozen/discarded fail-safe behavior.
- Promotion requires exact-head validation, release, protected Glass deployment, and read-only post-install evidence gates.
- Keep #439 open through a real Windows-virtual-desktop live test after v0.9.25 is loaded.

## Accepted behavior retained from #437/#438/#439 v0.9.24

- Verified timeout/system recovery and silent-stop recovery use separate final eligibility rules.
- An interrupted response remains attributable across a reload when the same response is still present.
- Automatic recovery Continue and coded-status Continue are timestamped at send time using the local quick-prompt format.
- Automatic continuation remains bounded and guarded by exact request identity and the existing user/safety vetoes.
- Hidden completion no longer waits on `requestAnimationFrame()` after the answer-check scheduler runs.
- Hidden generic completion checks no longer enter the 150 ms page timer before their hidden-tab check.
- Lifecycle diagnostics record sanitized request-completion and frozen/discarded state without prompt or assistant content.
- Existing stable extension identity/root, updater, rollback, notification delivery, localhost bridge, prompt binding, duplicate suppression, and manual-stop behavior are retained.

## Accepted proof

- **v0.9.22 exact-head validation:** run `35001614683`; candidate artifact `10409554404`; digest `sha256:554d39626bdaa7498543dcc1b1bd252670afbf8e62feb0d15fa200904f17f4de`.
- **v0.9.23 exact-head validation:** run `35005655994`; candidate artifact `10411761761`; digest `sha256:723079f6bea3ad84db24a6c936550e94e0d706dc5d436c63b9ef4d40d171da89`.
- **v0.9.24 exact-head validation:** run `35009988034`; candidate artifact `10413207070`; digest `sha256:ae1b36c6ef37aa45d0fb1a0685377cbc930d9ac2000a6f87cded7d5a59cea4cc`; candidate source `027b316dd788217b8359d63209159c2c3e5a7066`.
- **v0.9.24 publication:** notifier PR #53 merged as `ed171c856eac03d132d77908096023b010fa9e80`; release `v0.9.24` published; managed update manifest advanced on `main`.
- **v0.9.24 protected deployment:** Glass PR #140 / run `35011382942`; installed source `027b316dd788217b8359d63209159c2c3e5a7066`; installed version 0.9.24; helper listener owned; rollback available; extension identity retained.
- **v0.9.24 post-install evidence:** runtime-evidence run `35009987984` attempt 2 / job `104525713574`; evidence reported installed/current/historical extension 0.9.24 and live runtime identity.
- **Failed v0.9.24 virtual-desktop acceptance evidence:** runtime-evidence run `35009987984` attempt 3 / artifact `10414237424`; digest `sha256:f0390b7d698c6ecd99fd4b5d1fb9d70586c8ac15f1d566ecf7f6fcc4a0e9c1a8`. Request completion and lifecycle evidence occurred at `19:17:05Z` with `frozen=false;discarded=false`; coded observation/claim/queue began only at `19:19:42Z` when the Chrome window returned to view.

## Program structure

| Workstream | Scope | Current state |
| --- | --- | --- |
| Workstream 1/5 — Foundation and Conversation Identity | Completion sensor, stable chat routing, loopback helper protocol. | Active #439 exact-document request-completion probe; v0.9.24 live, v0.9.25 candidate. |
| Workstream 2/5 — Native Toast UX | Persistent notifications, timestamps, quick prompts, click/dismiss routing. | Complete through v0.9.24; retained by #439. |
| Workstream 3/5 — Installation, Release, and Acceptance | Installer, stable root, updater, rollback, release publication. | Complete through v0.9.24; candidate v0.9.25 must pass existing gates. |
| Workstream 4/5 — Reliable Background Automation | Durable ownership, guarded continuation, recovery, delivery/outbox. | Existing durable pipeline retained; #439 changes only how request completion wakes terminal observation. |
| Workstream 5/5 — Status Contract and Bounded Recovery | Contract retention, current-run recognition, bounded recovery, proof/rollout. | Complete through v0.9.24; identity and safety guards retained by #439. |

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

Implement, validate, publish, and protected-deploy candidate v0.9.25 from the accepted v0.9.24 baseline. Keep #439 open until a real coded completion notification arrives while the Chrome window remains on another Windows virtual desktop. If that acceptance still fails, use the request-completion probe diagnostics to distinguish missing exact document routing from delayed DOM terminal evidence before changing architecture again.
