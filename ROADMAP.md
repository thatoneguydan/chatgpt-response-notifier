# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. Runtime owners: [DevelopmentInfrastructure #443](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/443) for installation and [#442](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/442) for click acceptance. Independent review: [#453](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/453), [implementation handoff](docs/INDEPENDENT-FAILURE-REVIEW-2026-09-16.md). Traffic-safety incident: [2026-09-17 rate-limit stop-ship](docs/RATE-LIMIT-INCIDENT-2026-09-17.md). Live traffic-safety acceptance: [2026-09-17 acceptance](docs/TRAFFIC-SAFETY-LIVE-ACCEPTANCE-2026-09-17.md).

## Immediate priority — 2026-09-17

**Profile/account-level traffic safety is accepted.** The extension was re-enabled after exact combined source `0b4d045c92accc62c7914b2c0bcf2b0a33a71741` passed the complete deterministic suite, protected deployment, read-only post-deploy verification, and read-only post-enable verification. Traffic-safety source is canonical on `main` through PR #83. Acceptance intentionally did not force a reload, send a synthetic Continue, or reproduce throttling.

The original **“too many requests” shortly after enablement** remains an unattributed incident: the notifier had a plausible automatic-action path, but the timing does not prove it was the sole cause. Future rate-limit evidence should be attributed from the persistent action ledger. Passive monitoring itself must remain traffic-inert; automatic page-affecting actions remain subject to the shared profile governor and persistent breaker.

Current version is v0.9.29. The accepted live runtime combines traffic safety with the distinct permanent `Extension-v2` persistence candidate. Clean Chrome Exit/reopen persistence has passed; only the Windows reboot/login portion of the installation acceptance gate is deferred under #443. Do not redeploy the older persistence-only candidate over live source `0b4d045...`, and do not advance normal release/versioning past the deferred reboot gate.

Chrome Web Store migration remains **paused**; [Store preparation](docs/CHROME-WEB-STORE-DURABLE-DISTRIBUTION.md) is contingency. Earlier instructions making Store registration/payment the immediate step remain superseded.

The reboot-era failure was traced to a stale same-root legacy registration rather than to unpacked extensions generally. PR #70 distinguished original control `omnikbipejdflnfjkppfdkkdhglepbam`, intended fork `lciedmoiiapbgemklkpoadimhffaaaah`, and legacy fork `pbbmmjcakamllfpcglbhcpmbpegapgih`. PR #73 reproduced the identity-changing `chrome.runtime.reload()` residue on Chrome 153. PR #79 then proved that the intended fixed ID can run from a distinct root without the stale same-root collision, and PR #80 implements permanent `Extension-v2` while preserving the old `Extension` root for rollback/evidence.

Roadmap retains **5 workstreams**. Workstream 4 Step 1 is now complete. Workstream 3 is accepted through clean Chrome restart, with only its physical Windows reboot/login portion deferred. Workstream 5 request-owned error classification continues independently under DevelopmentInfrastructure #470.

| Priority | Workstream | Immediate outcome |
| --- | --- | --- |
| 1 | Workstream 5/5 — Status Contract and Bounded Recovery | Complete one request-owned error classifier with full phrase/location coverage and safety vetoes. |
| 2 | Workstream 4/5 — Reliable Background Automation | Preserve positively identified interrupted-run evidence across reload/document replacement, under the accepted traffic governor. |
| 3 | Workstream 1/5 — Foundation and Conversation Identity | Prove observation and notification across hidden/background page states independently of recovery. |
| 4 | Workstream 2/5 — Native Toast UX | Bound click verification and pass physical cross-desktop acceptance. |
| Deferred physical gate | Workstream 3/5 — Installation, Release, and Acceptance | Finish Windows reboot/login persistence on the current combined live runtime, then release from that surviving state. |

## Workstream 3/5 — Installation, Release, and Acceptance

Stage 1/1 — Restore and prove installation persistence. Owner: #443. Each step has Gate 1/1 as specified below.

| Step | Gate 1/1 | Tasks |
| --- | --- | --- |
| Step 1/4 — Compare original, intended and legacy fork | Same-profile comparison explains the first effective-loading divergence or precisely identifies the missing observation | **Complete.** Task 1/3: consumed PR #70 evidence. Task 2/3: identified legacy same-root ID mismatch + exact `DISABLE_RELOAD` residue and Chromium startup path invalidation. Task 3/3: PR #73 reproduced the identity-changing reload mechanism on installed Chrome 153.0.8010.48. |
| Step 2/4 — Repair the evidenced boundary | Exact candidate preserves identity/root/rollback and complete regression coverage | **Complete through live load.** PR #72 repaired complete test discovery. PR #79 proved the distinct-root escape on installed Chrome. PR #80 implements permanent `Extension-v2`, preserves legacy `Extension`, and passed exact-head source/build/isolated-Setup/fresh-load validation. Protected deployment, normal Chrome `Load unpacked`, and read-only post-load verification passed without deleting the stale orphan or editing Chrome protected preferences. |
| Step 3/4 — Prove normal restart durability | Clean Chrome exit/reopen and Windows reboot/login retain the intended loaded extension and helper connection | **Chrome restart portion complete.** Normal Chrome Exit/reopen retained the extension and read-only verification passed. **Windows reboot/login portion deferred** until an ordinary safe restart is available. Test the current live combined source `0b4d045...`; no re-registration may manufacture the pass. |
| Step 4/4 — Release the acceptance dependency | Installed version/source, extension runtime, helper bridge and test readiness agree | After the Windows reboot/login gate passes, promote the exact surviving runtime/version and route #442 plus the remaining background/recovery matrix to that state. Helper version alone is insufficient. |

Next implementation position for this lane: **ChatGPT Response Notifier → Workstream 3/5 — Installation, Release, and Acceptance → Stage 1/1 — Restore and prove installation persistence → Step 3/4 — Prove normal restart durability → Gate 1/1 — Windows reboot/login portion.** This is a deferred physical boundary only; it does not park other notifier work. Preserve original control `omnikbipejdflnfjkppfdkkdhglepbam`, intended fork `lciedmoiiapbgemklkpoadimhffaaaah`, stale pref-only fork `pbbmmjcakamllfpcglbhcpmbpegapgih`, both roots, stable key and rollback. Do not directly edit Chrome Preferences/Secure Preferences, remove/re-register the intended fork, or use recurring CDP `loadUnpacked`.

## Workstream 5/5 — Status Contract and Bounded Recovery

Stage 1/1 — Consistent request-owned error classification. Each step has Gate 1/1.

| Step | Gate 1/1 | Tasks |
| --- | --- | --- |
| Step 1/2 — Unify classifier and attribution | Same application error has equivalent meaning in current-turn UI and a request-owned global banner | Task 1/3: centralize phrase matching; cover Disconnected, Response interrupted and Response failed. Task 2/3: bind global UI to current request/incident freshness and preserve safety fields through projections. Task 3/3: verify current/historical/quoted/global fixtures and mixed safety/error-node permutations. Owner: DevelopmentInfrastructure #470. |
| Step 2/2 — Verify decision boundaries | Only proven current-request failures become recovery candidates | Keep healthy reasoning indicators, old banners, quoted/tool/assistant prose, uncoded final answers, Stop, auth, approval, rate limits and drafts out of recovery. Test classification after serialization, compatibility augmentation and reload. |

Plain “Thinking longer” is insufficient failure evidence. A current request's systems/interruption message differs from healthy reasoning. Do not match every occurrence of thinking/error in transcript text.

## Workstream 4/5 — Reliable Background Automation

Stage 1/1 — Safe, durable recovery from an interrupted run. Each step has Gate 1/1.

| Step | Gate 1/1 | Tasks |
| --- | --- | --- |
| Step 1/4 — Prove profile/account-level traffic safety | Enabling, restarting or passively monitoring cannot create an automatic ChatGPT request burst; throttling evidence stops all automatic page actions persistently | **Complete.** PR #83 adds the shared traffic guard, fresh-current-runtime authorization, profile-wide five-minute floor, persistent rate-limit breaker, bounded action ledger, and serialized safety state. Exact implementation and combined `Extension-v2` candidate both passed the complete workflow matrix. Protected deployment plus post-enable read-only acceptance passed on Glass with no deliberate recovery action or throttling reproduction. Canonical evidence: `docs/TRAFFIC-SAFETY-LIVE-ACCEPTANCE-2026-09-17.md`; DevelopmentInfrastructure #473 is complete. |
| Step 2/4 — Preserve interrupted-run evidence | Progress/START text or reload cannot erase a positively identified failed run | Task 1/3: separate last progress from proven final answer. Task 2/3: retain request failure/settlement, prompt revision, incident class and budget across document replacement; collect fresh safety checks. Task 3/3: drive an actual page-runtime reload fixture through attempts and one confirmed Continue under the accepted profile governor. |
| Step 3/4 — Bound observation and scheduling | Page-timer delays and unavailable replies produce durable explainable states | Use worker-owned persisted deadlines/alarms for initial observations and admitted incidents; deadline-wrap inspection/injection; ignore late identity-mismatched replies. Distinguish unobservable from generation failure and reinspect safely on resume. |
| Step 4/4 — Prove finite recovery | Each required scenario ends in recovery, resumed work or a named stop reason | Use virtual-time/composed-module restart/reload tests. Preserve one Continue per incident and page-turn plus matching-request acceptance. Expose attempt count, next due time, governor state and veto/uncertainty reason through existing status/history surfaces. |

Next implementation position for this lane: **ChatGPT Response Notifier → Workstream 4/5 — Reliable Background Automation → Stage 1/1 — Safe, durable recovery from an interrupted run → Step 2/4 — Preserve interrupted-run evidence → Gate 1/1.** The extension may remain enabled. All automatic page-affecting actions must continue to pass the accepted shared traffic guard; rate-limit evidence remains a persistent veto.

Preserve **3 silent-stop reloads**, **5 explicit-interruption reloads**, **5-minute surviving explicit retry spacing**, **1 recovery Continue per incident**, and **12 generation-producing actions per trusted human-started run** only as inner incident/run ceilings. They are additionally constrained by the profile-wide traffic governor; new states, reloads and worker restarts do not reset either layer. Completion/resumed work cancels attempts. Ambiguous long-running requests never trigger forced retry. Passive mode must execute zero automatic reload/Send actions.

## Workstream 1/5 — Foundation and Conversation Identity

Stage 1/1 — Trustworthy observation across page states. Each step has Gate 1/1.

| Step | Gate 1/1 | Tasks |
| --- | --- | --- |
| Step 1/2 — Complete the existing correlated trace | Each incident identifies its first missing boundary and action reason | Task 1/2: reuse v0.9.27 request/document/stream/page-query/lifecycle/helper evidence; add only missing recovery decisions. Task 2/2: distinguish absent runtime, absent attachment, stale/throttled page, frozen/discarded page, veto and delivery failure. |
| Step 2/2 — Accept hidden/background behavior | Each scenario independently proves observation and notification | Test foreground, inactive tab, unfocused/occluded, minimized and other Windows desktop; use disposable lifecycle controls for frozen/discarded cases. Retain the one v0.9.27 hidden notification as proof for that event only. Any recovery exercised during acceptance must still pass the Workstream 4 Step 1 shared guard. |

Memory Saver exclusions prevent deactivation, not all hidden rendering/timer effects. Do not add dummy audio, focus tricks, launch flags or faster polling. Stream completion remains notification-only; the main-world stream observer is page-side and cannot guarantee execution in a frozen renderer.

## Workstream 2/5 — Native Toast UX

Stage 1/1 — Verified user-initiated click presentation. Owner: #442. Each step has Gate 1/1.

| Step | Gate 1/1 | Tasks |
| --- | --- | --- |
| Step 1/2 — Bound and verify the browser route | Click handling has an end-to-end deadline and truthful outcome | Task 1/3: deadline-wrap page probes/whole click and preserve target identity. Task 2/3: distinguish requested, visible, focused and unverified; hung/unavailable is not success. Task 3/3: deduplicate fallback per physical click, recheck user intent and retain failure/retry affordance until presentation is established. |
| Step 2/2 — Accept cross-desktop click on Glass | Correct conversation becomes visible/focused without hang, crash or registration loss | Use the exact loaded runtime; cover same desktop, minimized Chrome, duplicate conversation tabs, double-click, missing/unresponsive script and user focus change. Preserve original tab/window and no unsolicited focus. Automatic recovery is no longer globally paused, but click acceptance must not manufacture recovery traffic; any page-affecting recovery remains governed by Workstream 4 Step 1. |

v0.9.28's fallback already tries the existing tab then opens the same URL in a new focused window if the original stays hidden. Successful `windows.create` does not prove its physical desktop. Keep native Win32 foreground/window enumeration retired.

## Retained defaults, behavior and evidence

- Status contract v2, passive missing footers, human-run recognition, guarded continuation, helper acknowledgement, deduplication and rollback remain authoritative.
- Rolling history of 20 notifications, timestamps and loopback transport remain preserved; an existing live runtime can attach tabs without manual F5.
- Initial silent-stop baseline: at least 90 seconds plus two observations 30 seconds apart. Long-thinking diagnostic: 15 minutes without forced retry. Missing-footer grace: 30 seconds; format-repair prompts: 0.
- Reset incident/run budgets only for a genuinely new trusted human request or explicit Resume. Never reset the profile traffic governor or persistent rate-limit breaker merely because the worker, Chrome, helper or extension restarted.
- `docs/HIDDEN-WINDOW-*` retains historical evidence. #443 and PR #66 document the clone-control flaw; never reuse the real profile's external integrity-store basename for a clone.
- Complete-test gate: PR #72 made validation/release share deterministic discovery. The earlier 11-file omission is historical and closed; use the current exact-head suite rather than a hard-coded historical test count.
- Registration evidence: PR #73 is the identity-changing reload reproduction; PR #79 is the distinct-root proof; PR #80 is the permanent `Extension-v2` persistence candidate. Do not mutate the stale orphan directly as part of routine acceptance.
- Traffic-safety evidence: `docs/RATE-LIMIT-INCIDENT-2026-09-17.md` records the field incident and stop-ship contract; `docs/TRAFFIC-SAFETY-LIVE-ACCEPTANCE-2026-09-17.md` records the completed deterministic/live acceptance. Do not repeatedly reproduce throttling on the operator account as a diagnostic technique.
- Current live Glass source is `0b4d045c92accc62c7914b2c0bcf2b0a33a71741`, combining accepted `Extension-v2` persistence with canonical traffic safety. Canonical notifier `main` contains traffic safety; PR #80 remains open until the deferred Windows reboot/login gate closes.

Implementation proceeds from this roadmap after reconciling owners/heads. The traffic-safety stop-ship gate is closed. Continue from **ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 1/1 — Consistent request-owned error classification → Step 1/2 — Unify classifier and attribution → Gate 1/1** where #470 is active, or from **ChatGPT Response Notifier → Workstream 4/5 — Reliable Background Automation → Stage 1/1 — Safe, durable recovery from an interrupted run → Step 2/4 — Preserve interrupted-run evidence → Gate 1/1** when that separate scope is claimed. Keep **ChatGPT Response Notifier → Workstream 3/5 — Installation, Release, and Acceptance → Stage 1/1 — Restore and prove installation persistence → Step 3/4 — Prove normal restart durability → Gate 1/1 — Windows reboot/login portion** deferred until an ordinary safe restart is available.