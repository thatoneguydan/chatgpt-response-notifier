# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. Runtime owners: [DevelopmentInfrastructure #443](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/443) for installation and [#442](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/442) for click acceptance. Independent review: [#453](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/453), [implementation handoff](docs/INDEPENDENT-FAILURE-REVIEW-2026-09-16.md).

## Immediate priority — 2026-09-16

**Restore a durably loaded runtime, then complete recovery and click reliability before additional features.** Source-only recovery work can proceed in a separately claimed scope while #443 continues. Do not interrupt its helper/deployment lane. Physical acceptance requires a loaded extension.

The original unpacked notifier survives reboot on Glass. Chrome Web Store migration is **paused**; [Store preparation](docs/CHROME-WEB-STORE-DURABLE-DISTRIBUTION.md) is contingency. Earlier instructions making Store registration/payment the immediate step are superseded.

Current source is v0.9.29. PR #70 [run 35135642109](https://github.com/thatoneguydan/chatgpt-response-notifier/actions/runs/35135642109) verified helper restart and a three-record registration comparison, not extension restoration/reboot durability. Distinguish original, intended fork and legacy fork before interpreting the comparison.

Roadmap change: retain **5 workstreams**. Workstream 3 retains **1 stage / 4 steps**, replacing the Store-first sequence with comparison, evidenced repair, restart proof and behavior-acceptance readiness. The existing other workstreams now have explicit reliability gates. No runtime repair is claimed by this documentation update.

| Priority | Workstream | Immediate outcome |
| --- | --- | --- |
| 1 | Workstream 3/5 — Installation, Release, and Acceptance | Explain original/fork divergence; restore persistence; complete test discovery before the next behavior release. |
| 2 | Workstream 5/5 — Status Contract and Bounded Recovery | One request-owned error classifier with complete phrase/location coverage and safety vetoes. |
| 3 | Workstream 4/5 — Reliable Background Automation | Recovery survives progress text, hidden-page delays and actual reload without losing incident identity. |
| 4 | Workstream 1/5 — Foundation and Conversation Identity | Separately prove observation, notification and recovery across hidden-page states. |
| 4 | Workstream 2/5 — Native Toast UX | Bound click verification and pass physical cross-desktop acceptance. |

## Workstream 3/5 — Installation, Release, and Acceptance

Stage 1/1 — Restore and prove installation persistence. Owner: #443. Each step has Gate 1/1 as specified below.

| Step | Gate 1/1 | Tasks |
| --- | --- | --- |
| Step 1/4 — Compare original, intended and legacy fork | Same-profile comparison explains the first effective-loading divergence or precisely identifies the missing observation | Task 1/3: consume PR #70 evidence already available. Task 2/3: compare bounded effective loading/provenance and exact disable reasons for the three identities. Task 3/3: checkpoint the evidence-selected repair or one discriminating experiment. |
| Step 2/4 — Repair the evidenced boundary | Exact candidate preserves identity/root/rollback and complete regression coverage | Task 1/3: make validate/release run the same complete intended test discovery; 11 of 19 files were omitted at review. Task 2/3: implement only the proven repair through the owning lane. Task 3/3: validate and attach same-source installation/loading receipts. |
| Step 3/4 — Prove normal restart durability | Clean Chrome exit/reopen and Windows reboot/login retain the intended loaded extension and helper connection | Prepare pre/post identity, file and effective-runtime evidence; keep the original control intact. No re-registration may manufacture the pass. |
| Step 4/4 — Release the acceptance dependency | Installed version/source, extension runtime, helper bridge and test readiness agree | Route #442 and the background/recovery matrix to that exact candidate. Helper version alone is insufficient. |

Next implementation position: **ChatGPT Response Notifier → Workstream 3/5 → Stage 1/1 → Step 1/4 → Gate 1/1 → Task 2/3**, subject to current #443/#70 state. Existing Task 1 evidence should be reused. Do not speculatively remove the manifest key or delete a legacy registration. Store tooling from PR #67 remains contingency, not permission to migrate identity or publish now.

## Workstream 5/5 — Status Contract and Bounded Recovery

Stage 1/1 — Consistent request-owned error classification. Each step has Gate 1/1.

| Step | Gate 1/1 | Tasks |
| --- | --- | --- |
| Step 1/2 — Unify classifier and attribution | Same application error has equivalent meaning in current-turn UI and a request-owned global banner | Task 1/3: centralize phrase matching; cover Disconnected, Response interrupted and Response failed. Task 2/3: bind global UI to current request/incident freshness and preserve safety fields through projections. Task 3/3: verify current/historical/quoted/global fixtures and mixed safety/error-node permutations. |
| Step 2/2 — Verify decision boundaries | Only proven current-request failures become recovery candidates | Keep healthy reasoning indicators, old banners, quoted/tool/assistant prose, uncoded final answers, Stop, auth, approval, rate limits and drafts out of recovery. Test classification after serialization, compatibility augmentation and reload. |

Plain “Thinking longer” is insufficient failure evidence. A current request's systems/interruption message differs from healthy reasoning. Do not match every occurrence of thinking/error in transcript text.

## Workstream 4/5 — Reliable Background Automation

Stage 1/1 — Durable recovery from an interrupted run. Each step has Gate 1/1.

| Step | Gate 1/1 | Tasks |
| --- | --- | --- |
| Step 1/3 — Preserve interrupted-run evidence | Progress/START text or reload cannot erase a positively identified failed run | Task 1/3: separate last progress from proven final answer. Task 2/3: retain request failure/settlement, prompt revision, incident class and budget across document replacement; collect fresh safety checks. Task 3/3: drive an actual page-runtime reload fixture through attempts and one confirmed Continue. |
| Step 2/3 — Bound observation and scheduling | Page-timer delays and unavailable replies produce durable explainable states | Use worker-owned persisted deadlines/alarms for initial observations and admitted incidents; deadline-wrap inspection/injection; ignore late identity-mismatched replies. Distinguish unobservable from generation failure and reinspect safely on resume. |
| Step 3/3 — Prove finite recovery | Each required scenario ends in recovery, resumed work or a named stop reason | Use virtual-time/composed-module restart/reload tests. Preserve one Continue per incident and page-turn plus matching-request acceptance. Expose attempt count, next due time and veto/uncertainty reason through existing status/history surfaces. |

Preserve **3 silent-stop reloads**, **5 explicit-interruption reloads**, **5-minute surviving explicit retry spacing**, **1 recovery Continue per incident**, **at least 30-second profile spacing**, and **12 generation-producing actions per trusted human-started run**. New states do not reset budgets. Completion/resumed work cancels attempts. Ambiguous long-running requests never trigger forced retry.

## Workstream 1/5 — Foundation and Conversation Identity

Stage 1/1 — Trustworthy observation across page states. Each step has Gate 1/1.

| Step | Gate 1/1 | Tasks |
| --- | --- | --- |
| Step 1/2 — Complete the existing correlated trace | Each incident identifies its first missing boundary and action reason | Task 1/2: reuse v0.9.27 request/document/stream/page-query/lifecycle/helper evidence; add only missing recovery decisions. Task 2/2: distinguish absent runtime, absent attachment, stale/throttled page, frozen/discarded page, veto and delivery failure. |
| Step 2/2 — Accept hidden/background behavior | Each scenario independently proves observation, notification and recovery | Test foreground, inactive tab, unfocused/occluded, minimized and other Windows desktop; use disposable lifecycle controls for frozen/discarded cases. Retain the one v0.9.27 hidden notification as proof for that event only. |

Memory Saver exclusions prevent deactivation, not all hidden rendering/timer effects. Do not add dummy audio, focus tricks, launch flags or faster polling. Stream completion remains notification-only; the main-world stream observer is page-side and cannot guarantee execution in a frozen renderer.

## Workstream 2/5 — Native Toast UX

Stage 1/1 — Verified user-initiated click presentation. Owner: #442. Each step has Gate 1/1.

| Step | Gate 1/1 | Tasks |
| --- | --- | --- |
| Step 1/2 — Bound and verify the browser route | Click handling has an end-to-end deadline and truthful outcome | Task 1/3: deadline-wrap page probes/whole click and preserve target identity. Task 2/3: distinguish requested, visible, focused and unverified; hung/unavailable is not success. Task 3/3: deduplicate fallback per physical click, recheck user intent and retain failure/retry affordance until presentation is established. |
| Step 2/2 — Accept cross-desktop click on Glass | Correct conversation becomes visible/focused without hang, crash or registration loss | Use the exact loaded runtime; cover same desktop, minimized Chrome, duplicate conversation tabs, double-click, missing/unresponsive script and user focus change. Preserve original tab/window and no unsolicited focus. |

v0.9.28's fallback already tries the existing tab then opens the same URL in a new focused window if the original stays hidden. Successful `windows.create` does not prove its physical desktop. Keep native Win32 foreground/window enumeration retired.

## Retained defaults, behavior and evidence

- Status contract v2, passive missing footers, human-run recognition, guarded continuation, helper acknowledgement, deduplication and rollback remain authoritative.
- Rolling history of 20 notifications, timestamps and loopback transport remain preserved; an existing live runtime can attach tabs without manual F5.
- Initial silent-stop baseline: at least 90 seconds plus two observations 30 seconds apart. Long-thinking diagnostic: 15 minutes without forced retry. Missing-footer grace: 30 seconds; format-repair prompts: 0.
- Reset budgets only for a genuinely new trusted human request or explicit Resume.
- `docs/HIDDEN-WINDOW-*` retains historical evidence. #443 and PR #66 document the clone-control flaw; never reuse the real profile's external integrity-store basename for a clone.
- Review verification: all 19 existing extension test files passed locally, **256/256**. This does not replace Windows installation/physical acceptance; normal CI omitted 11 files.

Implementation proceeds from the [handoff](docs/INDEPENDENT-FAILURE-REVIEW-2026-09-16.md) after reconciling owners/heads. This review's documentation publication does not claim that runtime repair is complete.
