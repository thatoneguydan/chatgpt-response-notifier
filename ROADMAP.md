# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. Source authority: this repository. Historical incident authority: DevelopmentInfrastructure #283. Status-contract v2 authority: #432. Explicit-interruption regression authority: #434. Timestamp/quick-prompt rollout authority: #435. Quick-prompt layout / persistent timeout-recovery authority: #436. Post-refresh continuation regression authority: #437.

## Current checkpoint — 2026-09-15, v0.9.22 live; #437 complete

Notifier **v0.9.22** is the installed/live baseline on `GLASS\dan`.

DevelopmentInfrastructure **#437** is complete. The accepted release repairs the post-refresh continuation regression, preserves the bounded recovery rules accepted in v0.9.21, and gives automatic Continue messages the same local timestamp format used by manual quick prompts.

Accepted implementation source: `2e751e59496b1ea47739f8ab73e4d9f989f915b7`. Notifier PR #50 merged as `98a3aa1dafb768f623b0f24b7e92e5379d183245`. Release `v0.9.22` is published and the update manifest advanced on `main` as `1cb47b08a725e0849a48d3e07d36d0b4136e9ecf`.

## #437 accepted behavior

- Verified timeout/system recovery and silent-stop recovery use separate final eligibility rules.
- An interrupted response remains attributable across a reload when the same response is still present.
- Automatic recovery Continue and coded-status Continue are timestamped at send time using the local quick-prompt format.
- Automatic continuation remains bounded and guarded by exact request identity and the existing user/safety vetoes.
- The existing explicit-interruption and silent-stop retry budgets remain unchanged.
- Existing stable extension identity/root, updater, rollback, notification delivery, and localhost bridge behavior are retained.

## Accepted proof

- **v0.9.21 baseline:** validation run `34995408103`; protected deployment run `34995869795`; post-install evidence run `34995408040` proved loaded/current 0.9.21 with a live bridge.
- **v0.9.22 exact-head validation:** run `35001614683`; candidate artifact `10409554404`; digest `sha256:554d39626bdaa7498543dcc1b1bd252670afbf8e62feb0d15fa200904f17f4de`. Deterministic post-refresh tests, extension validation, helper/installer build, replacement proof, localhost handshake, and exact candidate packaging passed.
- **v0.9.22 publication:** release workflow `35001950459`; release ZIP SHA-256 `b614b5a458b66a833ebd21ff59b1ab6e52713b9683af7cde75f49176e607e054`; Setup SHA-256 `5cfd6beda042535a32a43bdb16e4cee481f3345502ab8e439494f86316e889b8`.
- **v0.9.22 protected deployment:** Glass PR #138 / run `35002405134`; installed source `2e751e59496b1ea47739f8ab73e4d9f989f915b7`; installed version 0.9.22; helper listener owned; rollback available; extension identity retained.
- **v0.9.22 post-install evidence:** runtime-evidence run `35001614374` attempt 2; artifact `10410970887`; digest `sha256:cd953ef7ed853d299f246f0b9288c1954d4f99134958b1ca42d685a5f0406c48`. Fresh evidence reports installed/current/historical/loaded runtime 0.9.22, one live bridge client, a live extension connection, and repeated v0.9.22 worker heartbeats.

## Program structure

| Workstream | Scope | Current state |
| --- | --- | --- |
| Workstream 1/5 — Foundation and Conversation Identity | Completion sensor, stable chat routing, loopback helper protocol. | Complete; retained. |
| Workstream 2/5 — Native Toast UX | Persistent notifications, timestamps, quick prompts, click/dismiss routing. | Complete through v0.9.22. |
| Workstream 3/5 — Installation, Release, and Acceptance | Installer, stable root, updater, rollback, release publication. | Complete through v0.9.22. |
| Workstream 4/5 — Reliable Background Automation | Durable ownership, guarded continuation, recovery, delivery/outbox. | Complete through #437 / v0.9.22. |
| Workstream 5/5 — Status Contract and Bounded Recovery | Contract retention, current-run recognition, bounded recovery, proof/rollout. | Complete through #437 / v0.9.22. |

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

No additional operator action is required for #437. v0.9.22 is the canonical live baseline. Preserve the accepted notification, continuation, identity, updater/rollback, timestamp, and bounded-recovery contracts in future changes.