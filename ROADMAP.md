# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. The active work is reliable background automation of coded build responses through the existing Chrome page and the Windows helper.

Source authority: this repository. Work ownership: [DevelopmentInfrastructure #283](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/283). Design evidence: [review #32](https://github.com/thatoneguydan/chatgpt-response-notifier/issues/32) and [bounded-recovery roadmap #34](https://github.com/thatoneguydan/chatgpt-response-notifier/issues/34). The canonical status taxonomy remains in [DevelopmentInfrastructure](https://github.com/thatoneguydan/DevelopmentInfrastructure/blob/main/GITHUB-WORK-STATUS-POLICY.md).

## Structure and predecessor work

Roadmap checkpoint, 2026-09-12: the unified build-automation amendment from #34 is implemented without changing the numbered roadmap structure. Monitoring and bounded recovery now share one authoritative automation state/control; operator Pause is sticky; current build work can be recognized by the canonical non-terminal `[GITHUB_WORK: START]` signal with valid-terminal-code fallback; command failures are verified rather than silently toggled; and ordinary tab/window closure is quiet. These source changes remain inside Workstream 5/5 → Stage 4/4 → Step 1/1 → Gate 1/1 → Task 2/3 as prerequisite repair for live acceptance.

Roadmap change, 2026-09-12: Workstreams **4 → 5**. Add Workstream 5/5 — Status Contract and Bounded Recovery. Existing Workstreams 1–4 retain their ordering and become /5. Workstream 5 integrates the accepted proposal from #34; it does not by itself claim release, installation, or live acceptance.

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
- Task 2/3 — Implement transactional turn ownership, a read-only observation path, a separately authorized DOM action, strict chat/document/turn checks, and active-user/draft safeguards. **Complete in the PR #33 candidate and included in exact-source Glass validation run 34698869058.**
- Task 3/3 — Prove duplicate claims, failed/uncertain sends, navigation, user intervention, and restart recovery with behavioral tests. **Complete deterministically in PR #33; final live-browser/release-path proof remains in Workstream 5 Stage 4.**

Acceptance: only INCOMPLETE_LIMIT can request the exact continuation text. Clear input alone is never success. Ownership is persisted before action. Duplicate tabs cannot claim the same response. Unknown post-click outcomes produce a fallback notification, not a second send. An active user's input is preserved. The original upstream content-script.js remains byte-for-byte unchanged.

## ChatGPT Response Notifier → Workstream 4/5 — Reliable Background Automation → Stage 2/3 — Reliable Delivery and Recovery → Step 1/1 — Preserve each unresolved outcome → Gate 1/1 — Restart and reconnection cannot silently lose or replay work

Purpose: save notification intent before transport, acknowledge it only after helper persistence, and recover the same turn after worker/page/helper lifecycle changes.

- Task 1/3 — Add a durable notification outbox, stable event IDs, helper acknowledgment, and deduplication that survives dismissal/restart. **Complete in the PR #33 candidate.**
- Task 2/3 — Unify normal/recovery finalization, add version/runtime attachment checks, and preserve frozen/discarded pending state without activation or blind replay. **Complete; Workstream 5 extends this with explicit bounded-recovery incidents.**
- Task 3/3 — Prove crash/reconnect/replay, migration of old pending toasts, 20-item history, runtime attachment, and bounded diagnostics. **Complete deterministically; live installed-candidate proof remains separate.**

Acceptance: queue removal requires durable helper acknowledgment. Notification and recovery records are not cleared by an unclassified upstream event. A delayed or duplicated message does not reopen a dismissed toast. Successful continuation stays quiet; compact action results remain diagnosable. Existing pending notifications remain loadable. Any repeat-failure guard responds to actual lack of progress rather than limiting useful build work arbitrarily.

## ChatGPT Response Notifier → Workstream 4/5 — Reliable Background Automation → Stage 3/3 — Workstation Acceptance and Release → Step 1/1 — Prove the complete background workflow → Gate 1/1 — Exact-source browser and helper evidence supports release acceptance

- Task 1/3 — Pass component/architecture tests and Windows helper/installer build validation on the exact candidate. **Complete on Glass for current exact PR #33 head 4c0a2e541436d91601a720bcc2bc8a5d5b8d6389 in run 34705686795; architecture/behavior tests, helper/Setup build, isolated Setup/helper handshake, and candidate upload all passed.**
- Task 2/3 — Verify real Chrome: inactive/minimized tab, duplicate tabs, SPA navigation, user input, delayed/rejected continuation, helper restart, extension update in a running tab, and freeze/resume. **Pending exact installed-candidate/live-browser proof; covered together with Workstream 5 Stage 4 Task 2.**
- Task 3/3 — Verify non-activating notifications with another app/fullscreen game in front, publish the reviewed bundle through the normal updater, and record actual installed identity and any remaining subjective acceptance. **Pending; covered together with Workstream 5 Stage 4 Task 3.**

Acceptance: distinguish source tests, built artifacts, installed versions, and live behavior. No synthetic live ChatGPT DOM or forced backend failures are used to manufacture acceptance. Deterministic fixtures belong in offline/component tests. Human perception is requested only where it cannot be established automatically.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 1/4 — Retain the Contract → Step 1/1 — Preserve and verify footer obligations → Gate 1/1 — Applicable final replies are checkable across long-chat continuation

Purpose: a long-running GitHub/build conversation retains the terminal-footer obligation even through assistant-authored summaries, handoffs, and resumed execution, while ordinary conversation and intermediate progress remain untouched.

- Task 1/3 — Reconcile the actual installed extension/helper source identity and current PR #33 before changes; carry forward existing validated coordinator work. **Complete for source identity. Installed v0.9.0 identity remains explicitly unverified, so no workstation mutation is inferred or repeated.**
- Task 2/3 — Amend the canonical policy and compact entry contract with applicability retention, summary/resume capsule, tool-free final check, bounded format-repair semantics, and early current-run scope recognition. **Complete. Retention/final-check semantics merged through DevelopmentInfrastructure PR #410; the non-terminal `[GITHUB_WORK: START]` extension and semantic digest `9c60a07bc26b639c15a6456b08707c2e92fa06fe98baa21b6b731b3f9dda4cd1` merged through PR #423 at merge commit 61626a56c87ea50e6369c1dfe98892358962da08. The seven terminal status meanings remain unchanged.**
- Task 3/3 — Add a versioned contract/grammar fixture plus parity checks and long-conversation/compaction evaluation cases. Measure omissions and wrong classifications separately; passing examples are not a universal model guarantee. **Complete in PR #33 and revalidated with the START grammar on exact-source Glass run 34705686795.**

Acceptance: the existing seven meanings are unchanged; ordinary chat and progress updates do not gain terminal footers; instructed long-chat handoffs carry the applicability capsule; START is non-terminal and exact-line scoped; missing, wrong, quoted, duplicate, and malformed final-footer cases are explicit and testable.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 2/4 — Observe Every Pending Request → Step 1/1 — Track build requests until a visible outcome → Gate 1/1 — Missing codes, delay, error, and silence are distinguishable

Purpose: once current substantive GitHub/build work is positively recognized by fresh assistant/request evidence—or manually provisioned before the first recognizable signal—persist the human-originated request and keep the combined automation state observable until it reaches a coded result, verified continuation, visible waiting state, explicit Pause, or attention state.

- Task 1/3 — Add persistent combined automation enrollment and original-request/run identity, including provisional pre-conversation enrollment, automatic current-run recognition, sticky operator Pause, and request-generation-safe finalization. **Complete in the PR #33 candidate. Monitoring and bounded recovery now share the same authoritative state.**
- Task 2/3 — Implement the versioned UI/request observer and classification table, preserving raw upstream detector bytes. Start in observation-only mode for live acceptance. **Complete in the PR #33 candidate; the upstream detector remains unchanged. START recognition delegates exact grammar to the shared status parser and requires fresh request evidence.**
- Task 3/3 — Add bounded reason diagnostics and a separate deduplicated `attention.required` event, reusing helper persistence/ACK and preserving the rolling 20 coded-result history. **Complete in the PR #33 candidate and deterministically validated on Glass. Closing a tab/window is explicitly quiet and cannot itself create or revive close-derived attention.**

Acceptance: ordinary non-build conversations are untouched; positively recognized current build work enables monitoring/recovery together unless explicitly paused; quoted/history/error text is ignored; legitimate thinking/tool activity never becomes an automatic retry merely because time passed; missing/no-answer cases reach a visible state; manual tab/window closure does not produce a false needs-attention event.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 3/4 — Recover Within a Budget → Step 1/1 — Reconcile before refresh or continuation → Gate 1/1 — Every automatic action is owned, bounded, and cancellable

Purpose: recovery is an extension of the existing durable coordinator, not a retry loop. Every reload, continuation, or format repair consumes persisted budget tied to the original trusted human run.

- Task 1/3 — Add the durable incident/run budget, shared rate-limit breaker, earliest-deadline alarm, restart reconstruction, manual-stop/draft/upload vetoes, and a single authoritative operator Pause. **Complete in the PR #33 candidate.**
- Task 2/3 — Add one background reload with post-hydration reconciliation, followed only when appropriate by one guarded continuation or format repair. **Complete in the PR #33 candidate; action admission also requires combined automation to remain enabled.**
- Task 3/3 — Prove concurrency, crash windows, uncertain Send, late responses, repeated limits, identity changes, sleep/clock changes, closed/frozen/discarded tabs, and duplicate-tab closure cannot reset budgets or replay actions. **Complete deterministically in the PR #33 candidate; exact-source Glass run 34705686795 passed the unified automation behavior suite plus existing bounded-recovery coverage.**

Acceptance: no code path can create an unbounded action chain; no reload/Send occurs on uncertain state or explicit Pause; no automatic foregrounding or ChatGPT fetch/polling is introduced; stale finalization cannot remove the next pending request; closure-derived state remains quiet.

Validated safety defaults: 30-second stable-terminal/error grace; silent stop only after at least 90 seconds confirmed idle with two consistent inspections at least 30 seconds apart; 15-minute ambiguous-thinking diagnostic without forced retry; per incident at most one reload, one continuation, and one format repair with at most two automatic messages; one automatic Send/reload admission profile-wide at a time with at least 30 seconds between admissions; a persisted 12-generation-producing-action ceiling for the entire human-started run; budgets reset only by a genuinely new trusted human request or explicit operator resume.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 4/4 — Prove and Roll Out → Step 1/1 — Validate the real background workflow → Gate 1/1 — Exact-source evidence supports enabling recovery

- Task 1/3 — Add deterministic behavioral/state-machine tests, including 100+ synthetic continuation cycles, fixture-based blockers, simultaneous chats, helper outbox/restart migration, unified automation state, sticky Pause, START recognition, quiet close, duplicate-tab ownership, and control revision conflicts. Verify automatic action count never exceeds its configured bound. **Complete. Exact PR #33 head 4c0a2e541436d91601a720bcc2bc8a5d5b8d6389 passed Glass run 34705686795, including all 58 architecture/behavior tests, Windows helper/Setup build, isolated Setup/helper localhost acceptance, and exact candidate upload. Artifact 10301825235 is bound to that head; candidate ZIP SHA-256 is 4bda7f0d17aafaa9870c82246870c63dc60b2e75860eb05fd7a637e98e0d0e42 and candidate Setup SHA-256 is 50434a2daf8b29acda07636be2f9d00e72d211fc7ef944176aa097fbb828d0c6.**
- Task 2/3 — Run observation-only acceptance on the real supported ChatGPT modes, then one recognized/enabled build chat with bounded actions. Record adapter coverage, false stalls, recovery success, combined-control behavior, quiet-close behavior, sticky Pause, and exact extension/helper/Chrome versions. Do not create repeated real server failures or usage-limit probes to manufacture test coverage. **Pending exact installed-candidate/live-browser proof.**
- Task 3/3 — Prove foreground-window/tab identity stays unchanged with other work/fullscreen activity, release through the existing exact-source updater, verify installed identity, and document rollback/disable controls and remaining limits. **Pending after Task 2 live acceptance. The release workflow is already hardened to the repository-scoped Glass runner and its disposable Setup cleanup cannot stop the live notifier helper.**

Acceptance: source tests, live UI evidence, and installed state remain distinct. Unknown UI versions fail to observation/attention. Productive long builds calibrate grace periods and the final run ceiling before broad enablement.

## State contract and implementation boundaries

- Browser observations carry conversation URL/ID, document identity, prompt/assistant identity, and a response revision. The worker rejects a changed identity before any action.
- A transactional IndexedDB record owns each eligible turn. Persist any action claim before clicking; a worker restart may reconcile it but must not grant an automatic second click.
- One authoritative automation enrollment controls monitoring and bounded recovery together. A fresh exact assistant-authored `[GITHUB_WORK: START]` tied to current request evidence, or a newly completed valid terminal status as fallback, can recognize and enable current build work. Manual provisional enrollment can cover a brand-new chat before that signal exists. Historical/quoted/user/tool markers and repository-like words do not authorize action. Explicit operator Pause is sticky and wins over START, codes, restart, reload, and new requests until Resume.
- Persist the human-originated request/run identity before waiting for assistant output so a no-answer stall remains observable.
- The DOM adapter reads status without side effects and accepts separately authorized narrow actions. It verifies identity, combined automation state, and safety guards again immediately before any Send or background reload.
- Completion requires a matching new user message plus observed generation/progress or reconciled request evidence. A cleared composer, HTTP acceptance, optimistic UI, or elapsed time alone is insufficient.
- Notifications use a persistent outbox and stable IDs. The helper persists before acknowledging and remembers accepted IDs after dismissal. Coded history remains the rolling 20 eligible notifications; recovery attention has a separate bounded view.
- A frozen/discarded/unknown page is paused and surfaced as attention when appropriate. It never authorizes blind activation, reload, or Send. Deliberate tab/window closure is instead a quiet detach/owner-transfer lifecycle event and does not itself raise attention.
- Manual Stop, draft/upload presence, authentication/approval requirements, offline state, rate-limit state, and explicit operator Pause veto automatic recovery as defined by Workstream 5.
- Preserve the seven-code contract, upstream detector, existing rollback, loopback-only helper, verified updater, and per-user/windowless deployment. No ChatGPT API polling, authentication access, custom ChatGPT HTTP calls, or new privileged component.

## Current continuation point

Active implementation point: **ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 4/4 — Prove and Roll Out → Step 1/1 — Validate the real background workflow → Gate 1/1 — Exact-source evidence supports enabling recovery → Task 2/3 — Run observation-only and one recognized/enabled bounded-recovery live ChatGPT acceptance pass.**

Canonical shared policy now includes START and is merged through DevelopmentInfrastructure PR #423 at 61626a56c87ea50e6369c1dfe98892358962da08. Exact-source deterministic validation is green on the registered repository-scoped Glass runner for PR #33 head 4c0a2e541436d91601a720bcc2bc8a5d5b8d6389 in run 34705686795, with candidate artifact 10301825235. Installed v0.9.0 identity remains unproven; no release or workstation installation is implied by source/build success. The next boundary is real installed-browser acceptance, not more synthetic failure generation.
