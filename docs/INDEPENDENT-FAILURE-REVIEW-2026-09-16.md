# Independent notifier failure review — 2026-09-16

Scope: investigate the four reported failures independently of the active implementation, checkpoint findings, prioritize bounded repairs, and stop before implementing them. Documentation owner: [DevelopmentInfrastructure #453](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/453). Runtime owners remain [#443](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/443) and [#442](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/442).

Reviewed source: [`93a86521334b02bb60bdeba3be1d32190041d8b2`](https://github.com/thatoneguydan/chatgpt-response-notifier/tree/93a86521334b02bb60bdeba3be1d32190041d8b2), v0.9.29. Re-fetch main and active PR heads before implementation. This audit performed no live Chrome operation, helper restart, deployment, implementation or workflow dispatch. It inspected existing evidence and ran isolated source probes plus the existing JavaScript suite.

## Assessment

Installation, observation, recovery decisions and click presentation are distinct failure boundaries. One browser setting, broader regex or distribution change cannot repair all four. Retain the useful architecture: observation of ChatGPT's own requests, request/document identity, durable extension coordination and the loopback Windows notification helper. Repair the boundaries below before adding features.

| Reported problem | Finding | Evidence limit |
| --- | --- | --- |
| Extension disappears after restart | Files/helper/persisted registration remained while intended runtime was absent. Original unpacked control survives. Latest comparison exposes a legacy mismatched fork ID sharing the root. | Recorded live evidence; exact reboot cause remains unknown. |
| Hidden/other-desktop tab is not observed | One hidden notification passed. Initial silent checks use page timers; production queries can wait without a deadline; frozen/discarded pages are deliberately vetoed. | Source-confirmed limits, not proof of which boundary failed in every live incident. |
| Error or silent stop is missed | Phrase coverage differs by UI position. Progress text excludes silent recovery. A new page loses in-memory request/idle state. | Phrase/policy gaps reproduced with synthetic DOM fixtures; actual reload transition still needs a composed fixture. |
| Cross-desktop click fails | Fallback accepts visibility without focus, returns primary success when probes fail, and has no deadline for a never-settling probe. | Source behavior reproduced; Windows desktop placement remains physical acceptance. |

## Installation: compare the real control and avoid unsupported exclusions

The active implementation's [PR #70](https://github.com/thatoneguydan/chatgpt-response-notifier/pull/70), head `787c299d4b4f34b440973aaded51a9e0c8ebbe7e`, produced [run 35135642109](https://github.com/thatoneguydan/chatgpt-response-notifier/actions/runs/35135642109), job `104927197640`. The safe log establishes helper update/restart 0.9.28 → 0.9.29 and these records, all in **Default / Secure Preferences**:

| Role | Extension ID | Location | Disable reasons | Existing root / manifest | Key-derived ID |
| --- | --- | --- | --- | --- | --- |
| Intended fork | `lciedmoiiapbgemklkpoadimhffaaaah` | 4 | 0 | Current stable fork root, readable v0.9.29 | Matches |
| Original control, Prompt-Bound Completion Alert | `omnikbipejdflnfjkppfdkkdhglepbam` | 4 | 0 | Other user-profile root, readable v1.0.8 | No manifest key; comparison not applicable |
| Legacy fork registration | `pbbmmjcakamllfpcglbhcpmbpegapgih` | 4 | 1 | Current stable fork root, readable v0.9.29 | Does not match |

Artifact `10462133860`, ZIP SHA-256 `7901af246a5f02b81d573e049dd8a5c2eb40eed86fd1448c7caa98af7e99538c`, holds the sanitized comparison. Retrieval into this audit environment returned HTTP 403. The specific legacy disable code and other artifact-only fields were not inspected; do not invent them. The safe summary above is directly supported by the job log.

`ChromeUnpackedControlComparisonEvidencePublisher.ReadCandidates` labels every non-target ChatGPT extension a control candidate. Distinguish original/intended/legacy: the old fork is not a second independent healthy control. The fixed key is not inherently defective, and a mismatched old registration may be ordinary residue from an identity migration. Neither establishes why the intended matching ID was absent.

Earlier evidence proves only that no tracked preference reset was recorded by that diagnostic. It does not eliminate every integrity/startup rejection path. A persisted entry and an idle or absent MV3 worker target also require interpretation against Chrome's effective installed/disabled/error state. Avoid turning absence of a diagnostic into proof that an entire class of causes is impossible.

`BundleInstaller.UpdateDirectoryPreservingRoot` already preserves the directory, retains rollback and copies the manifest last. Do not repeat that repair. `CopyExtensionDirectoryManifestLast` still overwrites individual files, so it is not a transaction across every Chrome read and concurrent writer. This is a conditional race hypothesis, not evidence of the reboot cause.

Next work under #443:

1. Read existing artifact fields for the three identities, including exact disable reasons and creation/provenance metadata. Do not rerun helper updates just to retrieve existing evidence.
2. Compare the original and intended fork's **effective** same-profile loading result through the existing bounded diagnostic route: installed, disabled, load error and absent are distinct. Record whether evidence is current or only persisted.
3. Run only the experiment selected by the first divergence. If identity history is implicated, reproduce the legacy/current transition in a disposable profile. If update timing is implicated, compare unchanged files, same-version update and changed-version update with bounded read/load receipts. Isolate external profile-integrity state; do not repeat the clone basename flaw documented in #443/PR #66.
4. Repair the proven property, preserving stable ID/root. If effective absence remains unexplained, name the one missing loading/rejection observation instead of inferring that Store distribution is required.
5. Prove Chrome exit/reopen and Windows reboot/login without re-registration. Store tooling stays contingency; no fee or publication action is the immediate next step.

## Observation: hidden, frozen and unavailable are different

Chrome [Memory Saver exclusions](https://support.google.com/chrome/answer/12929150?hl=en) prevent deactivation. [Timer throttling documentation](https://developer.chrome.com/blog/timer-throttling-in-chrome-88) describes separate hidden-page scheduling and visibility-dependent animation frames. [Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api) and the [Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs) distinguish hidden, frozen and discarded states; frozen pages cannot run ordinary timers/event handlers.

Glass's 14900K/64 GB desktop does not need a speculative hardware upgrade for these software boundaries. Available memory and a Memory Saver exception do not promise foreground-equivalent renderer execution. Do not diagnose battery-driven Energy Saver on this desktop without evidence.

Source boundaries:

- `monitor-script.scheduleStabilityChecks` uses page `setTimeout` for the initial 90-second and 30-second confirmations. Mutation publishing also uses page timers. They cannot compensate for a frozen page or markup ChatGPT has not produced.
- `bounded-recovery-background.scheduleEarliestWake` schedules already-created incidents; it does not independently establish the initial silent-stop evidence.
- `bounded-recovery-background.queryTabSnapshot`, `monitor-background.sendRequestPhase`, and `recovery-live-fix-background.ensureContentRuntime/inspectExplicitInterruption` await production messages/injection without explicit deadlines. A never-settling result need not become a bounded recovery outcome.
- `hidden-window-diagnostics-background.js` already races page queries against a two-second deadline and retains `page-query-deadline`. Reuse that pattern for production observation without treating a diagnostic deadline as generation failure.
- `response-stream-status-main` observes existing fetch/XHR responses inside the page. It can avoid waiting for final DOM paint, but still needs renderer execution. Stream status remains notification-only.
- Frozen/discarded checks intentionally block reload/attachment. Record unobservable and safely reinspect on resume; a timeout is not proof a remote operation stopped.

Repair direction: persist worker-owned observation deadlines and incident/request facts, bound read-only inspections/injections, ignore late replies after tab/document/prompt changes, and distinguish unobservable/resumed from failed. No foreground tricks, browser flags, dummy audio, API polling or automatic retries based only on missing heartbeat. Trace the first missing boundary through extension → request → page/stream → classifier → lease/action → helper receipt → toast/click.

## Recovery: reproduced phrase and state gaps

The probe reused the existing `current-request-error.behavior.test.mjs` DOM harness and loaded actual `status-code.js`, `status-policy.js`, `monitor-script.js` and `recovery-live-fix-content.js`. It supplied a settled current request, valid current prompt and semantic alert:

| Literal fixture text | In current turn | Outside turns, global banner |
| --- | --- | --- |
| Message delivery timed out | Detected | Detected |
| Disconnected | Missed | Detected |
| Response interrupted | Missed | Detected |
| Response failed | Missed | Missed |
| Taking longer than expected | Detected | Detected |
| Thinking longer | Not classified as failure | Not classified as failure |

These are representative fixtures, not verified exact strings from every current live ChatGPT UI. `monitor-script.interruptionFromText` has fewer variants than the compatibility parser; the latter's `fallbackApplicationState` skips **all** conversation turns and cannot fill the gap there.

The fallback also marked a global Disconnected fixture `current-request-global` while `requestPhase=unknown`. It verifies current page/prompt identity, but not the banner's causal relation to that request. Broader regexes alone retain this false-attribution risk. Its reverse scan returns the first matching node, so mixed global safety/error states can depend on node order. Aggregate safety vetoes before choosing a recoverable error.

`monitor-background.sanitizedSnapshot` drops `interruptionAttribution` and `applicationStateIdentityMatched`. Persisted monitor state and the raw bounded-recovery listener can disagree about whether an error outranks a stale Stop button. Preserve these bounded fields and test serialization; this does not establish that every raw-message recovery is blocked.

Policy probes also loaded the actual recovery model. With settled request, stable assistant text and even two supplied idle confirmations:

- empty assistant → `silent-stop-confirmed`, reload candidate;
- progress containing START → `status-missing-passive`, no recovery;
- partial assistant answer → `status-missing-passive`, no recovery.

The page code is stricter: any `assistantKey` prevents silent confirmations. A work chat commonly posts commentary before failing, so “no final answer” and “no assistant text” need different states. Preserve completed uncoded answers as passive. Only a positively identified failed/ended-without-final current run enters interrupted-progress recovery; healthy reasoning/tools and ambiguous completion remain diagnostic-only.

Reload gap: a new monitor initializes `requestPhase=unknown`, empty request timestamps and zero confirmations. Its silent timer requires completed/error, while reloading a saved conversation need not emit the original generation POST. `recovery-model.postReloadDecision` then maps absent confirmations to `post-reload-outcome-ambiguous`. The current post-refresh fixture supplies confirmations rather than deriving them from a newly initialized monitor. This is a source-derived transition gap requiring a composed reload fixture, not a reproduced live root cause.

Implementation contract:

1. One phrase classifier with current-turn/global-request attribution and quote/prose/tool exclusions.
2. Retain failed request/interrupted-progress evidence, prompt revision, incident class and spent budget across document replacement; collect fresh page safety checks.
3. Schedule bounded fresh inspections in the worker. Inspection timeouts must not hold an operation forever. An uncertain Send stays non-replayable and uses the existing breaker semantics.
4. Cancel attempts on completion/resumed work, changed prompt, Stop, draft/upload, auth/approval/rate limit or uncertain action.
5. Preserve three silent-stop reloads; five explicit-interruption reloads with five-minute surviving-retry spacing; one canonical timestamped Continue per incident. Confirm both the new page user turn and matching request acceptance.

## Click: request acceptance is not presentation proof

The existing cross-desktop wrapper calls the primary browser route, checks the page up to eight times with 100 ms spacing, then creates a focused window if the original remains hidden. Preserve direct-click-only navigation and the original tab/window.

Actual-source probes using the existing click harness showed:

| Probe | Result |
| --- | --- |
| Visible page, `hasFocus=false` | Returns true; emits `cross-desktop-focus-visible`; no fallback |
| Probe rejects/unavailable | Returns primary true; emits verification unavailable; no fallback |
| `executeScript` never settles | Entire call remains pending, with no per-probe deadline |

`service-worker.focusOrOpenConversation` dismisses the conversation toast and emits navigation-complete before wrapper verification. A fixed attempt count is not a wall-clock limit when one awaited call never returns.

Repair: per-probe and whole-click deadlines; requested/visible/focused/unverified outcomes; failure/retry affordance; one fallback per physical click; revalidated target and user intent; discard late responses. `tab.active` means selected within its own window, not proof that the user still wants that window. Multiple conversation copies must not cause verification to drift to another tab.

The [Windows API](https://developer.chrome.com/docs/extensions/reference/api/windows) describes focus requests but has no Windows virtual-desktop destination parameter. Current-desktop placement requires physical proof on Glass. A callback cannot substitute for that proof; keep native foreground/window enumeration retired.

## Why green tests have not settled the problem

Both `validate.yml` and `release.yml` explicitly run **8 of 19** test files. The omitted files are `click-route-source`, `cross-desktop-click.behavior`, `current-request-error.behavior`, `delivery-dedupe.behavior`, `delivery-reliability.behavior`, `explicit-interruption-precedence.behavior`, `hidden-window-diagnostics.behavior`, `request-completion-status-probe.behavior`, `response-stream-status.behavior`, `runtime-identity.behavior`, and `v0914-safety-regression` (directory `tests/extension`, suffix `.test.mjs`).

The audit ran the entire existing suite once: **256 passed, 0 failed, 0 skipped**, approximately 2.3 seconds. This does not refute the source gaps: some tests supply already-classified snapshots, post-reload confirmations or immediately successful APIs, bypassing the relevant boundary. No implementation or existing tests were changed.

Before the next behavior release, share deterministic test discovery between validation and release, record discovered/executed counts, and add the missing adversarial fixtures. Pass a sorted explicit file list on Windows rather than relying on shell wildcard expansion. Retain self-hosted compute and existing gates; do not delete tests to get green.

Layered hooks increase integration risk: bootstrap imports policy/model modules, compatibility wrappers intercept messages, query compatibility flattens snapshots, and late wrappers alter click/delivery behavior. Consolidate the relevant contracts incrementally and test their actual composition. The evidence does not call for a whole-extension rewrite.

## Acceptance matrix and continuation

| Scenario | Required result |
| --- | --- |
| Chrome restart; Windows reboot/login | Intended extension remains effectively installed/loaded and connected without re-registration; original control unchanged |
| Foreground, inactive, unfocused/occluded, minimized, other desktop | Independently attributed observation, notification and recovery; no unsolicited focus |
| Current/global errors; mixed safety/error nodes | Eligible current errors detected; safety flags retained; historical/quoted/unattributed UI never authorizes retry |
| Progress/START then positively failed run; empty failed run | Finite identity-bound reloads and at most one confirmed Continue; completed uncoded answer stays passive |
| Actual page reload or worker restart | Fresh page reconciles with persisted incident; no duplicate Send, budget reset or invented settlement |
| Hung/unavailable/frozen/discarded page | Bounded unknown/unobservable result and safe reinspection after resume |
| Cross-desktop click, double-click, duplicate tabs, changed user intent | Correct conversation visible/focused or explicit bounded failure; at most one fallback per click; original preserved |

Use synthetic/disposable fixtures for deterministic edges and one prepared Glass pass for reboot/desktop conditions requiring physical observation. Reuse v0.9.27 traces and existing receipts. Do not burden Dan with repeated exploratory commands or build another parallel diagnostic framework.

The investigation's direction is settled. Continue from [ROADMAP.md](../ROADMAP.md): existing #443 comparison/effective-loading work first, complete test discovery before another behavior release, then shared error attribution, durable interrupted-run observation and bounded click verification. Unknown live causes require the specific evidence branch above; this document does not claim a completed runtime fix.
