# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. Source authority: this repository. Work ownership: [DevelopmentInfrastructure #283](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/283). Implementation: draft [PR #33](https://github.com/thatoneguydan/chatgpt-response-notifier/pull/33). Review and rollout: [#32](https://github.com/thatoneguydan/chatgpt-response-notifier/issues/32), [#34](https://github.com/thatoneguydan/chatgpt-response-notifier/issues/34).

## Current checkpoint — 2026-09-14, Work diagnosis complete

**Application source reviewed:** `fedfa3bd45e64be33497fa64ccf7dde009f3aa92`, **v0.9.15**. Latest verified deployment installed that version/source and a healthy helper/listener. Chrome's unpacked registration was last reported absent after the v0.9.13 hang/forced termination; the stored loaded-extension 0.9.13 observation is historical. PR #33 remains draft/unpublished.

Read the [current implementation/evidence handoff](docs/WORK-HANDOFF-2026-09-14.md). It supersedes the old instruction to reimplement or deploy v0.9.12 and the older 0.9.7 investigation handoff for current next actions.

**Already implemented:** missing-footer format repair is retired; status-missing is passive; LIMIT and TOOL_FAILURE use normal continuation; BLOCKED_HUMAN and deliberate HANDOFF remain terminal; explicit interruptions use one reload then one guarded continuation; browser toast clicks use a Chrome-only override; startup cleanup retires old status-missing attention. The stable extension ID and in-place directory update repair are retained.

**New findings requiring bounded normal-chat work:**
- A controlled probe of unchanged v0.9.15 reproduced a hidden old-turn timeout being attached to the current request and selected for reload. Unify UI detection with visibility/current-request/prose exclusions and document identity.
- Native foreground is suppressed by a browser override, but the original worker path and helper Win32 protocol handler remain. Move retirement into the primary paths, fail closed if safety initialization fails, and prove the production click event path.
- Runtime evidence republishes historical loaded identity and labels its availability as live. Separate identity freshness/connection from historical state and collect bounded click/browser-hang/registration evidence.
- The exact native cause of the Chrome hang and second registration loss remains **unproven**. The first root-replacement/ID-migration incident does not explain the later incident by itself.

Existing exact application proof: [validation 34864627861](https://github.com/thatoneguydan/chatgpt-response-notifier/actions/runs/34864627861), artifact 10356358311; [Glass deployment 34864866247](https://github.com/thatoneguydan/glass/actions/runs/34864866247); evidence 34864628834 / job 104047566709. Exact source/artifact/installed identities and evidence limitations are preserved in the handoff and PR #33.

This is a documentation checkpoint, not a new application implementation/install or live-acceptance pass. Normal chat should implement/prove the bounded repairs before another live click test. If registration is still absent, the eventual manual Load unpacked action follows candidate proof and installed/helper verification; do not automatically manipulate Chrome registration.

The producer taxonomy remains seven-code v1; the coordinated v2 INCOMPLETE_CONTINUE amendment is still planned. Existing Workstream/Stage/Step/Gate/Task counts are unchanged.

## Historical checkpoint — 2026-09-13 (superseded for continuation)

The following describes the 0.9.7 investigation only. Use the current checkpoint, active tasks and 2026-09-14 handoff for current behavior and next actions.

Dan reports v0.9.7 already installed and Windows notifications still missing. Later #34/#283 comments supersede their older “install 0.9.7” instructions. Do not request a repeat install without contrary live identity.

Work investigation is complete. Two delivery stalls and a continuation document-routing mismatch were reproduced in unchanged v0.9.7 source using isolated component probes. The exact Glass failure remains uncorrelated because its live diagnostics have not been retrieved. Application fixes, builds, installation, and live acceptance remain normal-chat work. Read [the implementation handoff](docs/WORK-HANDOFF-2026-09-13.md) for reproductions, repair boundaries, tests, and evidence requirements.

The earlier INCOMPLETE_CONTINUE / narrower INCOMPLETE_HANDOFF proposal was present only in a PR comment. It was neither implemented nor a roadmap task. It is now planned below. The active producer and consumer contract is still v1 with seven codes; INCOMPLETE_LIMIT remains the only auto-continuation code. Do not emit the proposed code until compatible consumer rollout is proven.

The unified Build automation control, sticky Pause, current-request START recognition, rolling 20 history, and quiet tab close/duplicate-owner transfer are implemented. Current incident recovery allows **three reloads**, with reinspection after each and at most one appropriate continuation; all existing draft/upload/Stop/Pause/auth/approval/rate-limit and action-budget guards remain. Source presence and old component passes do not establish reliable live delivery.

Exact candidate/source/artifact identities belong in PR #33 and #283/#34, not self-referential roadmap commits. A documentation-only head is not a rebuilt application candidate.

## Structure and changes

| Workstream | Scope |
| --- | --- |
| Workstream 1/5 — Foundation and Conversation Identity | Completion sensor, stable chat routing, loopback helper protocol. |
| Workstream 2/5 — Native Toast UX | Persistent stacked non-activating notifications and deliberate dismissal. |
| Workstream 3/5 — Installation, Release, and Acceptance | Per-user installer, managed updater, rollback, installed identity. |
| Workstream 4/5 — Reliable Background Automation | Durable ownership, guarded continuation, delivery/outbox. |
| Workstream 5/5 — Status Contract and Bounded Recovery | Contract retention, current-run recognition, recovery, and rollout proof. |

**Roadmap change:** ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 1/4 — Retain the Contract expands from **1 to 2 Steps**. Existing retention is Step 1/2; the continuation-contract amendment is new Step 2/2.

**Roadmap change:** ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 4/4 — Prove and Roll Out → Step 1/1 — Validate the real background workflow → Gate 1/1 — Exact-source evidence supports enabling recovery expands from **3 to 5 Tasks**. Repair/proof remains Task 1/5; automatic evidence collection and controlled candidate deployment are new Tasks 2/5 and 3/5; former live acceptance Task 2/3 becomes Task 4/5; former release Task 3/3 becomes Task 5/5.

No Workstream or Stage counts change. Current explicit-interruption recovery uses one reload; silent-stop recovery retains a separate three-reload budget. The 2026-09-14 diagnosis changes task contents/status, not counts.

## ChatGPT Response Notifier → Workstream 4/5 — Reliable Background Automation → Stage 1/3 — Coordinated Continuation → Step 1/1 — Own and verify each continuation → Gate 1/1 — One matching continuation or explicit fallback

- Task 1/3 — Publish roadmap/state contract. **Complete; retained.**
- Task 2/3 — Transactional turn ownership, read-only observation, separately authorized DOM action, strict identity and user guards. **Implemented with existing component proof.** Preserve distinct browser/local document identities and bind requery to conversation, prompt, assistant and revision. The new interruption-query identity repair is tracked in the current handoff.
- Task 3/3 — Prove duplicate claims, failed/uncertain sends, navigation, user intervention and restart. **Existing component proof retained; live acceptance pending.** Current follow-up proof must cover DOM/upstream LIMIT and TOOL_FAILURE, real production composition, and interruption query/navigation races.

Acceptance: only contract-eligible codes may request the exact continuation text. Uncertain post-click outcomes never authorize a second send. A requested Work-to-normal-chat handoff remains notification-only. Preserve upstream content-script bytes.

## ChatGPT Response Notifier → Workstream 4/5 — Reliable Background Automation → Stage 2/3 — Reliable Delivery and Recovery → Step 1/1 — Preserve each unresolved outcome → Gate 1/1 — Restart and reconnection cannot silently lose or replay work

- Task 1/3 — Durable outbox, stable IDs, helper ACK, dismissal/restart deduplication. **Implemented with existing component proof.** Preserve subsequent drain after concurrent enqueue and bounded local retry independent of another ChatGPT completion.
- Task 2/3 — Unified finalization and version-aware attachment. **Implemented with existing component proof.** Preserve retryable observations, same logical identity, and cancellation on navigation, deliberate close or supersession.
- Task 3/3 — Prove crash/reconnect/replay, history and diagnostics. **Existing component proof retained; live acceptance pending.** Preserve outbox/ACK/retry/restart regressions, stable IDs, successful-continuation silence and dismissed-ID tombstones. Evidence freshness and click-stage diagnosis need the new bounded repair.

Acceptance: helper ACK is required to remove an outbox entry. Evidence distinguishes observed, claimed, queued, sent, acknowledged and shown/dismissed. “Turn exists and no outbox entry” is not delivery proof.

## ChatGPT Response Notifier → Workstream 4/5 — Reliable Background Automation → Stage 3/3 — Workstation Acceptance and Release → Step 1/1 — Prove the complete background workflow → Gate 1/1 — Exact-source browser and helper evidence supports release acceptance

- Task 1/3 — Exact candidate component/architecture and Windows helper/installer proof. **v0.9.15 exact-source validation passed; next application repair requires new exact-source proof.** Preserve same-version double-install/root-preservation acceptance.
- Task 2/3 — Real Chrome/background/duplicate/navigation/input/helper/update/lifecycle acceptance. **Pending**, fulfilled by ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 4/4 — Prove and Roll Out → Step 1/1 — Validate the real background workflow → Gate 1/1 — Exact-source evidence supports enabling recovery → Task 4/5.
- Task 3/3 — Focus/fullscreen, exact-source publication and installed identity. **Pending**, fulfilled by ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 4/4 — Prove and Roll Out → Step 1/1 — Validate the real background workflow → Gate 1/1 — Exact-source evidence supports enabling recovery → Task 5/5.

Acceptance: source, isolated installation, live runtime and visible behavior remain separate evidence.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 1/4 — Retain the Contract → Step 1/2 — Preserve and verify footer obligations → Gate 1/1 — Applicable final replies are checkable across long-chat continuation

- Task 1/3 — Reconcile source/install identity and active PR. **Historical baseline complete; repeat exact identity for each application candidate.**
- Task 2/3 — Canonical scope retention, capsule, final check and START. **Implemented in v1.** Automatic browser missing-footer repair is retired for this product; the shared policy permits but does not require it. Normative meanings remain in DevelopmentInfrastructure; do not copy a second taxonomy here.
- Task 3/3 — Versioned grammar parity and long-conversation fixtures. **Existing v1 component proof retained.**

Acceptance: exact assistant-authored START is non-terminal and scoped to the current human request; quoted/list/code/tool/history markers never authorize automation.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 1/4 — Retain the Contract → Step 2/2 — Distinguish resumable work from transfer → Gate 1/1 — Producer and installed consumer agree before new codes become actionable

- Task 1/3 — Review and define the v2 amendment in the canonical detailed policy, compact authority contract/capsule, grammar and evaluation fixtures. **Planned, not implemented.** Add INCOMPLETE_CONTINUE for authorized unfinished work that can resume in the same chat; reserve HANDOFF for an explicit user-requested or applicable policy-required transfer. Real forced capacity stops retain LIMIT. Saving a checkpoint does not authorize stopping.
- Task 2/3 — Implement one shared continuation eligibility predicate across parser, dispatch, page revalidation, normal observer and recovery paths. **Planned.** Support the agreed v1/v2 transition; current v1 already supports LIMIT and TOOL_FAILURE through its shared predicate/compatibility routing. Preserve exact observed/expected code equality and reuse the existing owned, bounded Send path. Never reinterpret legacy HANDOFF as permission to continue.
- Task 3/3 — Prove classification/compatibility and activate producer v2 only after installed consumer capability is verified. **Planned.** Cover voluntary stop, real limit, explicit transfer, human blocker, malfunction, completed scoped review, active planning, malformed/quoted/unknown statuses, long-chat retention and uncertain/duplicate sends. Unsupported versions fail visibly without repeated format repair.

Acceptance: one terminal footer remains sufficient; no second action marker or free-text inference. Every agreed eligible code sends exactly the existing continuation text under the same safeguards. Completion and planning semantics remain intact.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 2/4 — Observe Every Pending Request → Step 1/1 — Track build requests until a visible outcome → Gate 1/1 — Missing codes, delay, error and silence are distinguishable

- Task 1/3 — Combined enrollment, original human-run identity, provisional blank-chat enrollment, auto-recognition and sticky Pause. **Implemented; preserve.**
- Task 2/3 — Versioned UI/request observation with unchanged upstream sensor. **Implemented; current-request interruption attribution is reopened.** Exclude old/hidden/prose error text and bind compatibility queries to the same browser document. Historical content loaded at attachment is not a new live action request.
- Task 3/3 — Bounded structural diagnostics, separate deduplicated attention, history and quiet close. **Delivery-stage diagnostics implemented; identity freshness and click/hang evidence incomplete.** Correct historical-versus-live reporting and add bounded evidence as specified in the current handoff.

Acceptance: no ordinary non-build interaction, false missing-footer repair, history-triggered Send, or close-triggered attention.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 3/4 — Recover Within a Budget → Step 1/1 — Reconcile before refresh or continuation → Gate 1/1 — Every automatic action is owned, bounded and cancellable

- Task 1/3 — Durable incident/run budget, breaker, earliest alarm, restart reconstruction and user vetoes. **Implemented; preserve.**
- Task 2/3 — Explicit interruption: **one reload**, reinspection, then at most **one normal continuation** if still appropriate. Silent stop: up to **three reloads**, reinspection after each, then at most one eligible continuation. **Implemented; current-error attribution needs repair.** Automatic format repair is retired. Resumed generation/tool activity cancels recovery.
- Task 3/3 — Concurrency/crash/uncertainty/late-response/identity/lifecycle budget proof. **Existing component proof retained; live proof pending.**

Current defaults: 30-second terminal/error grace; silence requires at least 90 seconds idle and two consistent inspections at least 30 seconds apart; 15-minute ambiguous-thinking diagnostic without forced retry; explicit interruption one reload versus silent-stop up to three reloads; at most one recovery continuation and zero format-repair prompts per incident. Preserve existing profile spacing of at least 30 seconds, persisted 12-generation-producing-action ceiling per human-started run, and uncertain-send vetoes. Reset only by a genuinely new trusted human request or explicit Resume. Local outbox delivery retries do not generate ChatGPT messages.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 4/4 — Prove and Roll Out → Step 1/1 — Validate the real background workflow → Gate 1/1 — Exact-source evidence supports enabling recovery

- Task 1/5 — Repair and prove source decisions. **Original delivery/routing repairs implemented; bounded follow-up ready for normal chat.** Implement the current handoff's current-request UI classifier, primary-path retirement of format repair/native foreground, and integrated production-entry regressions. Preserve earlier outbox/ACK/document/uncertain-send proof. Build one exact candidate on Glass, including root-preserving repeat install.
- Task 2/5 — Automatic read-only Glass evidence collection. **Implemented, with freshness/coverage defects to repair.** Existing lane collects installed/helper and sanitized self-report evidence; it does not currently capture live Chrome worker errors or establish freshness from a stored version. Separate historical identity from live connection, add click-stage correlation and bounded existing Windows hang/crash/registration evidence where supported. No chat bodies/default-profile debugging/Origin impersonation.
- Task 3/5 — Guarded Glass-only candidate deployment/rollback. **Implemented and used through v0.9.15; retain.** Bind exact validated source/artifact/digest and known previous candidate; use Dan's actual interactive session through the reviewed project-scoped lane. No automatic unpacked-extension registration/migration. A documentation-only head is not the next application candidate.
- Task 4/5 — Real current-build acceptance. **Reopened; native Chrome hang/second registration loss remain unresolved.** First complete deterministic repairs/evidence preparation, then validate/install the exact next candidate. If still required, reach the one manual Load unpacked step only after that proof. Prove notification click routing without a hang or registration loss, correct LIMIT/TOOL_FAILURE continuation, BLOCKED_HUMAN/HANDOFF stop behavior, passive missing footer, current-only interruptions, and existing background/Pause/quiet-close/draft/helper/lifecycle behavior. Do not manufacture quota errors or repeatedly crash Chrome.
- Task 5/5 — No foreground theft during normal/fullscreen work, accepted exact-source publication, installed identity and rollback. **Pending Task 4/5.** Keep PR #33 draft/unpublished; promote only the accepted exact source/artifact.

Acceptance: no public merge/release based only on deterministic tests. Missing diagnostics/current loaded identity is an explicit evidence gap. A stale self-report is not current Chrome registration. A removed browser call is not a proven native crash cause.

## Continuing from this handoff

Normal chat adopts #283/PR #33, reads [WORK-HANDOFF-2026-09-14.md](docs/WORK-HANDOFF-2026-09-14.md), reconciles current head/in-flight operations and completes the deterministic repair/proof/evidence work. Work intentionally stops at Dan's requested implementation boundary. The v2 continuation amendment remains separately planned.

Preserve loopback-only helper transport, local state, rolling 20 coded history, durable ACK/deduplication, sticky Pause and user guards, distinct explicit/silent-stop recovery budgets, stable extension ID/root, updater/rollback and quiet tab closure. No ChatGPT API/session polling, original-prompt replay, Regenerate, auto-approval, unbounded retry chains, automatic foregrounding, native foreground fallback or automatic Chrome registration/profile mutation.
