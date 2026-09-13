# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. Source authority: this repository. Work ownership: [DevelopmentInfrastructure #283](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/283). Implementation: draft [PR #33](https://github.com/thatoneguydan/chatgpt-response-notifier/pull/33). Review and rollout: [#32](https://github.com/thatoneguydan/chatgpt-response-notifier/issues/32), [#34](https://github.com/thatoneguydan/chatgpt-response-notifier/issues/34).

## Current checkpoint — 2026-09-13

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

No Workstream or Stage counts change. The old 0.9.1 checkpoint and one-reload description are superseded.

## ChatGPT Response Notifier → Workstream 4/5 — Reliable Background Automation → Stage 1/3 — Coordinated Continuation → Step 1/1 — Own and verify each continuation → Gate 1/1 — One matching continuation or explicit fallback

- Task 1/3 — Publish roadmap/state contract. **Complete; retained.**
- Task 2/3 — Transactional turn ownership, read-only observation, separately authorized DOM action, strict identity and user guards. **Implemented; reopened for the DOM-observer identity defect.** Carry Chrome's sender document ID separately from status/monitor runtime UUIDs; bind the requery to the observed conversation, prompt, assistant and revision before claim/action.
- Task 3/3 — Prove duplicate claims, failed/uncertain sends, navigation, user intervention and restart. **Prior component proof retained; targeted regression proof pending.** Include DOM-triggered LIMIT delivery with genuinely distinct browser/local document IDs.

Acceptance: only contract-eligible codes may request the exact continuation text. Uncertain post-click outcomes never authorize a second send. A requested Work-to-normal-chat handoff remains notification-only. Preserve upstream content-script bytes.

## ChatGPT Response Notifier → Workstream 4/5 — Reliable Background Automation → Stage 2/3 — Reliable Delivery and Recovery → Step 1/1 — Preserve each unresolved outcome → Gate 1/1 — Restart and reconnection cannot silently lose or replay work

- Task 1/3 — Durable outbox, stable IDs, helper ACK, dismissal/restart deduplication. **Implemented; reopened for lost wakeups.** An enqueue concurrent with an active flush must cause a subsequent drain. Pending records need a bounded local retry/wake route independent of another ChatGPT completion.
- Task 2/3 — Unified finalization and version-aware attachment. **Implemented; reopened for observation retry.** Observing a footer is an attempt, not successful delivery. A transient query failure or unavailable page must not permanently consume that observation. Resume/reconcile with the same logical identity; cancel on navigation, deliberate close or supersession.
- Task 3/3 — Prove crash/reconnect/replay, history and diagnostics. **Targeted proof pending.** Exercise enqueue racing an active ACK wait, delayed/missing ACK, failed first status read followed by identical valid observation, and restart before durable outcome. Preserve stable notification IDs, successful-continuation silence and dismissed-ID tombstones.

Acceptance: helper ACK is required to remove an outbox entry. Evidence distinguishes observed, claimed, queued, sent, acknowledged and shown/dismissed. “Turn exists and no outbox entry” is not delivery proof.

## ChatGPT Response Notifier → Workstream 4/5 — Reliable Background Automation → Stage 3/3 — Workstation Acceptance and Release → Step 1/1 — Prove the complete background workflow → Gate 1/1 — Exact-source browser and helper evidence supports release acceptance

- Task 1/3 — Exact candidate component/architecture and Windows helper/installer proof. **Prior v0.9.7 proof retained; new repair candidate proof pending.** Preserve same-version double-install acceptance.
- Task 2/3 — Real Chrome/background/duplicate/navigation/input/helper/update/lifecycle acceptance. **Pending**, fulfilled by ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 4/4 — Prove and Roll Out → Step 1/1 — Validate the real background workflow → Gate 1/1 — Exact-source evidence supports enabling recovery → Task 4/5.
- Task 3/3 — Focus/fullscreen, exact-source publication and installed identity. **Pending**, fulfilled by ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 4/4 — Prove and Roll Out → Step 1/1 — Validate the real background workflow → Gate 1/1 — Exact-source evidence supports enabling recovery → Task 5/5.

Acceptance: source, isolated installation, live runtime and visible behavior remain separate evidence.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 1/4 — Retain the Contract → Step 1/2 — Preserve and verify footer obligations → Gate 1/1 — Applicable final replies are checkable across long-chat continuation

- Task 1/3 — Reconcile source/install identity and active PR. **Historical baseline complete; repeat exact identity for each application candidate.**
- Task 2/3 — Canonical scope retention, capsule, final check, bounded footer repair and START. **Implemented in v1.** Normative meanings remain in DevelopmentInfrastructure; do not copy a second taxonomy here.
- Task 3/3 — Versioned grammar parity and long-conversation fixtures. **Existing v1 component proof retained.**

Acceptance: exact assistant-authored START is non-terminal and scoped to the current human request; quoted/list/code/tool/history markers never authorize automation.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 1/4 — Retain the Contract → Step 2/2 — Distinguish resumable work from transfer → Gate 1/1 — Producer and installed consumer agree before new codes become actionable

- Task 1/3 — Review and define the v2 amendment in the canonical detailed policy, compact authority contract/capsule, grammar and evaluation fixtures. **Planned, not implemented.** Add INCOMPLETE_CONTINUE for authorized unfinished work that can resume in the same chat; reserve HANDOFF for an explicit user-requested or applicable policy-required transfer. Real forced capacity stops retain LIMIT. Saving a checkpoint does not authorize stopping.
- Task 2/3 — Implement one shared continuation eligibility predicate across parser, dispatch, page revalidation, normal observer and recovery paths. **Planned.** Support the agreed v1/v2 transition; preserve exact observed/expected code equality and reuse the existing owned, bounded Send path. Never reinterpret legacy HANDOFF as permission to continue.
- Task 3/3 — Prove classification/compatibility and activate producer v2 only after installed consumer capability is verified. **Planned.** Cover voluntary stop, real limit, explicit transfer, human blocker, malfunction, completed scoped review, active planning, malformed/quoted/unknown statuses, long-chat retention and uncertain/duplicate sends. Unsupported versions fail visibly without repeated format repair.

Acceptance: one terminal footer remains sufficient; no second action marker or free-text inference. Both eligible codes send exactly the existing continuation text under the same safeguards. Completion and planning semantics remain intact.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 2/4 — Observe Every Pending Request → Step 1/1 — Track build requests until a visible outcome → Gate 1/1 — Missing codes, delay, error and silence are distinguishable

- Task 1/3 — Combined enrollment, original human-run identity, provisional blank-chat enrollment, auto-recognition and sticky Pause. **Implemented; preserve.**
- Task 2/3 — Versioned UI/request observation with unchanged upstream sensor. **Implemented; delivery integration proof reopened.** One observation must stay bound to its originating turn throughout requery/retry. Historical content loaded at attachment is not a new live action request.
- Task 3/3 — Bounded structural diagnostics, separate deduplicated attention, history and quiet close. **Partially implemented.** Instrument actual delivery decisions/ACK/presentation results, rather than infer success from an independent delayed query; add external evidence collection below.

Acceptance: no ordinary non-build interaction, false missing-footer repair, history-triggered Send, or close-triggered attention.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 3/4 — Recover Within a Budget → Step 1/1 — Reconcile before refresh or continuation → Gate 1/1 — Every automatic action is owned, bounded and cancellable

- Task 1/3 — Durable incident/run budget, breaker, earliest alarm, restart reconstruction and user vetoes. **Implemented; preserve.**
- Task 2/3 — Up to **three** background reloads per incident, reinspection after each, then only an appropriate guarded continuation or format repair. **Implemented in current source.** Resumed generation/tool activity cancels recovery; persistent silent idle after reload 3 permits the one guarded continuation.
- Task 3/3 — Concurrency/crash/uncertainty/late-response/identity/lifecycle budget proof. **Existing component proof retained; live proof pending.**

Current defaults: 30-second terminal/error grace; silence requires at least 90 seconds idle and two consistent inspections at least 30 seconds apart; 15-minute ambiguous-thinking diagnostic without forced retry; up to three reloads, one continuation, one format repair and two automatic messages per incident; at least 30 seconds between profile actions; persisted 12-generation-producing-action ceiling per human-started run. Reset only by a genuinely new trusted human request or explicit Resume. Local outbox delivery retries do not generate ChatGPT messages.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 4/4 — Prove and Roll Out → Step 1/1 — Validate the real background workflow → Gate 1/1 — Exact-source evidence supports enabling recovery

- Task 1/5 — Repair and prove the reproduced observation/outbox stalls, browser-document routing, and diagnostic truthfulness. **Next normal-chat implementation.** Use the handoff's integrated failure cases; retain duplicate suppression and all existing guards. Then build/prove one exact candidate on Glass, including same-version installer replacement. This Work segment performed no application fix/build/install.
- Task 2/5 — Add automatic **read-only-first** Glass evidence collection independent of notifier bootstrap. **Planned; previously only in issue comments.** Capture exact install/helper/loaded-runtime identity, bounded sanitized diagnostics and available Chrome worker load/runtime errors directly to GitHub. Do not collect chat bodies or ask Dan to shuttle commands/output. Verify supported live browser access before promising CDP capture; report unavailable capabilities honestly.
- Task 3/5 — Add the guarded Glass-only candidate deployment/rollback lane. **Planned; previously only in issue comments.** Bind requests to exact validated source/artifact/digest and known previous candidate. Execute per-user install/helper activation in Dan's actual interactive session using reviewed project-scoped infrastructure; the NETWORK SERVICE CI runner is only the submitter. Prove automatic activation from the actually loaded predecessor; do not assume new heartbeat code exists in an older runtime.
- Task 4/5 — Run real current-build acceptance and correlate misses to recorded stages. **Pending repairs/evidence.** First collect from already-installed 0.9.7. Then prove multiple consecutive exactly-one correctly titled terminal notifications across multiple notification codes; guarded LIMIT; sticky Pause/Resume; quiet close/duplicate transfer; inactive/minimized/SPA/draft/helper/update/freeze behavior; no false footer repair. Human input is for genuinely visual toast/focus observations. No manufactured server failures or quota probes.
- Task 5/5 — Prove no foreground theft during normal/fullscreen work; publish through the exact-source updater and verify installed identity/rollback. **Pending Task 4/5.** Candidate deployment remains separate from public publication; promote only the accepted exact source/artifact.

Acceptance: no public merge/release based only on deterministic tests. Missing diagnostics or loaded-runtime identity remains an explicit evidence gap, not a pass. Do not require a repeat install or deploy the documentation-only head.

## Continuing from this handoff

The next normal chat adopts #283 and PR #33 from current GitHub state, reads the implementation handoff, collects existing evidence when the supported lane permits it, and performs the bounded repairs above. The v2 continuation amendment remains a separate planned contract change; prioritize restoring dependable notification delivery and evidence first.

No ChatGPT API/session polling, custom ChatGPT HTTP traffic, forced tab/window activation, replay of the original prompt, Regenerate, auto-approval or unbounded retry chains. Preserve loopback-only helper transport, local state, rolling 20 coded history, durable ACK/deduplication, three-reload recovery, safe updater/rollback and quiet deliberate tab closure.
