# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. Source authority: this repository. Work ownership: [DevelopmentInfrastructure #283](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/283). Design/rollout tracking: [#32](https://github.com/thatoneguydan/chatgpt-response-notifier/issues/32), [#34](https://github.com/thatoneguydan/chatgpt-response-notifier/issues/34), and draft [PR #33](https://github.com/thatoneguydan/chatgpt-response-notifier/pull/33).

## Current roadmap checkpoint — 2026-09-12

The unified build-automation amendment is implemented without changing roadmap numbering. Monitoring and bounded recovery share one authoritative state/control; operator Pause is sticky; current build work can be recognized by canonical non-terminal `[GITHUB_WORK: START]` plus fresh request evidence with valid-terminal-code fallback; command writes are revision/request-ID/readback verified; blank-chat manual enrollment is provisional; ordinary tab/window closure is quiet; and existing budgets/identity/user-safety gates remain in force.

Live workstation correlation proved Dan's installed v0.9.0 was source `bdcea39eaba9b960ce3579016c9b1308585d5e8b`, not the then-validated candidate. The first exact-candidate Setup attempt exposed a same-version replacement defect: Setup copied `Host\0.9.0\ChatGPTResponseNotifier.Host.exe` before stopping the running helper at that same path, so Windows could reject the overwrite and silent Setup exited 1. The installer now stops the path-scoped existing helper before copying the new payload. Glass validation was extended to install the same candidate twice into one isolated root while the first helper is running, then verify exact `install-state.json` source identity and localhost helper handshake. The release gate mirrors this regression proof.

This repair remains inside **ChatGPT Response Notifier → Workstream 5/5 → Stage 4/4 → Step 1/1 → Gate 1/1 → Task 2/3** as prerequisite work for live browser acceptance. No public release or PR merge is authorized by deterministic proof alone.

## Structure and predecessor work

| Workstream | Scope |
| --- | --- |
| Workstream 1/5 — Foundation and Conversation Identity | Completion sensor, stable chat routing, loopback helper protocol. |
| Workstream 2/5 — Native Toast UX | Persistent stacked non-activating notifications and deliberate dismissal. |
| Workstream 3/5 — Installation, Release, and Acceptance | Per-user installer, managed updater, rollback, installed identity. |
| Workstream 4/5 — Reliable Background Automation | Durable per-turn ownership, guarded continuation, durable delivery/outbox. |
| Workstream 5/5 — Status Contract and Bounded Recovery | Contract retention, current-run recognition, monitoring, bounded recovery, rollout proof. |

## ChatGPT Response Notifier → Workstream 4/5 — Reliable Background Automation → Stage 1/3 — Coordinated Continuation → Step 1/1 — Own and verify each continuation → Gate 1/1 — One matching continuation or explicit fallback

- Task 1/3 — Publish roadmap/state contract. **Complete.**
- Task 2/3 — Transactional turn ownership, read-only observation, separately authorized DOM action, strict chat/document/turn identity, active-user/draft safeguards. **Complete.**
- Task 3/3 — Prove duplicate claims, failed/uncertain sends, navigation, user intervention, restart reconciliation. **Complete deterministically; live-browser proof is retained in Workstream 5 Stage 4.**

Acceptance: only eligible `INCOMPLETE_LIMIT` can request the exact continuation text. Unknown post-click outcomes never grant a second automatic send. The original upstream completion detector remains byte-for-byte unchanged.

## ChatGPT Response Notifier → Workstream 4/5 — Reliable Background Automation → Stage 2/3 — Reliable Delivery and Recovery → Step 1/1 — Preserve each unresolved outcome → Gate 1/1 — Restart and reconnection cannot silently lose or replay work

- Task 1/3 — Durable notification outbox, stable IDs, helper persistence acknowledgment, dismissal/restart deduplication. **Complete.**
- Task 2/3 — Unified finalization and version-aware runtime attachment; preserve frozen/discarded pending state without activation/replay. **Complete.**
- Task 3/3 — Prove crash/reconnect/replay, old pending migration, rolling 20 history, runtime attachment and diagnostics. **Complete deterministically.**

Acceptance: queue removal requires durable helper ACK; delayed/duplicated events cannot reopen dismissed notifications; successful continuation remains quiet.

## ChatGPT Response Notifier → Workstream 4/5 — Reliable Background Automation → Stage 3/3 — Workstation Acceptance and Release → Step 1/1 — Prove the complete background workflow → Gate 1/1 — Exact-source browser and helper evidence supports release acceptance

- Task 1/3 — Exact candidate component/architecture tests and Windows helper/installer build validation. **Complete for the current source line. Glass now also proves same-version in-place replacement while the old helper is running.**
- Task 2/3 — Real Chrome: inactive/minimized tab, duplicate tabs, SPA navigation, user input, delayed/rejected continuation, helper restart, extension hot attachment/update, freeze/resume. **Pending; covered with Workstream 5 Stage 4 Task 2.**
- Task 3/3 — Non-activation with another app/fullscreen game in front, exact-source updater publication, final installed identity and remaining subjective acceptance. **Pending; covered with Workstream 5 Stage 4 Task 3.**

Acceptance: source, built artifact, installed state and live behavior are separate evidence layers.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 1/4 — Retain the Contract → Step 1/1 — Preserve and verify footer obligations → Gate 1/1 — Applicable final replies are checkable across long-chat continuation

- Task 1/3 — Reconcile installed extension/helper source identity and PR #33. **Complete. Live read-only evidence identified installed v0.9.0 source `bdcea39eaba9b960ce3579016c9b1308585d5e8b`; this is older than the unified-control candidate and established the need for exact-candidate replacement.**
- Task 2/3 — Canonical applicability retention, compact carry-forward capsule, tool-free final check, bounded footer repair, and early current-run scope recognition. **Complete. DevelopmentInfrastructure PR #410 retains terminal contract; PR #423 merged canonical `[GITHUB_WORK: START]` at `61626a56c87ea50e6369c1dfe98892358962da08`. Seven terminal meanings are unchanged. Semantic digest `9c60a07bc26b639c15a6456b08707c2e92fa06fe98baa21b6b731b3f9dda4cd1`.**
- Task 3/3 — Versioned grammar fixture/parity and long-conversation compaction cases. **Complete deterministically.**

Acceptance: START is non-terminal and exact-line scoped; quoted/list/code/tool/history near-misses do not establish current scope.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 2/4 — Observe Every Pending Request → Step 1/1 — Track build requests until a visible outcome → Gate 1/1 — Missing codes, delay, error and silence are distinguishable

- Task 1/3 — Combined automation enrollment and original human-run identity, provisional blank-chat enrollment, automatic current-run recognition, sticky Pause. **Complete.**
- Task 2/3 — Versioned UI/request observer and classifier while preserving raw upstream detector bytes. **Complete.**
- Task 3/3 — Bounded diagnostics and separate deduplicated `attention.required`, rolling 20 coded history, quiet close lifecycle. **Complete deterministically.**

Acceptance: ordinary non-build conversations remain untouched; current build scope requires fresh evidence; manual tab/window closure itself creates no needs-attention notification.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 3/4 — Recover Within a Budget → Step 1/1 — Reconcile before refresh or continuation → Gate 1/1 — Every automatic action is owned, bounded and cancellable

- Task 1/3 — Durable incident/run budget, rate-limit breaker, earliest alarm, restart reconstruction, draft/upload/manual-stop vetoes, authoritative Pause. **Complete.**
- Task 2/3 — At most one background reload followed only when appropriate by one guarded continuation or format repair. **Complete.**
- Task 3/3 — Prove concurrency, crash windows, uncertainty, late responses, repeated limits, identity changes, sleep/clock changes, duplicate/closed/frozen/discarded tabs cannot reset budgets or replay actions. **Complete deterministically.**

Validated safety defaults: 30-second stable-terminal/error grace; silent stop only after at least 90 seconds confirmed idle with two consistent inspections at least 30 seconds apart; 15-minute ambiguous-thinking diagnostic without forced retry; per incident at most one reload, one continuation, one format repair and two automatic messages; profile-wide serialized action admission with at least 30 seconds between actions; persisted 12-generation-producing-action ceiling per human-started run; reset only by a genuinely new trusted human request or explicit operator Resume.

## ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 4/4 — Prove and Roll Out → Step 1/1 — Validate the real background workflow → Gate 1/1 — Exact-source evidence supports enabling recovery

- Task 1/3 — Deterministic architecture/state-machine coverage: 100+ continuation cycles, blockers, simultaneous chats, outbox/restart, unified state, sticky Pause, START, quiet close/duplicate ownership, revision conflicts, and installer lifecycle. **Complete. The installer regression gate now explicitly performs two same-version installs into one isolated root while the first helper is running and requires exact source identity plus helper handshake after replacement.**
- Task 2/3 — Real supported ChatGPT acceptance: one recognized/enabled build chat with bounded actions; combined control; auto-recognition; sticky Pause/Resume; quiet close/duplicate ownership; inactive/minimized tab; SPA navigation; active-user/draft safeguards; helper restart; hot attachment/update; freeze/resume; adapter false-stall/recovery evidence; exact extension/helper/Chrome identity. **Pending exact repaired-candidate installation and live proof. Do not manufacture repeated server failures or usage-limit probes.**
- Task 3/3 — Prove no foreground/tab theft with normal work/fullscreen activity, merge/release through exact-source updater, verify installed identity, document rollback/disable controls and remaining limits. **Pending after Task 2.**

Acceptance: deterministic tests, live UI evidence and installed identity remain distinct. Unknown/unobservable states fail closed. Productive builds, not manufactured service failures, are used for live calibration.

## State contract and implementation boundaries

- Browser observations carry conversation URL/ID, document identity, prompt/assistant identity and revisions; identity changes veto action.
- IndexedDB owns eligible turns and persists claims before any side effect; restart reconciliation never grants blind replay.
- One authoritative automation state controls monitoring and bounded recovery together. Explicit Pause wins over START, codes, restart, reload and new requests until Resume.
- START must be a fresh exact assistant-authored current-request signal; newly completed valid terminal code is fallback recognition. User/tool/quoted/code/list/history markers do not authorize action.
- DOM status observation is read-only; narrow reload/Send actions are separately authorized and recheck identity/safety immediately before action.
- Completion requires matching new user turn plus passive request/progress evidence; clear composer, HTTP acceptance, elapsed time or optimistic UI alone is insufficient.
- Notifications use persistent outbox/ACK and stable IDs. Coded history remains rolling 20; recovery attention is separate.
- Frozen/discarded/unknown pages never authorize blind activation/recovery. Deliberate close is a quiet detach/duplicate-transfer lifecycle event.
- No ChatGPT API/session polling, auth access, custom ChatGPT HTTP calls, automatic foregrounding, Regenerate/original-prompt replay, auto-approval, or unbounded retry chain.
- Installer acceptance must support replacing a different source candidate that shares the same semantic version while the old helper is running. Isolated CI install cleanup remains path-scoped and may not stop the live notifier.

## Current continuation point

Active implementation point: **ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 4/4 — Prove and Roll Out → Step 1/1 — Validate the real background workflow → Gate 1/1 — Exact-source evidence supports enabling recovery → Task 2/3 — install the repaired exact candidate, verify installed source identity, then run real Chrome acceptance.**

Known live state before repaired-candidate installation: version `0.9.0`, source `bdcea39eaba9b960ce3579016c9b1308585d5e8b`, extension `C:\Users\dan\AppData\Local\ChatGPTResponseNotifier\Extension`, helper `C:\Users\dan\AppData\Local\ChatGPTResponseNotifier\Host\0.9.0\ChatGPTResponseNotifier.Host.exe`, Chrome `153.0.8010.37`. The first attempted candidate installer failed with exit code 1 because same-version helper replacement happened before helper shutdown. That defect is fixed and deterministically reproduced/proved on Glass. The next exact source/artifact is the post-roadmap-checkpoint PR #33 head produced after this commit; use its successful exact-head validation artifact for live installation. No public release or PR merge before Task 2 passes.
