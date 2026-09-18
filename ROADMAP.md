# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. Runtime owners: [DevelopmentInfrastructure #443](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/443) for installation and [#442](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/442) for click acceptance. Independent review: [#453](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/453), [implementation handoff](docs/INDEPENDENT-FAILURE-REVIEW-2026-09-16.md). Traffic-safety incident: [2026-09-17 rate-limit stop-ship](docs/RATE-LIMIT-INCIDENT-2026-09-17.md). Live traffic-safety acceptance: [2026-09-17 acceptance](docs/TRAFFIC-SAFETY-LIVE-ACCEPTANCE-2026-09-17.md).

## Immediate priority — 2026-09-17

**Workstream 5/5 — Status Contract and Bounded Recovery is complete in canonical source.** PR #88 unified request-owned application-error classification and decision boundaries; main contains it through `232aee039eced3080aec6a3879f75e6e28a01b3c`. DevelopmentInfrastructure #470 is complete.

**Workstream 4/5 — Reliable Background Automation is complete in canonical source.** PR #83 established profile/account traffic safety; PR #89 preserves interrupted-run evidence across document replacement; PR #90 moves authoritative observation deadlines into the worker; PR #91 proves finite recovery outcomes and exposes bounded recovery state. Canonical main contains the completed Workstream 4 source through `248675e4a940621cae3fb6fedd6678a84ce8892a`. DevelopmentInfrastructure #473, #474, #475 and #476 are complete.

**Profile/account-level traffic safety remains accepted.** The extension was re-enabled after exact combined live source `0b4d045c92accc62c7914b2c0bcf2b0a33a71741` passed the deterministic suite, protected deployment, read-only post-deploy verification and read-only post-enable verification. The original “too many requests” shortly after enablement remains unattributed; future rate-limit evidence should be attributed from the persistent action ledger. Passive monitoring must remain traffic-inert. All automatic page-affecting actions remain subject to the shared profile governor and persistent breaker.

Current installed version remains **v0.9.29**. The current loaded Glass acceptance candidate is `68ee2533a8a26568a8cfbf0cc4099edc70879b9f`: canonical main through the Workstream 1 cross-desktop completion repair plus the accepted PR #80 `Extension-v2` persistence lineage. Protected deploy and post-deploy verification passed, and operator Reload was independently proven by worker-runtime identity change. Do not advance normal release/versioning past the deferred Windows reboot/login acceptance gate under #443.

Chrome Web Store migration remains **paused**; [Store preparation](docs/CHROME-WEB-STORE-DURABLE-DISTRIBUTION.md) is contingency. Earlier instructions making Store registration/payment the immediate step remain superseded.

The reboot-era failure was traced to a stale same-root legacy registration rather than to unpacked extensions generally. PR #70 distinguished original control `omnikbipejdflnfjkppfdkkdhglepbam`, intended fork `lciedmoiiapbgemklkpoadimhffaaaah`, and legacy fork `pbbmmjcakamllfpcglbhcpmbpegapgih`. PR #73 reproduced the identity-changing `chrome.runtime.reload()` residue on Chrome 153. PR #79 proved that the intended fixed ID can run from a distinct root without the stale same-root collision, and PR #80 implements permanent `Extension-v2` while preserving the old `Extension` root for rollback/evidence.

Roadmap retains **5 workstreams**. **Workstream 1 is complete.** PR #93 completed the correlated trace; PR #95 moved the failed cross-desktop completion fallback onto worker-owned bounded post-request DOM inspection. The exact loaded candidate then passed foreground, same-desktop unfocused, minimized and another-Windows-virtual-desktop notification acceptance under DevelopmentInfrastructure #478. Workstreams 4 and 5 are also complete. Workstream 3 is accepted through clean Chrome restart with only its physical Windows reboot/login portion deferred. **Workstream 2 is now the active functional priority.**

| Priority | Workstream | Immediate outcome |
| --- | --- | --- |
| 1 | Workstream 2/5 — Native Toast UX | Bound click verification and replace the surprising duplicate-window outcome with a truthful user-controlled result; then pass physical cross-desktop click acceptance under #442. |
| Complete | Workstream 1/5 — Foundation and Conversation Identity | Correlated trace and hidden/background acceptance are complete through PR #95 / DevelopmentInfrastructure #478. |
| Complete | Workstream 5/5 — Status Contract and Bounded Recovery | Canonical request-owned error classifier and safety decision boundaries are complete through PR #88. |
| Complete | Workstream 4/5 — Reliable Background Automation | Traffic safety, durable interruption evidence, worker scheduling and finite recovery proof are complete through PR #91. |
| Deferred physical gate | Workstream 3/5 — Installation, Release, and Acceptance | Finish Windows reboot/login persistence on the accepted combined live runtime, then release from that surviving state. |

## Workstream 3/5 — Installation, Release, and Acceptance

Stage 1/1 — Restore and prove installation persistence. Owner: #443. Each step has Gate 1/1 as specified below.

| Step | Gate 1/1 | Tasks |
| --- | --- | --- |
| Step 1/4 — Compare original, intended and legacy fork | Same-profile comparison explains the first effective-loading divergence or precisely identifies the missing observation | **Complete.** PR #70 evidence identified the legacy same-root ID mismatch and exact `DISABLE_RELOAD` residue; PR #73 reproduced the identity-changing reload mechanism on installed Chrome 153. |
| Step 2/4 — Repair the evidenced boundary | Exact candidate preserves identity/root/rollback and complete regression coverage | **Complete through live load.** PR #72 repaired complete test discovery. PR #79 proved the distinct-root escape. PR #80 implements permanent `Extension-v2`, preserves legacy `Extension`, and passed source/build/isolated-Setup/fresh-load validation plus protected load verification. |
| Step 3/4 — Prove normal restart durability | Clean Chrome exit/reopen and Windows reboot/login retain the intended loaded extension and helper connection | **Chrome restart portion complete. Windows reboot/login portion deferred** until an ordinary safe restart is available. Test the current loaded combined source `68ee2533...`; no re-registration may manufacture the pass. |
| Step 4/4 — Release the acceptance dependency | Installed version/source, extension runtime, helper bridge and test readiness agree | After the Windows reboot/login gate passes, promote the exact surviving runtime/version and route #442 plus completed source work to that state. Helper version alone is insufficient. |

Next implementation position for this lane remains **ChatGPT Response Notifier → Workstream 3/5 — Installation, Release, and Acceptance → Stage 1/1 — Restore and prove installation persistence → Step 3/4 — Prove normal restart durability → Gate 1/1 — Windows reboot/login portion.** This is a deferred physical boundary only; it does not park other notifier work. Preserve original control `omnikbipejdflnfjkppfdkkdhglepbam`, intended fork `lciedmoiiapbgemklkpoadimhffaaaah`, stale pref-only fork `pbbmmjcakamllfpcglbhcpmbpegapgih`, both roots, stable key and rollback. Do not directly edit Chrome Preferences/Secure Preferences, remove/re-register the intended fork, or use recurring CDP `loadUnpacked`.

## Workstream 5/5 — Status Contract and Bounded Recovery

Stage 1/1 — Consistent request-owned error classification. **Complete.** Each step has Gate 1/1.

| Step | Gate 1/1 | Tasks |
| --- | --- | --- |
| Step 1/2 — Unify classifier and attribution | Same application error has equivalent meaning in current-turn UI and a request-owned global banner | **Complete.** PR #88 centralizes phrase matching for Disconnected, Response interrupted, Response failed, systems-delay, timeout and generation errors; global UI requires fresh current-request attribution; safety fields survive projections. DevelopmentInfrastructure #470. |
| Step 2/2 — Verify decision boundaries | Only proven current-request failures become recovery candidates | **Complete.** Healthy reasoning, historical/quoted/hidden errors, passive uncoded output, manual Stop, auth, approval, rate limits, drafts/uploads and identity mismatch remain outside automatic recovery. Coverage includes serialization, compatibility augmentation, restart and reload behavior. |

Plain “Thinking longer” is insufficient failure evidence. A current request's systems/interruption message differs from healthy reasoning. Do not match every occurrence of thinking/error in transcript text.

## Workstream 4/5 — Reliable Background Automation

Stage 1/1 — Safe, durable recovery from an interrupted run. **Complete in canonical source.** Each step has Gate 1/1.

| Step | Gate 1/1 | Tasks |
| --- | --- | --- |
| Step 1/4 — Prove profile/account-level traffic safety | Enabling, restarting or passively monitoring cannot create an automatic ChatGPT request burst; throttling evidence stops all automatic page actions persistently | **Complete.** PR #83 adds the shared traffic guard, fresh-current-runtime authorization, profile-wide five-minute floor, persistent rate-limit breaker, bounded action ledger and serialized safety state. Protected deployment plus post-enable read-only acceptance passed on Glass. Canonical evidence: `docs/TRAFFIC-SAFETY-LIVE-ACCEPTANCE-2026-09-17.md`; DevelopmentInfrastructure #473. |
| Step 2/4 — Preserve interrupted-run evidence | Progress/START text or reload cannot erase a positively identified failed run | **Complete.** PR #89 / main `a04a904d6fab4717a6a6fab029374428ba4ace3f` adds worker-owned bounded interruption evidence. The same failed request/assistant identity survives banner disappearance/document replacement while new requests, response identity changes, resumed work and current safety vetoes invalidate or suppress it. DevelopmentInfrastructure #474. |
| Step 3/4 — Bound observation and scheduling | Page-timer delays and unavailable replies produce durable explainable states | **Complete.** PR #90 / main `69db6d07ef19f6011993395ca5e1c09a3bd5412a` adds persistent worker-owned deadlines/alarms for missing-footer, silent-stop and long-thinking observations; local page queries are deadline-bounded; frozen/discarded/unresponsive pages defer as `page-unobservable`; stale identity replies are rejected. DevelopmentInfrastructure #475. |
| Step 4/4 — Prove finite recovery | Each required scenario ends in recovery, resumed work or a named stop reason | **Complete.** PR #91 / main `248675e4a940621cae3fb6fedd6678a84ce8892a` proves the finite state matrix without increasing limits: explicit failure ≤5 reloads + 1 recovery Continue, silent stop ≤3 reloads + 1 recovery Continue, restart uncertainty never replays, page-turn + matching-request acceptance remains required, whole-run cap remains 12, and profile governor/breaker holds remain authoritative. Existing Build automation status now exposes bounded attempt/due/governor/blocker metadata. DevelopmentInfrastructure #476. |

Preserve **3 silent-stop reloads**, **5 explicit-interruption reloads**, **5-minute surviving explicit retry spacing**, **1 recovery Continue per incident**, and **12 generation-producing actions per trusted human-started run** only as inner incident/run ceilings. They are additionally constrained by the profile-wide traffic governor; new states, reloads and worker restarts do not reset either layer. Completion/resumed work cancels attempts. Ambiguous long-running requests never trigger forced retry. Passive mode must execute zero automatic reload/Send actions. Timers may trigger local observation only; a page-affecting action still requires a fresh current-page identity/safety inspection immediately before admission.

## Workstream 1/5 — Foundation and Conversation Identity

Stage 1/1 — Trustworthy observation across page states. **Complete.** Each step has Gate 1/1.

| Step | Gate 1/1 | Tasks |
| --- | --- | --- |
| Step 1/2 — Complete the existing correlated trace | Each incident identifies its first missing boundary and action reason | **Complete.** PR #93 / main `984e93c52b177a275d72bc3c033d84b40de3b68a` preserves the existing request/document/stream/page/lifecycle incident and correlates bounded recovery decision/finish plus delivery outcome metadata. Named boundaries now distinguish runtime/attachment uncertainty, proven attachment failure, page-query deadline/error, frozen/discarded/page-frozen state, recovery veto/hold/uncertainty and delivery failure. DevelopmentInfrastructure #477. |
| Step 2/2 — Accept hidden/background behavior | Each scenario independently proves observation and notification | **Complete.** Fresh evidence isolated the cross-desktop miss to page-owned coded-status fallback after a successful request/stream completion. PR #95 adds bounded worker-owned post-request DOM status inspection. Exact loaded candidate `68ee2533...` passed same-desktop unfocused, minimized and another-Windows-virtual-desktop notification acceptance after worker Reload proof. Canonical checkpoint: `docs/BACKGROUND-OBSERVATION-ACCEPTANCE-2026-09-17.md`; DevelopmentInfrastructure #478 complete. |

Workstream 1 is complete. Its physical cross-desktop click result belongs to Workstream 2 and does not reopen observation acceptance.

Memory Saver exclusions prevent deactivation, not all hidden rendering/timer effects. Do not add dummy audio, focus tricks, launch flags or faster polling. Stream completion remains notification-only; the main-world stream observer is page-side and cannot guarantee execution in a frozen renderer.

## Workstream 2/5 — Native Toast UX

Stage 1/1 — Verified user-initiated click presentation. Owner: #442. Each step has Gate 1/1.

| Step | Gate 1/1 | Tasks |
| --- | --- | --- |
| Step 1/2 — Bound and verify the browser route | Click handling has an end-to-end deadline and truthful outcome | Task 1/3: deadline-wrap page probes/whole click and preserve target identity. Task 2/3: distinguish requested, visible, focused and unverified; hung/unavailable is not success. Task 3/3: deduplicate fallback per physical click, recheck user intent and retain failure/retry affordance until presentation is established. |
| Step 2/2 — Accept cross-desktop click on Glass | Correct conversation becomes visible/focused without hang, crash or registration loss | Use the exact loaded runtime; cover same desktop, minimized Chrome, duplicate conversation tabs, double-click, missing/unresponsive script and user focus change. Preserve original tab/window and no unsolicited focus. Click acceptance must not manufacture recovery traffic; any page-affecting recovery remains governed by completed Workstream 4 traffic safety. |

v0.9.28's fallback tries the existing tab first, then deliberately opens the same conversation URL in a new focused Chrome window if the original remains hidden. Fresh 2026-09-17 acceptance proved that this fallback can surface the conversation on the current desktop, but the operator rejected the duplicate/new-window UX: clicking the notification should not silently substitute a second window for the existing chat tab. Chrome's supported `windows` API can focus windows or create/move tabs, but exposes no Windows-virtual-desktop switch destination. Keep native Win32 foreground/window enumeration and undocumented virtual-desktop switching retired. Step 1 must make this limitation explicit in the result model and keep the toast/retry affordance until the user chooses any current-desktop fallback.

## Retained defaults, behavior and evidence

- Status contract v2, passive missing footers, human-run recognition, guarded continuation, helper acknowledgement, deduplication and rollback remain authoritative.
- Rolling history of 20 notifications, timestamps and loopback transport remain preserved; an existing live runtime can attach tabs without manual F5.
- Initial silent-stop baseline: at least 90 seconds plus two observations 30 seconds apart. Long-thinking diagnostic: 15 minutes without forced retry. Missing-footer grace: 30 seconds; format-repair prompts: 0.
- Reset incident/run budgets only for a genuinely new trusted human request or explicit Resume. Never reset the profile traffic governor or persistent rate-limit breaker merely because the worker, Chrome, helper or extension restarted.
- `docs/HIDDEN-WINDOW-*` retains historical evidence. #443 and PR #66 document the clone-control flaw; never reuse the real profile's external integrity-store basename for a clone.
- Complete-test gate: PR #72 made validation/release share deterministic discovery. The earlier 11-file omission is historical and closed; use the current exact-head suite rather than a hard-coded historical test count.
- Registration evidence: PR #73 is the identity-changing reload reproduction; PR #79 is the distinct-root proof; PR #80 is the permanent `Extension-v2` persistence candidate. Do not mutate the stale orphan directly as part of routine acceptance.
- Traffic-safety evidence: `docs/RATE-LIMIT-INCIDENT-2026-09-17.md` records the field incident and stop-ship contract; `docs/TRAFFIC-SAFETY-LIVE-ACCEPTANCE-2026-09-17.md` records the completed deterministic/live acceptance. Do not repeatedly reproduce throttling on the operator account as a diagnostic technique.
- Current loaded Glass source is `68ee2533a8a26568a8cfbf0cc4099edc70879b9f`, combining canonical main through cross-desktop notification repair PR #95 with the accepted PR #80 `Extension-v2` persistence lineage. Protected deploy, read-only installed-source verification and post-Reload worker identity proof passed. PR #80 remains open until the deferred Windows reboot/login gate closes; do not replace this loaded candidate with persistence-only historical source.

Implementation proceeds from this roadmap after reconciling owners/heads. Continue **ChatGPT Response Notifier → Workstream 2/5 — Native Toast UX → Stage 1/1 — Verified user-initiated click presentation → Step 1/2 — Bound and verify the browser route → Gate 1/1** under #442. The fresh cross-desktop click opened the designed duplicate/current-desktop Chrome window, which is presentation but not accepted UX. Do not reopen Workstream 1 or repeat its notification tests. Keep **ChatGPT Response Notifier → Workstream 3/5 — Installation, Release, and Acceptance → Stage 1/1 — Restore and prove installation persistence → Step 3/4 — Prove normal restart durability → Gate 1/1 — Windows reboot/login portion** deferred until an ordinary safe restart is available.