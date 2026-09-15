# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. Source authority: this repository. Historical incident authority: [DevelopmentInfrastructure #283](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/283). Status-contract v2 authority: [DevelopmentInfrastructure #432](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/432). Explicit-interruption regression authority: [DevelopmentInfrastructure #434](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/434). Timestamp/quick-prompt rollout authority: [DevelopmentInfrastructure #435](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/435). Quick-prompt layout / persistent timeout-recovery authority: [DevelopmentInfrastructure #436](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/436). Current post-refresh continuation regression authority: [DevelopmentInfrastructure #437](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/437).

## Current checkpoint — 2026-09-15, v0.9.21 live; post-refresh continuation regression active

Notifier **v0.9.21** remains the installed/live baseline on `GLASS\dan`. The accepted v0.9.21 source is `a36adbe442fc246b60b531af65fd37efa10f3655`; PR #48 merged as `4aff641b730c3d4393553a223eaf4ba8ca9cf36b`, release `v0.9.21` is published, and post-install evidence proved the loaded Chrome runtime was 0.9.21.

DevelopmentInfrastructure **#437** is active because live use disproved one part of the previous acceptance: timeout/system interruption recovery does not reliably reach its automatic Continue without a manual refresh, and the automatic post-refresh Continue text is missing the local timestamp used by the manual quick-prompt contract.

### Confirmed #437 root causes

1. **Explicit-interruption Continue is revalidated with silent-stop rules.** `bounded-recovery-script.js` uses one exact-identity predicate for every recovery Continue. That predicate additionally requires no assistant turn plus two silent-idle confirmations. Those are valid silent-stop requirements, but they are not valid for a verified timeout/system interruption that may leave an assistant/error turn in the current request. The background can therefore exhaust the explicit-interruption reload budget and authorize Continue while the page-side sender rejects it.
2. **Persistent page-global interruption UI loses attribution across reload.** Ordinary monitoring intentionally accepts a page-global timeout/system banner only while it can be associated with a fresh request error. Reloading creates a new document and loses that request-phase memory. The persisted recovery incident still knows the exact conversation/prompt, but post-reload reconciliation currently does not pass that recovery identity into the monitor query, so a still-visible global timeout/system banner may disappear from recovery evidence.
3. **Automatic recovery Continue bypasses timestamp formatting.** The recovery page script hard-codes plain `continue until you finish or need something from me`; manual quick prompts use `[Mon D, h:mm AM/PM] ...` formatting.
4. `bounded-recovery-script.js` is already a manifest `document_start` content script, so reload should recreate it. Runtime availability will still receive ping/self-heal hardening as defense-in-depth, but attachment loss is not the primary diagnosis.

### #437 repair contract

- Preserve the existing 5-total-reload / 5-minute explicit-interruption budget and separate 3-reload silent-stop budget.
- Split final page-side continuation revalidation by recovery class:
  - silent-stop: exact conversation/document/prompt/revision plus no assistant turn and two silent-idle confirmations;
  - explicit interruption: exact conversation/document/prompt/revision plus a **still-current verified explicit interruption**; assistant/error turn presence is allowed.
- Pass the recovery reason/class into `CHATGPT_BOUNDED_RECOVERY_COMMAND` so the final send-time gate is deterministic.
- Add a recovery-context monitor query. For a persisted explicit-interruption incident, the background supplies exact conversation/prompt identity to the new document. A visible matching page-global timeout/system banner may then remain attributable even after request-phase memory was reset. Ordinary monitoring keeps the stricter fresh-request-error rule.
- Generate automatic Continue text at send time using the same local timestamp format as manual quick prompts: `[Sep 15, 12:34 PM] Continue until you finish or need something from me.`
- Before automatic message action, ping the page recovery runtime; if unavailable, inject the reviewed status/policy/monitor/recovery scripts and ping again. Failure remains fail-closed.
- Preserve Pause/manual-stop, draft/upload, auth/approval/rate-limit/offline, identity mismatch, uncertainty, dedupe, profile spacing, request confirmation, and whole-run action budgets.
- Do not add ChatGPT API/session polling, prompt replay, Regenerate, auto-approval, foregrounding, native foreground fallback, or unbounded retries.

## Accepted proof retained

- v0.9.17 click/registration incident: deliberate toast click physically accepted without Chrome hang or extension-registration loss.
- v0.9.18 status-contract v2 consumer: accepted/deployed/live-proven before producer activation.
- v0.9.19 explicit-interruption precedence repair: accepted/live-proven.
- v0.9.20 timestamp/quick-prompt baseline: accepted/released/protected-deployed/live-proven.
- v0.9.21 validation: candidate `a36adbe442fc246b60b531af65fd37efa10f3655`, run `34995408103`, artifact `10406553923`, digest `sha256:9ed7d6846e1570c91a9814efc7d28a0da55e1b283439823256a7509855a404ba`.
- v0.9.21 publication: release workflow `34995618963`, tag target `4aff641b730c3d4393553a223eaf4ba8ca9cf36b`, ZIP SHA-256 `814bdf2c6ed98d1c8edbc918bbc1a301538a78b0c7987486807f3873ae6bf581`, Setup SHA-256 `ecd6247279f314bc00b8b4fe1fe8be175dd8f8e10248f9b4b21a5644cb052a2d`, update-manifest commit `7b8e51900171d026c1242c22fd9783b8d5bf3086`.
- v0.9.21 protected deployment: Glass PR #137 / run `34995869795`; installed source `a36adbe442fc246b60b531af65fd37efa10f3655`, installed 0.9.21, helper-owned listener, rollback available, extension identity not deferred.
- v0.9.21 post-install evidence: run `34995408040`, artifact `10406579891`, digest `sha256:c5ef10741b647974d5a4688f30454751626231bfc4282d5d42b78820376daa56`; loaded/current extension 0.9.21 with live localhost bridge and repeated heartbeats.
- v0.9.21 release notes corrected by closeout PR #49 merge `2c090776b3913958507911dffea761def01a0dbf` / rerun `34997378545`.

## Program structure

| Workstream | Scope | Current state |
| --- | --- | --- |
| Workstream 1/5 — Foundation and Conversation Identity | Completion sensor, stable chat routing, loopback helper protocol. | Complete; retained. |
| Workstream 2/5 — Native Toast UX | Persistent notifications, timestamps, quick prompts, click/dismiss routing. | Complete through v0.9.21; automatic continuation timestamp parity active in #437. |
| Workstream 3/5 — Installation, Release, and Acceptance | Installer, stable root, updater, rollback, release publication. | Complete through v0.9.21; protected rollout required for #437 candidate. |
| Workstream 4/5 — Reliable Background Automation | Durable ownership, guarded continuation, recovery, delivery/outbox. | **Active #437:** final post-refresh continuation/revalidation reliability. |
| Workstream 5/5 — Status Contract and Bounded Recovery | Contract retention, current-run recognition, bounded recovery, proof/rollout. | **Active #437:** post-reload interruption attribution and end-to-end proof. |

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

## Acceptance required for #437

Deterministic tests must prove: post-reload page-global interruption attribution under exact recovery identity, explicit interruption with an assistant/error turn still present, reloads 1–5 and final one-Continue cap, silent-stop behavior unchanged, timestamped automatic Continue parity, page-runtime ping/self-heal, request acceptance confirmation, and all human/safety vetoes. Then run full source/helper/installer validation, protected non-interactive Glass deployment, and fresh runtime evidence. Do not close #437 merely because model/unit tests pass; the end-to-end post-refresh action path must be exercised deterministically.

## Continuing work

**Current active work is DevelopmentInfrastructure #437** on branch `fix/post-refresh-continuation-runtime`.

Preserve loopback-only helper transport, rolling coded history, durable ACK/deduplication, unified Monitor/Recover enrollment, sticky Pause/user guards, current-request interruption attribution, stable extension ID/root, updater/rollback, passive missing-footer behavior, deliberate-click-only foregrounding, local notification timestamps, timestamped quick prompts, and operator-interaction-last-resort policy.