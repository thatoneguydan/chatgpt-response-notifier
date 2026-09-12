# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. The active work is reliable background automation of coded build responses through the existing Chrome page and the Windows helper.

Source authority: this repository. Work ownership: [DevelopmentInfrastructure #283](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/283). Design evidence: [review #32](https://github.com/thatoneguydan/chatgpt-response-notifier/issues/32) and [bounded-recovery roadmap #34](https://github.com/thatoneguydan/chatgpt-response-notifier/issues/34). The canonical status taxonomy remains in [DevelopmentInfrastructure](https://github.com/thatoneguydan/DevelopmentInfrastructure/blob/main/GITHUB-WORK-STATUS-POLICY.md).

## Structure and predecessor work

Roadmap change, 2026-09-12: Workstreams **4 → 5**. Add Workstream 5/5 — Status Contract and Bounded Recovery. Existing Workstreams 1–4 retain their ordering and become /5. Workstream 5 integrates the accepted proposal from #34; it does not claim release, installation, or live acceptance.

Earlier roadmap change, 2026-09-12: Workstreams **3 → 4** added Reliable Background Automation. The original three workstreams retain their historical source in the [Glass roadmap](https://github.com/thatoneguydan/glass/blob/main/Tools/ChatGPT%20Response%20Notifier/ROADMAP.md). This document owns the current reliability work.

| Workstream | Scope retained |
| --- | --- |
| ChatGPT Response Notifier → Workstream 1/5 — Foundation and Conversation Identity | Existing completion sensor, stable chat routing, fixed local helper protocol. Native Messaging has since been replaced by loopback WebSocket. |
| ChatGPT Response Notifier → Workstream 2/5 — Native Toast UX | Persistent stacked windows, deliberate-interaction dismissal, quiet initial display, and desktop fit. |
| ChatGPT Response Notifier → Workstream 3/5 — Installation, Release, and Acceptance | Per-user installer, verified managed updates, and historical workstation acceptance. A published release is not proof of the installed version. |
| ChatGPT Response Notifier → Workstream 4/5 — Reliable Background Automation | Durable per-turn ownership, guarded continuation, delivery/outbox recovery, and exact-source acceptance. |
| ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery | Long-chat contract retention, explicit pending-request observation, bounded recovery, and rollout proof. |

## ChatGPT Response Notifier → Workstream 4/5 — Reliable Background Automation → Stage 1/3 — Coordinated Continuation → Step 1/1 — Own and verify each continuation → Gate 1/1 — One matching continuation or explicit fallback

Purpose: a completed coded turn has one durable owner. A status read cannot send text. Navigation, duplicate tabs, or an uncertain send cannot route an action to a different response or cause an automatic replay.

- Task 1/3 — Publish the roadmap and state contract. **Complete.**
- Task 2/3 — Implement transactional turn ownership, a read-only observation path, a separately authorized DOM action, strict chat/document/turn checks, and active-user/draft safeguards. **Implemented on draft PR #33; exact-source rollout acceptance remains separate.**
- Task 3/3 — Prove duplicate claims, failed/uncertain sends, navigation, user intervention, and restart recovery with behavioral tests. **Deterministic behavior coverage exists on draft PR #33; final release-path proof remains in Stage 3.**

Acceptance: only INCOMPLETE_LIMIT can request the exact continuation text. Clear input alone is never success. Ownership is persisted before action. Duplicate tabs cannot claim the same response. Unknown post-click outcomes produce a fallback notification, not a second send. An active user's input is preserved. The original upstream content-script.js remains byte-for-byte unchanged.

## ChatGPT Response Notifier → Workstream 4/5 — Reliable Background Automation → Stage 2/3 — Reliable Delivery and Recovery → Step 1/1 — Preserve each unresolved outcome → Gate 1/1 — Restart and reconnection cannot silently lose or replay work

Purpose: save notification intent before transport, acknowledge it only after helper persistence, and recover the same turn after worker/page/helper lifecycle changes.

- Task 1/3 — Add a durable notification outbox, stable event IDs, helper acknowledgment, and deduplication that survives dismissal/restart. **Implemented on draft PR #33.**
- Task 2/3 — Unify normal/recovery finalization, add version/runtime attachment checks, and preserve frozen/discarded pending state without activation or blind replay. **Implemented on draft PR #33; Workstream 5 extends this with explicit bounded-recovery incidents.**
- Task 3/3 — Prove crash/reconnect/replay, migration of old pending toasts, 20-item history, runtime attachment, and bounded diagnostics. **Deterministic coverage exists; exact-source and workstation proof remain separate.**

Acceptance: queue removal requires durable helper acknowledgment. Notification and recovery records are not cleared by an unclassified upstream event. A delayed or duplicated message does not reopen a dismissed toast. Successful continuation stays quiet; compact action results remain diagnosable. Existing pending notifications remain loadable. Any repeat-failure guard responds to actual lack of progress rather than limiting useful build work arbitrarily.

## ChatGPT Response Notifier → Workstream 4/5 — Reliable Background Automation → Stage 3/3 — Workstation Acceptance and Release → Step 1/1 — Prove the complete background workflow → Gate 1/1 — Exact-source browser and helper evidence supports release acceptance

- Task 1/3 — Pass component/architecture tests and Windows helper/installer build validation on the exact candidate. **Source implementation exists; policy-compliant exact-source proof remains required.**
- Task 2/3 — Verify real Chrome: inactive/minimized tab, duplicate tabs, SPA navigation, user input, delayed/rejected continuation, helper restart, extension update in a running tab, and freeze/resume. **Pending exact installed-candidate proof.**
- Task 3/3 — Verify non-activating notifications with another app/fullscreen game in front, publish the reviewed bundle through the normal updater, and record actual installed identity and any remaining subjective acceptance. **Pending.**

Acceptance: distinguish source tests, built artifacts, installed versions, and live behavior. No synthetic live ChatGPT DOM or forced backend failures are used to manufacture acceptance. Deterministic fixtures belong in offline/component tests. Human perception is requested only where it cannot be established automatically.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 1/4 — Retain the Contract → Step 1/1 — Preserve and verify footer obligations → Gate 1/1 — Applicable final replies are checkable across long-chat continuation

Purpose: a long-running GitHub/build conversation retains the terminal-footer obligation even through assistant-authored summaries, handoffs, and resumed execution, while ordinary conversation and intermediate progress remain untouched.

- Task 1/3 — Reconcile the actual installed extension/helper source identity and current PR #33 before changes; carry forward existing validated coordinator work. **Complete for source identity: PR #33 head reconciled. Installed v0.9.0 identity remains explicitly unverified, so no workstation mutation is inferred or repeated.**
- Task 2/3 — Amend the canonical policy and compact entry contract with applicability retention, summary/resume capsule, tool-free final check, and bounded format-repair semantics. **In progress on the DevelopmentInfrastructure policy branch.**
- Task 3/3 — Add a versioned contract/grammar fixture plus parity checks and long-conversation/compaction evaluation cases. Measure omissions and wrong classifications separately; passing examples are not a universal model guarantee. **Pending.**

Acceptance: the existing seven meanings are unchanged; ordinary chat and progress updates do not gain footers; instructed long-chat handoffs carry the applicability capsule; missing, wrong, quoted, duplicate, and malformed final-footer cases are explicit and testable.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 2/4 — Observe Every Pending Request → Step 1/1 — Track build requests until a visible outcome → Gate 1/1 — Missing codes, delay, error, and silence are distinguishable

Purpose: once a conversation is deliberately monitored, persist the human-originated request before waiting for assistant text and keep it observable until it reaches a coded result, verified continuation, visible waiting state, or explicit attention state.

- Task 1/3 — Add persistent monitoring enrollment and original-request/run identity, including pre-first-footer opt-in and request-generation-safe finalization. **Pending.**
- Task 2/3 — Implement the versioned UI/request observer and classification table, preserving raw upstream detector bytes. Start in observation-only mode. **Pending.**
- Task 3/3 — Add bounded reason diagnostics and a separate deduplicated `attention.required` event, reusing helper persistence/ACK and preserving the rolling 20 coded-result history. **Pending.**

Acceptance: ordinary unmonitored conversations are untouched; quoted error text inside answers is ignored; legitimate thinking/tool activity never becomes an automatic retry merely because time passed; missing/no-answer cases reach a visible state.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 3/4 — Recover Within a Budget → Step 1/1 — Reconcile before refresh or continuation → Gate 1/1 — Every automatic action is owned, bounded, and cancellable

Purpose: recovery is an extension of the existing durable coordinator, not a retry loop. Every reload, continuation, or format repair consumes persisted budget tied to the original trusted human run.

- Task 1/3 — Add the durable incident/run budget, shared rate-limit breaker, earliest-deadline alarm, restart reconstruction, and manual-stop/draft/upload vetoes. **Pending.**
- Task 2/3 — Add one background reload with post-hydration reconciliation, followed only when appropriate by one guarded continuation or format repair. **Pending.**
- Task 3/3 — Prove concurrency, crash windows, uncertain Send, late responses, repeated limits, identity changes, sleep/clock changes, and closed/frozen/discarded tabs cannot reset budgets or replay actions. **Pending.**

Acceptance: no code path can create an unbounded action chain; no reload/Send occurs on uncertain state; no automatic foregrounding or ChatGPT fetch/polling is introduced; stale finalization cannot remove the next pending request.

Initial safety defaults to validate: 30-second stable-terminal/error grace; silent stop only after at least 90 seconds confirmed idle with two consistent inspections at least 30 seconds apart; 15-minute ambiguous-thinking diagnostic without forced retry; per incident at most one reload, one continuation, and one format repair with at most two automatic messages; one automatic Send/reload admission profile-wide at a time with at least 30 seconds between admissions; a persisted 12-generation-producing-action ceiling for the entire human-started run; budgets reset only by a genuinely new trusted human request or explicit operator resume.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 4/4 — Prove and Roll Out → Step 1/1 — Validate the real background workflow → Gate 1/1 — Exact-source evidence supports enabling recovery

- Task 1/3 — Add deterministic behavioral/state-machine tests, including 100+ synthetic continuation cycles, fixture-based blockers, simultaneous chats, and helper outbox/restart migration. Verify automatic action count never exceeds its configured bound. **Pending.**
- Task 2/3 — Run observation-only acceptance on the real supported ChatGPT modes, then one enrolled test chat with bounded actions. Record adapter coverage, false stalls, recovery success, and exact extension/helper/Chrome versions. Do not create repeated real server failures or usage-limit probes to manufacture test coverage. **Pending.**
- Task 3/3 — Prove foreground-window/tab identity stays unchanged with other work/fullscreen activity, release through the existing exact-source updater, verify installed identity, and document rollback/disable controls and remaining limits. **Pending.**

Acceptance: source tests, live UI evidence, and installed state remain distinct. Unknown UI versions fail to observation/attention. Productive long builds calibrate grace periods and the final run ceiling before broad enablement.

## State contract and implementation boundaries

- Browser observations carry conversation URL/ID, document identity, prompt/assistant identity, and a response revision. The worker rejects a changed identity before any action.
- A transactional IndexedDB record owns each eligible turn. Persist any action claim before clicking; a worker restart may reconcile it but must not grant an automatic second click.
- Monitoring enrollment is explicit per conversation or established by a newly completed valid coded turn. Historical/quoted codes and repository-like words do not authorize automatic action.
- Persist the human-originated request/run identity before waiting for assistant output so a no-answer stall remains observable.
- The DOM adapter reads status without side effects and accepts separately authorized narrow actions. It verifies identity and safety guards again immediately before any Send or background reload.
- Completion requires a matching new user message plus observed generation/progress or reconciled request evidence. A cleared composer, HTTP acceptance, optimistic UI, or elapsed time alone is insufficient.
- Notifications use a persistent outbox and stable IDs. The helper persists before acknowledging and remembers accepted IDs after dismissal. Coded history remains the rolling 20 eligible notifications; recovery attention has a separate bounded view.
- A frozen/discarded/unknown page is paused and surfaced as attention. It never authorizes blind activation, reload, or Send.
- Manual Stop, draft/upload presence, authentication/approval requirements, offline state, and rate-limit state veto automatic recovery as defined by Workstream 5.
- Preserve the seven-code contract, upstream detector, existing rollback, loopback-only helper, verified updater, and per-user/windowless deployment. No ChatGPT API polling, authentication access, custom ChatGPT HTTP calls, or new privileged component.

## Current continuation point

Active implementation point: **ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 1/4 — Retain the Contract → Step 1/1 — Preserve and verify footer obligations → Gate 1/1 — Applicable final replies are checkable across long-chat continuation → Task 2/3 — Amend the canonical policy and compact entry contract.**

Source identity is reconciled to draft PR #33. Installed v0.9.0 identity is not proven by canonical evidence and must remain distinct from source state. No new runtime acceptance, release, or installed version is implied by this roadmap integration.
