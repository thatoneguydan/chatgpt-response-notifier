# Notification-click hangs and recovery misclassification — Work handoff, 2026-09-14

## Resume here

Adopt [DevelopmentInfrastructure #283](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/283) and draft [notifier PR #33](https://github.com/thatoneguydan/chatgpt-response-notifier/pull/33). Fetch the current PR head and reconcile in-flight operations before changing anything.

**Reviewed application source:** `fedfa3bd45e64be33497fa64ccf7dde009f3aa92`, **v0.9.15**. This handoff/roadmap update changes documentation only. It does not produce a new application candidate or establish live acceptance.

**Requested boundary:** Dan asked Work to diagnose notification-click Chrome hangs/registration loss and incorrect status-code prompts, checkpoint findings, and stop when implementation becomes deterministic. Normal chat owns the repairs, targeted proof, candidate deployment and eventual live acceptance below. The native cause of the Chrome hang and second extension-registration loss remains unproven; the bounded evidence work is specified rather than replaced with a guessed cause.

**Position:** ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 4/4 — Prove and Roll Out → Step 1/1 — Validate the real background workflow → Gate 1/1 — Exact-source evidence supports enabling recovery → Task 4/5 — live acceptance, reopened for incident repairs/evidence. Existing Tasks 1/5–3/5 provide repair proof, evidence and guarded deployment. No roadmap denominator changes.

## Current identity and established evidence

- [Validation run 34864627861](https://github.com/thatoneguydan/chatgpt-response-notifier/actions/runs/34864627861) completed successfully for exact application source `fedfa3bd45e64be33497fa64ccf7dde009f3aa92`.
- Candidate artifact **10356358311**, ZIP digest `sha256:92b82109a858ceea0bb4f71b5739a8c813319e6dcd42cc46d3bb8d928377f1d2`.
- [Glass deployment run 34864866247](https://github.com/thatoneguydan/glass/actions/runs/34864866247), request PR Glass #130, succeeded. [Canonical deployment checkpoint](https://github.com/thatoneguydan/chatgpt-response-notifier/pull/33#issuecomment-5666805641) records installed v0.9.15/source exact, one healthy helper/listener, rollback available, extension identity deliberately deferred.
- Existing [evidence run 34864628834](https://github.com/thatoneguydan/chatgpt-response-notifier/actions/runs/34864628834), final job **104047566709**, artifact **10355739431**, completed at 2026-09-14T15:55:49Z. Its log says `safeInstalled=0.9.15; safeLoaded=0.9.13; liveRuntimeIdentity=True`, while the underlying collector says `ChromeRuntimeCapture=False`. That flag is not current browser liveness proof.
- Chrome's unpacked registration was last reported absent after the v0.9.13 incident/forced process termination. The old 0.9.13 self-report predates that loss. No evidence inspected here establishes a currently loaded 0.9.15 extension. The latest user report does not name a newer loaded version.
- [Work checkpoint](https://github.com/thatoneguydan/chatgpt-response-notifier/pull/33#issuecomment-5668509558) preserves the new source finding before this final handoff. The refreshed #283 claim passed [central registry validation 34879002745](https://github.com/thatoneguydan/DevelopmentInfrastructure/actions/runs/34879002745).

This investigation changed no application code, installed files, Chrome state or ChatGPT prompts. Existing run status/log evidence was read; repository checks may run automatically for the documentation commit, but any resulting artifact is not a new approved application candidate. The probes below executed unchanged JavaScript in an isolated in-memory context with controlled inputs; they are not full Chrome or Windows acceptance tests.

## What is already repaired

The [v0.9.13 incident record](https://github.com/thatoneguydan/chatgpt-response-notifier/pull/33#issuecomment-5666239306) records a valid BLOCKED_HUMAN result racing the missing-footer path by approximately four seconds. Each repair prompt created another generation/incident, so a per-incident repair cap did not prevent a repair-on-repair loop. Earlier v0.9.12 failures also involved a turn-embedded timeout excluded by the original monitor, missed activation-time recovery, and TOOL_FAILURE being treated as notification-only.

Current source has already:
- retired automatic missing-footer format repair and made status-missing passive;
- enabled the normal continuation text for both INCOMPLETE_LIMIT and INCOMPLETE_TOOL_FAILURE;
- kept BLOCKED_HUMAN and deliberate INCOMPLETE_HANDOFF terminal/non-continuing;
- republished pre-existing explicit interruptions when enabling automation;
- bounded explicit interruption recovery to one reload, then one normal continuation if the interruption remains;
- replaced the browser toast-click function with Chrome APIs;
- added startup removal of persisted status-missing attention and matching toast dismissal;
- preserved the stable extension key/ID and updated the installed extension directory in place.

Do not repeat the old v0.9.11 identity migration or infer that its earlier root-replacement defect explains the later v0.9.13 incident. Directory preservation is repaired in source; the second registration loss still needs evidence.

The startup composition matters: `background.js` imports `recovery-control-background.js`, which synchronously imports `recovery-live-fix-background.js` and `v0914-safety-background.js`. The latter wraps the global policy/model and schedules replacement of the later-defined service-worker click functions. Reading only `status-policy.js` or only the top-level import list gives an incomplete picture.

## Confirmed remaining misclassification: old/hidden error becomes current

**Source:** `extension/recovery-live-fix-content.js`, functions `detectExplicitInterruption()` and `augmentedSnapshot()`.

The detector scans semantic nodes across the entire document, uses `innerText || textContent`, and checks neither node visibility nor current-request ownership. It does not exclude assistant prose, quotations, code or tool content. A semantic-looking node is therefore insufficient evidence that the current request failed.

**Controlled reproduction on unchanged v0.9.15:**
- The document query returns an old-turn alert with empty innerText, textContent `Message delivery timed out. Please try again.`, hidden=true and no client rects.
- The base monitor snapshot identifies a different current request/document/assistant.
- The detector returns `explicitInterruption=true, interruptionKind=timed-out`.
- `augmentedSnapshot()` attaches that interruption to the current request.
- The actual parser, policy, recovery model and safety wrapper classify that augmented snapshot as `attention/timed-out` and select `kind=reload`.

This proves false attribution and recovery selection in controlled source execution, not that a reload occurred in Dan's browser. Enrollment, final identity, active-generation, draft/Stop/Pause and other vetoes still apply before a side effect. Valid terminal codes still win. The vulnerable case is an uncoded, idle current request that passes those guards.

### Deterministic repair

Use one current-request UI classifier for the main monitor and the compatibility observer. Replace the original monitor's blanket exclusion of every conversation turn; do not fix it by accepting every semantic node anywhere.

- Accept a visible application-owned error in the current user/assistant turn, including a real inline timeout.
- Exclude previous turns, detached/hidden nodes, sidebar/history content, and prose/code/quote/tool subtrees. Check element rendering/hidden ancestors; **do not require the browser tab to be visible or focused**, since recovery must work in background tabs.
- Treat a page-level alert as actionable only when it is reliably associated with this request. Ambiguous/global historical content is diagnostic-only.
- Preserve auth, approval and rate-limit vetoes before interruption recovery, including legitimate application error UI inside the current turn.
- Bind the result to conversation, prompt and browser document identity. The background compatibility query currently performs a separate interruption inspection without preserving the caller's document-target options; do not splice an unbound later observation into an earlier document's snapshot.
- Republish on enable/navigation using that same classifier and identity. Keep explicit-error precedence over missing footer, and never infer continuation eligibility from prose.

Required regressions: hidden old timeout; visible old-turn timeout; quoted/prose/tool timeout; genuine current inline timeout; current global alert with/without attributable identity; auth/rate-limit/approval inside a turn; SPA navigation during inspection; inactive tab; enable automation on an already-visible genuine error. Only genuine current failures may reach reload selection.

## Click-path containment is incomplete; Chrome root cause remains unknown

**Source:** `extension/service-worker.js`, `extension/v0914-safety-background.js`, `src/ChatGPTResponseNotifier.Host/NativeHostApplication.cs`, and `ChromeWindowForeground.cs`.

The current browser wrapper disables `requestNativeChromeForeground` and replaces `focusOrOpenConversation`. The helper still accepts `window.foreground` and calls native ShowWindow/BringWindowToTop/SetForegroundWindow on its WPF dispatcher. The unpatched service-worker function still sends that request. Safety import failure is caught with a warning and continues bootstrapping; the click replacement itself depends on a later timer.

This is a concrete remaining fallback path, not proof it ran during the user's incident. A JavaScript request timeout cannot cancel an already blocking native helper call. Microsoft's [ShowWindowAsync documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-showwindowasync) describes asynchronous show as avoiding caller unresponsiveness when the target is unresponsive. That supports removing synchronous cross-process foreground work; it does **not** prove Chrome itself was hung by the helper.

### Deterministic repair

- Put the Chrome-only click implementation directly in the primary service-worker path. Remove the retired native request path rather than depending on a timer-installed override.
- Have the helper reject/no-op legacy `window.foreground` requests with a correlated retired/unsupported response. Do not invoke Win32 from that handler, including stale-client calls.
- Apply passive missing-footer behavior in the primary policy/model. A failed optional compatibility import must never reactivate format repair or native foreground. Add a fail-closed startup assertion for the required safety behavior.
- Keep focus changes exclusive to a deliberate notification/history click. For a minimized target, explicitly restore it through Chrome's window API before focusing; preserve normal/maximized/fullscreen state otherwise. Handle target removal and API failure without retry storms or native fallback. See [Chrome windows.update](https://developer.chrome.com/docs/extensions/reference/api/windows#method-update).
- Test the actual production import graph and `toast.clicked` event route, including immediate startup clicks and optional-layer failure, not only a stub policy or isolated override. Prove zero native foreground requests/calls, and continued helper responsiveness when a legacy request is received.

The existing isolated safety regression proves its wrapper behavior. It does not prove every production entry point or helper protocol rejection.

## Evidence repair required before calling the next candidate accepted

**Source:** `RuntimeEvidencePublisher.cs`, `tools/Add-NotifierSafeEvidence.ps1`, `tools/Collect-NotifierRuntimeEvidence.ps1`, and the current evidence workflow.

The publisher restores the old loaded-extension version from disk and republishes it with a fresh overall timestamp. It does not preserve a distinct last live observation time for that identity. The safe-evidence adapter sets `loadedExtensionRuntimeIdentitySupported=true` whenever the stored version is nonempty. The workflow labels this as `liveRuntimeIdentity`. This explains the contradictory 0.9.15-installed/0.9.13-loaded/live=true summary.

### Deterministic repair and collection

- Separate historical last-seen identity, observation capability, installed identity, and current connection/liveness. Preserve an independent helper-observed extension timestamp and connection/runtime identity; mark restored values historical/unknown after helper restart.
- Use the existing local bridge connection and ping traffic to refresh liveness, with a bounded freshness rule and disconnect invalidation. No ChatGPT HTTP/session polling or new Chrome remote-debugging setup.
- Extend the sanitized evidence schema and all its summary/acceptance consumers together. A version string or newly written evidence file alone cannot satisfy a live-loaded gate. Inspect the current Glass deployment consumer before changing any shared acceptance contract.
- Add bounded click-stage evidence: helper click received, bridge dispatch/result, worker click received, selected existing/new tab, Chrome update result/error, completion. Use timestamp, runtime/event IDs or suffixes and fixed reason codes; no chat bodies or titles.
- Collect already-existing Windows Application Error/Hang/WER metadata for Chrome, crashpad and the notifier helper in the incident window when the existing read-only lane has access. Record event/provider/time, process identity, fault-module/exception metadata when available; do not upload unrestricted event messages or dumps.
- Record installed-root existence, manifest ID/version/hash, and narrowly scoped registration presence/disabled reason for the affected Chrome profile if the supported observer can read it. Report inaccessible/unknown honestly. Never reset/copy/delete a Chrome profile, edit its preferences, enable default-profile debugging, or impersonate the extension Origin.
- If existing logs cannot explain the native hang, prepare capture before the next minimal user click test. Do not deliberately reproduce repeated whole-browser hangs or treat no crash report as a pass.

Required regressions: helper restart with old stored identity; extension disconnect/absence; fresh current bridge identity; stale timestamp despite a newly published file; mismatched source/version; unavailable event/profile access. Existing 0.9.13 identity must be historical and must not satisfy current live acceptance.

## Expected routing to prove through the real coordinator

| Observation | Expected behavior, subject to existing action guards |
| --- | --- |
| Valid INCOMPLETE_LIMIT or INCOMPLETE_TOOL_FAILURE | Exactly the existing normal continuation text: `continue until you finish or need something from me`. |
| Valid BLOCKED_HUMAN | One coded notification; no automatic message. |
| Deliberate INCOMPLETE_HANDOFF | Notify only; respect the requested Work-to-normal-chat transfer. |
| Other valid terminal/planning codes | Existing coded notification behavior. |
| Settled uncoded response | Passive status-missing; no format-repair prompt and no status-missing toast. Missing code alone does not prove unfinished work. |
| Genuine current explicit timeout/interruption | At most one background reload; reinspection; at most one normal continuation if still appropriate. |
| Hidden/stale/quoted/other-request error | No automatic recovery from that text. |
| Confirmed silent stop | Existing separate silence thresholds and three-reload budget, then at most one eligible continuation. |
| Draft/upload/manual Stop/Pause/auth/approval/rate limit/uncertain prior send | Preserve the applicable veto/breaker; no bypass. |

A decision-only probe with the actual parser/policy/model/safety wrapper confirmed current v0.9.15 classification for BLOCKED_HUMAN, LIMIT, TOOL_FAILURE, HANDOFF and missing footer. It did not exercise real Send or Chrome lifecycle. Integration proof must cover both upstream completion and DOM-observer entry points, duplicate observation, split/late footer, uncertain send, restart, and optional-layer failure.

The proposed v2 INCOMPLETE_CONTINUE/narrower HANDOFF contract remains separately planned. Do not emit it or reinterpret legacy HANDOFF during this repair.

## Normal-chat execution boundary

Implement the bounded detector, direct safety-path and evidence repairs above on the adopted PR; retain existing behavior and regression coverage. Validate the exact candidate on the existing scoped Glass runner, then use the established guarded per-user deployment/rollback lane if authorized by the continuing task. Do not deploy this documentation-only head as a new application.

Only after deterministic proof and installed/helper identity are established should the normal chat reach the one unavoidable manual Load unpacked step if Chrome registration is still absent, using `%LOCALAPPDATA%\ChatGPTResponseNotifier\Extension`. This Work handoff does not ask Dan to do that now.

Keep PR #33 draft/unpublished until actual Chrome click/registration and routing acceptance passes. If the hang recurs, use the prepared evidence to distinguish browser process hang/crash, helper stall, and registration state; report the remaining cause as unresolved until supported.
