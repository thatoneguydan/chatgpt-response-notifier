# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. Source authority: this repository. Historical incident authority: DevelopmentInfrastructure #283. Status-contract v2 authority: #432. Explicit-interruption regression authority: #434. Timestamp/quick-prompt rollout authority: #435. Quick-prompt layout / persistent timeout-recovery authority: #436. Post-refresh continuation regression authority: #437. Hidden-tab rAF hardening authority: #438. Hidden-tab end-to-end stall follow-up authority: #439.

## Current checkpoint — 2026-09-15, v0.9.23 live; #439 active

Notifier **v0.9.23** is the installed/live baseline on `GLASS\dan`.

DevelopmentInfrastructure **#438** is complete: hidden completion checks no longer depend on `requestAnimationFrame()`, including the visible-to-hidden pending-frame race. Live testing immediately exposed a remaining background-tab stall: a notification did not appear until the Chrome window and exact ChatGPT tab were activated even though the tab stayed open.

DevelopmentInfrastructure **#439** is the active bounded follow-up. Canonical v0.9.23 source still places the 150 ms answer-check `setTimeout()` in front of the hidden-tab rAF bypass. Chrome can throttle page timers in background tabs, and Chrome can also mark a visibly open tab `frozen`, in which state page event handlers and timers cannot run until activation. Candidate **v0.9.24** removes the remaining hidden-tab timer dependency from the primary completion detector while preserving visible-tab throttling and all accepted continuation/recovery/delivery contracts.

Accepted v0.9.23 candidate source: `a56c5cc3ea2281a3d649489b7aaf3b596c54ef6e`. Notifier PR #52 merged as `72732d2a7322335c8002c192cfdac9005ab3f7ee`; release `v0.9.23` was published and the managed update manifest advanced as `c5236d0a16cfd1dcf21d8b5f42b0c07fccd068bb`. Protected Glass deployment run `35006353430` installed v0.9.23 on `GLASS\dan`; post-install evidence confirmed current loaded extension 0.9.23 with live runtime identity.

## #439 active hardening contract

- A hidden ChatGPT tab must not require page `setTimeout()` or `requestAnimationFrame()` scheduling to observe the final assistant DOM mutation after the conversation request has completed.
- Hidden MutationObserver callbacks run the completion check immediately; visible tabs retain the reviewed 150 ms throttle and frame alignment.
- If the tab becomes hidden while either the 150 ms throttle timer or an animation frame is pending, cancel the pending scheduler and check immediately.
- Preserve the 30-second fallback, latest-prompt binding, duplicate suppression, manual-stop suppression, durable status verification, continuation/recovery guards, and no-foregrounding behavior.
- Do not add ChatGPT API/session polling, debugger attachment, prompt replay, Regenerate, refresh loops, or automatic focus stealing.
- Keep actual Chrome `frozen` state distinct from ordinary hidden-tab throttling: extension code running inside the page cannot execute while Chrome has frozen the page.
- Add deterministic regression coverage for hidden-from-start, visible-to-hidden pending-timer, and visible-to-hidden pending-frame paths.
- Promotion requires the existing exact-head validation, release, protected Glass deployment, and read-only post-install evidence gates.
- Keep #439 open through a real hidden-tab live test after v0.9.24 is loaded.

## Accepted behavior retained from #437/#438

- Verified timeout/system recovery and silent-stop recovery use separate final eligibility rules.
- An interrupted response remains attributable across a reload when the same response is still present.
- Automatic recovery Continue and coded-status Continue are timestamped at send time using the local quick-prompt format.
- Automatic continuation remains bounded and guarded by exact request identity and the existing user/safety vetoes.
- Hidden completion no longer waits on `requestAnimationFrame()` after the answer-check scheduler runs.
- Existing stable extension identity/root, updater, rollback, notification delivery, localhost bridge, prompt binding, duplicate suppression, and manual-stop behavior are retained.

## Accepted proof

- **v0.9.22 exact-head validation:** run `35001614683`; candidate artifact `10409554404`; digest `sha256:554d39626bdaa7498543dcc1b1bd252670afbf8e62feb0d15fa200904f17f4de`.
- **v0.9.23 exact-head validation:** run `35005655994`; candidate artifact `10411761761`; digest `sha256:723079f6bea3ad84db24a6c936550e94e0d706dc5d436c63b9ef4d40d171da89`.
- **v0.9.23 publication:** release run `35005817595`; release tag `v0.9.23`; update manifest advanced on `main`.
- **v0.9.23 protected deployment:** Glass PR #139 / run `35006353430`; installed source `a56c5cc3ea2281a3d649489b7aaf3b596c54ef6e`; installed version 0.9.23; helper listener owned; rollback available; extension identity retained.
- **v0.9.23 post-install evidence:** runtime-evidence run `35005656069` attempt 2 / job `104508585069`; evidence reported installed/current/historical extension 0.9.23 and live runtime identity.

## Program structure

| Workstream | Scope | Current state |
| --- | --- | --- |
| Workstream 1/5 — Foundation and Conversation Identity | Completion sensor, stable chat routing, loopback helper protocol. | Active bounded #439 timer-free hidden completion hardening; v0.9.23 otherwise accepted. |
| Workstream 2/5 — Native Toast UX | Persistent notifications, timestamps, quick prompts, click/dismiss routing. | Complete through v0.9.23; retained by #439. |
| Workstream 3/5 — Installation, Release, and Acceptance | Installer, stable root, updater, rollback, release publication. | Complete through v0.9.23; candidate v0.9.24 must pass existing gates. |
| Workstream 4/5 — Reliable Background Automation | Durable ownership, guarded continuation, recovery, delivery/outbox. | Complete through #438 / v0.9.23; unchanged by #439. |
| Workstream 5/5 — Status Contract and Bounded Recovery | Contract retention, current-run recognition, bounded recovery, proof/rollout. | Complete through #438 / v0.9.23; unchanged by #439. |

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

Implement and validate #439 as candidate v0.9.24 from the accepted v0.9.23 baseline. Keep #439 open until the candidate is installed and a real completion notification is observed while the ChatGPT tab remains hidden. If the page is actually `frozen`, use browser lifecycle evidence/settings rather than introducing focus stealing or unsafe wake behavior.
