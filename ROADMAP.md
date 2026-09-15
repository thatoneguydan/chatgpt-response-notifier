# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. Source authority: this repository. Historical incident authority: [DevelopmentInfrastructure #283](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/283). Status-contract v2 authority: [DevelopmentInfrastructure #432](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/432). Explicit-interruption regression authority: [DevelopmentInfrastructure #434](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/434). Timestamp/quick-prompt rollout authority: [DevelopmentInfrastructure #435](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/435). Quick-prompt layout / persistent timeout-recovery authority: [DevelopmentInfrastructure #436](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/436).

## Current checkpoint — 2026-09-15, v0.9.21 accepted live

Notifier **v0.9.21** is implemented, validated, released, installed on `GLASS\dan`, and confirmed as the loaded Chrome extension runtime. The accepted validated source is `a36adbe442fc246b60b531af65fd37efa10f3655`; notifier PR #48 merged as `4aff641b730c3d4393553a223eaf4ba8ca9cf36b`. Comparing the validated source to the merge commit shows **zero file differences**; the merge commit is ancestry-only.

v0.9.21 closes DevelopmentInfrastructure #436 with these accepted changes:

- Quick-prompt toolbar geometry is anchored to the full composer/form rather than the send button, with `ResizeObserver` repositioning as the composer grows or shrinks.
- Toolbar stacking is reduced from a near-maximum layer to a composer-adjacent layer so ChatGPT-owned menus, popovers, and modal surfaces render above it.
- Preset hover/title text uses the same formatter as insertion and shows the actual current local timestamped prompt.
- Bounded current-request interruption detection recognizes attributable timeout/system/connection/generation failure surfaces without admitting quoted, hidden, detached, historical, composer, or tool content as recovery evidence.
- Verified explicit interruptions use persisted recovery state: first safe reload immediately; surviving interruptions wait **5 minutes** between retries; maximum **5 total reload attempts**; after the fifth failed reinspection, at most **one guarded Continue** may be sent.
- If the interruption disappears or generation resumes after any reload, the incident resolves without sending Continue.
- Silent-stop recovery remains separately capped at **3 reload/reinspections** followed by at most one eligible continuation.
- Pause/manual-stop, draft/upload, auth/approval/rate-limit/offline, identity mismatch, uncertainty, dedupe, profile spacing, and whole-run action-budget vetoes remain intact.
- No ChatGPT API/session polling, original-prompt replay, Regenerate, auto-approval, automatic foregrounding, native foreground fallback, or unbounded retry loop was added.

The coordinated producer contract remains **`github-work-status/v2`** with semantic SHA-256 `a2570315b911add3c57231f08b84214daa56750f9c93fd76c5d8b459d28c3efb`. `INCOMPLETE_CONTINUE`, `INCOMPLETE_LIMIT`, and `INCOMPLETE_TOOL_FAILURE` use the shared guarded continuation path; `INCOMPLETE_HANDOFF` remains notification-only. Missing/malformed footer behavior remains passive; browser-side format repair remains retired.

## Accepted proof

- v0.9.17 click/registration incident: accepted; deliberate toast click uses Chrome APIs and was physically proved without Chrome hang or extension-registration loss.
- v0.9.18 status-contract v2 consumer: accepted, deployed, live-proven, and published before producer activation.
- v0.9.19 explicit-interruption precedence repair: accepted and live-proven.
- v0.9.20 timestamp/quick-prompt baseline: accepted, released, protected-deployed, and live-proven.
- **v0.9.21 exact validation:** candidate `a36adbe442fc246b60b531af65fd37efa10f3655`; validation run `34995408103`; candidate artifact `10406553923`; artifact digest `sha256:9ed7d6846e1570c91a9814efc7d28a0da55e1b283439823256a7509855a404ba`. Architecture/behavior tests, helper/installer builds, isolated replacement, root preservation, localhost handshake, and candidate packaging all passed.
- **v0.9.21 source reconciliation:** validated candidate `a36adbe442fc246b60b531af65fd37efa10f3655` → merge `4aff641b730c3d4393553a223eaf4ba8ca9cf36b`; compare reports one ancestry commit and **no changed files**.
- **v0.9.21 publication:** release workflow `34995618963`; tag `v0.9.21` targets `4aff641b730c3d4393553a223eaf4ba8ca9cf36b`; published ZIP SHA-256 `814bdf2c6ed98d1c8edbc918bbc1a301538a78b0c7987486807f3873ae6bf581`; Setup SHA-256 `ecd6247279f314bc00b8b4fe1fe8be175dd8f8e10248f9b4b21a5644cb052a2d`; managed-update manifest commit `7b8e51900171d026c1242c22fd9783b8d5bf3086`.
- **v0.9.21 protected Glass deployment:** Glass PR #137 / deployment bridge run `34995869795`; installed in `GLASS\dan`, session 1; installed source `a36adbe442fc246b60b531af65fd37efa10f3655`; installed version 0.9.21; helper-owned listener; rollback available; extension identity not deferred. The data-only deployment PR was closed without merging after the broker completed, matching the established deployment-lane pattern.
- **v0.9.21 post-install runtime evidence:** rerun of runtime-evidence run `34995408040`; post-install artifact `10406579891`; digest `sha256:c5ef10741b647974d5a4688f30454751626231bfc4282d5d42b78820376daa56`. Safe runtime evidence reports installed/current/historical/loaded extension version **0.9.21**, source `a36adbe442fc246b60b531af65fd37efa10f3655`, live localhost bridge connection, one connected bridge client, and repeated 0.9.21 worker heartbeats after the 0.9.20 → 0.9.21 runtime handoff.
- **Release metadata hardening:** closeout source makes existing-tag release reruns refresh release notes idempotently, preventing a prior version's release description from remaining attached to a newly published version.

## Program structure

| Workstream | Scope | Current state |
| --- | --- | --- |
| Workstream 1/5 — Foundation and Conversation Identity | Completion sensor, stable chat routing, loopback helper protocol. | Complete; retained. |
| Workstream 2/5 — Native Toast UX | Persistent stacked notifications, timestamps, quick prompts, deliberate click/dismiss routing. | **Complete through v0.9.21.** |
| Workstream 3/5 — Installation, Release, and Acceptance | Installer, stable unpacked root, managed updater, rollback, release publication. | **Complete through v0.9.21.** |
| Workstream 4/5 — Reliable Background Automation | Durable ownership, guarded continuation, recovery, delivery/outbox. | **Complete through v0.9.21.** |
| Workstream 5/5 — Status Contract and Bounded Recovery | Contract retention, current-run recognition, bounded recovery, proof and rollout. | **Complete through v0.9.21.** |

## Workstream 1/5 — Foundation and Conversation Identity

Foundation remains unchanged and retained: stable conversation/request identity, current-turn observation, loopback-only helper transport, stable extension root/ID, and manual-only Chrome registration.

## Workstream 2/5 — Native Toast UX

### Accepted surface

- Persistent stacked notifications and rolling coded history remain complete.
- Manual tab close and quiet dismissal do not create false attention.
- Deliberate toast click remains the only focus-authorizing path.
- Native toasts retain persisted local completion timestamps.
- Quick prompts remain extension-owned, timestamped, insert-only, draft-safe, runtime-attached, and isolated from automatic recovery/action budgets.
- **v0.9.21:** toolbar follows the full composer as it resizes, stays below ChatGPT popup/menu/modal layers, and previews the actual timestamped prompt in hover text.

## Workstream 3/5 — Installation, Release, and Acceptance

- Per-user installer preserves the stable unpacked extension root.
- Managed updater/release workflow publishes and reconciles exact release source and assets.
- Protected Glass deployment/rollback reports installed source/version and does not mutate Chrome registration/profile automatically.
- Existing-tag release reruns now refresh release notes so metadata cannot silently remain stale across a version-specific rollout.
- Operator interaction remains a last resort; safe non-interactive updater, loopback-helper, protected Glass, and repository-defined automation paths must be exhausted first.

## Workstream 4/5 — Reliable Background Automation

- Durable outbox, helper ACK, stable notification IDs, dismissal/restart dedupe, reconnect/replay, and diagnostics remain complete.
- Shared continuation admission covers `INCOMPLETE_LIMIT`, `INCOMPLETE_TOOL_FAILURE`, and `INCOMPLETE_CONTINUE`; HANDOFF remains notification-only.
- Verified explicit interruption may override stale generating/tool affordances only after current-request attribution; human/safety vetoes remain higher priority.
- **v0.9.21 explicit-interruption recovery:** up to five total reload/reinspections with five-minute spacing between surviving attempts, then at most one guarded Continue.
- Silent stop remains independently bounded at three reload/reinspections then at most one eligible continuation.
- Work that genuinely resumes after reload is resolved as resumed work rather than left paused by a stale generation-active veto.

## Workstream 5/5 — Status Contract and Bounded Recovery

### Retained contract

One exact terminal footer remains sufficient. Unsupported contract/digest combinations fail closed. Missing footer remains passive; there is no browser-side format-repair message.

### Current-request observation

Current-request interruption recognition excludes hidden/detached/quoted/historical conversation content and now includes bounded visible application UI outside conversation turns/composer/tool content for persistent timeout/system/connection/generation banners.

### Current accepted recovery defaults

- missing-footer grace: 30 seconds;
- silent-stop evidence: at least 90 seconds idle plus two consistent inspections at least 30 seconds apart;
- ambiguous-thinking diagnostic: 15 minutes without forced retry;
- silent-stop reload cap: 3;
- explicit-interruption reload cap: 5;
- explicit-interruption retry spacing after a surviving reload: 5 minutes;
- recovery continuation cap: 1 per incident;
- format-repair prompts: 0;
- profile-wide action spacing: at least 30 seconds;
- persisted generation-producing action ceiling: 12 per trusted human-started run;
- reset only by a genuinely new trusted human request or explicit Resume.

### Acceptance coverage

Deterministic regressions cover explicit-interruption reloads 1–5, five-minute spacing, cap exhaustion, one-continue-only behavior, resolution after reload, resumed work, silent-stop separation, user/safety vetoes, restart/uncertainty behavior, quick-prompt composer anchoring, ResizeObserver attachment, lower stacking layer, and live timestamp preview. Protected deployment plus fresh read-only runtime evidence proves the accepted source is active in the user's Chrome runtime.

## Continuing work

DevelopmentInfrastructure #436 is **complete** in v0.9.21. There is no known deterministic unfinished work in this scope.

Future notifier work starts from current `main`, this roadmap, `PROJECT.md`, and current DevelopmentInfrastructure policy. Preserve loopback-only helper transport, rolling coded history, durable ACK/deduplication, unified Monitor/Recover enrollment, sticky Pause/user guards, current-request interruption attribution, stable extension ID/root, updater/rollback, passive missing-footer behavior, deliberate-click-only foregrounding, local toast timestamps, and insert-only quick prompts. Do not add ChatGPT API/session polling, original-prompt replay, Regenerate, auto-approval, unbounded retries, free-text continuation inference, browser format repair, automatic foregrounding, native foreground fallback, or automatic Chrome registration/profile mutation.
