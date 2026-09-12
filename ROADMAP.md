# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. The active work is reliable background automation of coded build responses through the existing Chrome page and the Windows helper.

Source authority: this repository. Work ownership: [DevelopmentInfrastructure #283](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/283). Design evidence: [review #32](https://github.com/thatoneguydan/chatgpt-response-notifier/issues/32). The canonical status taxonomy remains in [DevelopmentInfrastructure](https://github.com/thatoneguydan/DevelopmentInfrastructure/blob/main/GITHUB-WORK-STATUS-POLICY.md).

## Structure and predecessor work

Roadmap change, 2026-09-12: Workstreams **3 → 4**. Add Workstream 4/4 — Reliable Background Automation. The original three workstreams retain their ordering; their denominators become /4. Their historical source is the [Glass roadmap](https://github.com/thatoneguydan/glass/blob/main/Tools/ChatGPT%20Response%20Notifier/ROADMAP.md). This document owns the current reliability work. Historical acceptance is not newly asserted by this change.

| Workstream | Scope retained |
| --- | --- |
| ChatGPT Response Notifier → Workstream 1/4 — Foundation and Conversation Identity | Existing completion sensor, stable chat routing, fixed local helper protocol. Native Messaging has since been replaced by loopback WebSocket. |
| ChatGPT Response Notifier → Workstream 2/4 — Native Toast UX | Persistent stacked windows, deliberate-interaction dismissal, quiet initial display, and desktop fit. |
| ChatGPT Response Notifier → Workstream 3/4 — Installation, Release, and Acceptance | Per-user installer, verified managed updates, and historical workstation acceptance. A published release is not proof of the installed version. |
| ChatGPT Response Notifier → Workstream 4/4 — Reliable Background Automation | The three stages below. |

## ChatGPT Response Notifier → Workstream 4/4 — Reliable Background Automation → Stage 1/3 — Coordinated Continuation → Step 1/1 — Own and verify each continuation → Gate 1/1 — One matching continuation or explicit fallback

Purpose: a completed coded turn has one durable owner. A status read cannot send text. Navigation, duplicate tabs, or an uncertain send cannot route an action to a different response or cause an automatic replay.

- Task 1/3 — Publish the roadmap and state contract. **Complete in this source checkpoint.**
- Task 2/3 — Implement transactional turn ownership, a read-only observation path, a separately authorized DOM action, strict chat/document/turn checks, and active-user/draft safeguards. **Pending.**
- Task 3/3 — Prove duplicate claims, failed/uncertain sends, navigation, user intervention, and restart recovery with behavioral tests. **Pending.**

Acceptance: only INCOMPLETE_LIMIT can request the exact continuation text. Clear input alone is never success. Ownership is persisted before action. Duplicate tabs cannot claim the same response. Unknown post-click outcomes produce a fallback notification, not a second send. An active user's input is preserved. The original upstream content-script.js remains byte-for-byte unchanged.

## ChatGPT Response Notifier → Workstream 4/4 — Reliable Background Automation → Stage 2/3 — Reliable Delivery and Recovery → Step 1/1 — Preserve each unresolved outcome → Gate 1/1 — Restart and reconnection cannot silently lose or replay work

Purpose: save notification intent before transport, acknowledge it only after helper persistence, and recover the same turn after worker/page/helper lifecycle changes.

- Task 1/3 — Add a durable notification outbox, stable event IDs, helper acknowledgment, and deduplication that survives dismissal/restart. **Pending.**
- Task 2/3 — Unify normal/recovery finalization, add version/runtime attachment checks, and preserve frozen/discarded pending state without activation or reload loops. **Pending.**
- Task 3/3 — Prove crash/reconnect/replay, migration of old pending toasts, 20-item history, runtime attachment, and bounded diagnostics. **Pending.**

Acceptance: queue removal requires durable helper acknowledgment. Notification and recovery records are not cleared by an unclassified upstream event. A delayed or duplicated message does not reopen a dismissed toast. Successful continuation stays quiet; compact action results remain diagnosable. Existing pending notifications remain loadable. Any repeat-failure guard responds to actual lack of progress rather than limiting useful build work arbitrarily.

## ChatGPT Response Notifier → Workstream 4/4 — Reliable Background Automation → Stage 3/3 — Workstation Acceptance and Release → Step 1/1 — Prove the complete background workflow → Gate 1/1 — Exact-source browser and helper evidence supports release acceptance

- Task 1/3 — Pass component/architecture tests and Windows helper/installer build validation on the exact candidate. **Pending.**
- Task 2/3 — Verify real Chrome: inactive/minimized tab, duplicate tabs, SPA navigation, user input, delayed/rejected continuation, helper restart, extension update in a running tab, and freeze/resume. **Pending.**
- Task 3/3 — Verify non-activating notifications with another app/fullscreen game in front, publish the reviewed bundle through the normal updater, and record actual installed identity and any remaining subjective acceptance. **Pending.**

Acceptance: distinguish source tests, built artifacts, installed versions, and live behavior. No synthetic live ChatGPT DOM or forced backend failures are used to manufacture acceptance. Deterministic fixtures belong in offline/component tests. Human perception is requested only where it cannot be established automatically.

## State contract and implementation boundaries

- Browser observations carry conversation URL/ID, document identity, prompt/assistant identity, and a response revision. The worker rejects a changed identity before any action.
- A transactional IndexedDB record owns each eligible turn. Persist a continuation claim before clicking; a worker restart may reconcile it but must not grant an automatic second click.
- The DOM adapter reads status without side effects and accepts a separate narrowly scoped continuation command. It verifies its identity and safety guards again immediately before Send.
- Completion requires a matching new user message plus observed generation/progress or the existing page request's outcome. A cleared composer alone and optimistic UI alone are insufficient.
- Notifications use a persistent outbox and stable IDs. The helper persists before acknowledging and remembers accepted IDs after dismissal. History remains the rolling 20 eligible notifications.
- A frozen/discarded page is paused. Do not activate/reload it as a substitute for background execution. Restore any temporarily changed lifecycle setting when pending work ends.
- Preserve the seven-code contract, upstream detector, existing rollback, loopback-only helper, verified updater, and per-user/windowless deployment. No ChatGPT API polling, authentication access, new foreground calls, or new privileged component.

## Current continuation point

Roadmap established; implementation begins with ChatGPT Response Notifier → Workstream 4/4 — Reliable Background Automation → Stage 1/3 — Coordinated Continuation → Step 1/1 — Own and verify each continuation → Gate 1/1 — One matching continuation or explicit fallback → Task 2/3 — Implement transactional ownership and guarded actions.

No new runtime acceptance or installed version is implied. Current published baseline is v0.8.1. Review and acceptance limits are preserved in #32.
