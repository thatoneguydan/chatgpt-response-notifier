# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. Source authority: this repository. Incident work authority: [DevelopmentInfrastructure #283](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/283). Accepted implementation: merged [PR #33](https://github.com/thatoneguydan/chatgpt-response-notifier/pull/33). Validation/release hardening: merged [PR #38](https://github.com/thatoneguydan/chatgpt-response-notifier/pull/38) and [PR #39](https://github.com/thatoneguydan/chatgpt-response-notifier/pull/39). Review history remains in [#32](https://github.com/thatoneguydan/chatgpt-response-notifier/issues/32) and [#34](https://github.com/thatoneguydan/chatgpt-response-notifier/issues/34).

## Current checkpoint — 2026-09-15, v0.9.17 incident repair accepted and released

**Live-accepted candidate:** `f80fc75ad4909cdfa65106f26fd427218f69b2b9`, **v0.9.17**. Protected Glass deployment installed this exact candidate under `GLASS\dan`; runtime evidence showed one connected extension client, current v0.9.17 identity, sustained heartbeat freshness beyond the old 60-second window, and no active native-foreground path.

**Published release:** merged PR #33 produced release source `0054cef8f14474f29654501007618aeccf1cb41a`, tag **v0.9.17**, and the managed-update manifest points to that release. The accepted candidate commit and released squash commit have the same Git tree `3ad4172b5f93bbc147e48364091041b5b01aa943`, so the live-tested candidate and published application source are byte-identical despite different commit IDs.

**Physical click acceptance passed.** The correlated production route was helper click received → extension bridge dispatch → v0.9.17 worker selected the existing tab → `chrome.tabs.update` activated the tab → `chrome.windows.update` focused the window → navigation completed. Chrome stayed responsive and the extension remained registered/connected afterward. No native Win32 foreground request executed in the v0.9.17 click route.

**Incident repairs complete:**
- Current-request interruption detection now excludes hidden/detached/quoted/prose historical errors and binds inspection to current conversation/document/prompt identity.
- Missing-footer format repair is retired; missing footer is passive.
- LIMIT and TOOL_FAILURE continue through the normal guarded continuation path; BLOCKED_HUMAN and deliberate HANDOFF remain terminal/notification-only.
- Native foreground handling is removed from the production helper/worker route; old `window.foreground` requests fail closed as retired.
- Runtime evidence separates historical identity from current connection and uses the v0.9.17 runtime-identity heartbeat to keep live identity fresh under MV3 worker scheduling.
- Click-route diagnostics are correlation-safe and prove helper → bridge → Chrome API routing without raw chat content.
- Chrome unpacked registration remains manual-only; no automatic profile/registration mutation was introduced.

**Release hardening complete:** PR #38 expanded the coordinator test aggregate so the current-request, v0.9.14 safety, version-sync, runtime-identity, and click-route regressions all execute through the entrypoint used by both PR and release validation. Release run `34919400520` proved the enlarged suite at **92/92** before exposing a separate existing-tag refspec bug. PR #39 fixed the PowerShell `$tag:` interpolation ambiguity with `${tag}`. Main release run `34920107312` then completed successfully, proving both the 92-test release gate and clean reuse of the existing v0.9.17 release.

The exact native cause of the earlier Chrome hang/registration-loss incident remains historically **unproven**. That is no longer an active blocker: the concrete unsafe/ambiguous paths found during diagnosis were removed or repaired, and the repaired production click path completed successfully without a hang or registration loss. A future recurrence should be treated as a new incident with fresh bounded evidence rather than retroactively assigning an unproven cause.

The producer taxonomy remains seven-code v1. The proposed coordinated v2 `INCOMPLETE_CONTINUE` amendment remains a **separate planned work item** and was not required for this incident closeout.

## Program structure

| Workstream | Scope | Current state |
| --- | --- | --- |
| Workstream 1/5 — Foundation and Conversation Identity | Completion sensor, stable chat routing, loopback helper protocol. | Retained. |
| Workstream 2/5 — Native Toast UX | Persistent stacked non-activating notifications and deliberate dismissal/click routing. | Accepted in v0.9.17. |
| Workstream 3/5 — Installation, Release, and Acceptance | Per-user installer, stable unpacked root, managed updater, rollback, installed identity. | Accepted in v0.9.17. |
| Workstream 4/5 — Reliable Background Automation | Durable ownership, guarded continuation, delivery/outbox. | Accepted in v0.9.17; retain regressions. |
| Workstream 5/5 — Status Contract and Bounded Recovery | Contract retention, current-run recognition, recovery, and rollout proof. | v1 incident work complete; v2 amendment separately planned. |

## Workstream 4/5 — Reliable Background Automation

### Stage 1/3 — Coordinated Continuation

- Task 1/3 — Publish roadmap/state contract. **Complete; retained.**
- Task 2/3 — Transactional turn ownership, read-only observation, separately authorized DOM action, strict identity and user guards. **Complete for v0.9.17.** Distinct browser/local document identities and conversation/prompt/assistant/revision binding remain required.
- Task 3/3 — Duplicate claims, failed/uncertain sends, navigation, user intervention and restart reconciliation. **Complete for current release through regression proof plus live click acceptance.** Uncertain post-click outcomes never authorize a second send.

Acceptance: only contract-eligible codes may request the exact continuation text. Explicit Work-to-normal-chat handoff remains notification-only. Preserve upstream completion-sensor integrity.

### Stage 2/3 — Reliable Delivery and Recovery

- Task 1/3 — Durable outbox, stable IDs, helper ACK, dismissal/restart deduplication. **Complete; retained.**
- Task 2/3 — Unified finalization and version-aware attachment. **Complete; retained.**
- Task 3/3 — Crash/reconnect/replay, history and diagnostics. **Complete for v0.9.17 acceptance.** Runtime evidence now distinguishes current connection from historical identity and records bounded click-route stages.

Acceptance: helper ACK is required to remove an outbox entry. Evidence must distinguish observed, claimed, queued, sent, acknowledged, shown/dismissed, and clicked/navigation-complete states.

### Stage 3/3 — Workstation Acceptance and Release

- Task 1/3 — Exact candidate component/architecture and helper/installer proof. **Complete for v0.9.17.** Candidate validation included same-version repeat install and stable extension-root preservation.
- Task 2/3 — Real Chrome/background/navigation/helper/update/lifecycle acceptance. **Complete for the incident scope.** Live v0.9.17 registration, bridge connection, heartbeat freshness, toast presentation and deliberate click route were proved.
- Task 3/3 — Foreground behavior, publication, installed identity and rollback. **Complete for v0.9.17.** Automatic foregrounding remains forbidden; only a deliberate toast click may focus Chrome. v0.9.17 is published and rollback remains available.

Acceptance: source, isolated installation, live runtime and visible behavior remain separate evidence classes.

## Workstream 5/5 — Status Contract and Bounded Recovery

### Stage 1/4 — Retain the Contract — Step 1/2

- Task 1/3 — Reconcile source/install identity and active work. **Complete for v0.9.17 incident.** Repeat exact identity for each future application candidate.
- Task 2/3 — Canonical scope retention, capsule, final check and START. **Implemented in v1.** Automatic browser missing-footer repair stays retired for this product.
- Task 3/3 — Versioned grammar parity and long-conversation fixtures. **Implemented and covered by release validation.**

### Stage 1/4 — Retain the Contract — Step 2/2: planned v2 amendment

This work is **not part of the v0.9.17 incident closeout**.

- Task 1/3 — Define the coordinated v2 amendment in canonical policy/grammar. **Planned.** Proposed `INCOMPLETE_CONTINUE` is for authorized unfinished same-chat continuation; HANDOFF remains explicit transfer; real forced capacity stops remain LIMIT.
- Task 2/3 — Implement one shared continuation-eligibility predicate across parser, dispatch, page revalidation, normal observer and recovery paths. **Planned.**
- Task 3/3 — Prove v1/v2 compatibility and activate producer v2 only after installed-consumer capability is verified. **Planned.**

Acceptance: one terminal footer remains sufficient; no second action marker or free-text inference. Unsupported versions fail visibly and passively rather than repeatedly repairing or guessing.

### Stage 2/4 — Observe Every Pending Request

- Task 1/3 — Enrollment, human-run identity, provisional blank-chat enrollment, auto-recognition and sticky Pause. **Implemented; preserve.**
- Task 2/3 — Versioned UI/request observation with unchanged upstream sensor. **Complete for v0.9.17 incident.** Current-request interruption attribution now excludes stale/hidden/prose content and is document/prompt bound.
- Task 3/3 — Bounded structural diagnostics, separate attention, history and quiet close. **Complete for v0.9.17 incident.** Current connection/identity freshness and correlated click diagnostics are available without raw chat content.

Acceptance: no ordinary non-build interaction, historical content, missing-footer state, history entry or quiet tab close may authorize a Send/reload/attention loop.

### Stage 3/4 — Recover Within a Budget

- Task 1/3 — Durable incident/run budget, breaker, earliest alarm, restart reconstruction and user vetoes. **Implemented; preserve.**
- Task 2/3 — Explicit interruption: one reload, reinspection, then at most one normal continuation if still appropriate. Silent stop: up to three reloads, with reinspection after each, then at most one eligible continuation. **Implemented with current-request attribution repaired.** Format repair remains retired.
- Task 3/3 — Concurrency/crash/uncertainty/late-response/identity/lifecycle proof. **Complete for current release through regressions plus live v0.9.17 acceptance.**

Current defaults remain: 30-second terminal/error grace; silence requires at least 90 seconds idle and two consistent inspections at least 30 seconds apart; 15-minute ambiguous-thinking diagnostic without forced retry; explicit interruption one reload versus silent-stop up to three reloads; at most one recovery continuation and zero format-repair prompts per incident; at least 30 seconds profile spacing; persisted 12-generation-producing-action ceiling per human-started run. Reset only by a genuinely new trusted human request or explicit Resume.

### Stage 4/4 — Prove and Roll Out

- Task 1/5 — Repair and prove source decisions. **Complete in v0.9.17.**
- Task 2/5 — Automatic read-only Glass evidence collection. **Complete for the incident scope.** Historical/current identity separation, heartbeat freshness and click-stage correlation are proved.
- Task 3/5 — Guarded Glass-only candidate deployment/rollback. **Complete for v0.9.17.** No automatic unpacked-extension registration/profile mutation.
- Task 4/5 — Real current-build acceptance. **Complete.** A physical v0.9.17 toast click completed through the Chrome-only route without hang/crash/registration loss; post-click evidence showed the extension still connected and registered.
- Task 5/5 — Non-activating normal behavior, accepted publication, installed identity and rollback. **Complete for v0.9.17.** PR #33 is merged, release v0.9.17 is published, managed-update metadata is canonical, and later PRs #38/#39 harden the release gate without changing runtime code.

Acceptance: public merge/release requires deterministic proof plus live evidence where behavior is inherently runtime/browser-specific. Stale identity is never treated as current liveness, and removing a suspect call is never by itself presented as proof of historical root cause.

## Continuing work

The v0.9.17 click/recovery/registration incident is **closed**. There is no deterministic incident work waiting for another chat.

Future work should begin from current `main` and current canonical policy rather than the 2026-09-14 handoff. The separately planned v2 continuation-contract amendment is the next roadmap item only if/when explicitly resumed.

Preserve loopback-only helper transport, local state, rolling 20 coded history, durable ACK/deduplication, sticky Pause and user guards, distinct explicit/silent-stop recovery budgets, stable extension ID/root, updater/rollback and quiet tab closure. Do not add ChatGPT API/session polling, original-prompt replay, Regenerate, auto-approval, unbounded retries, automatic foregrounding, native foreground fallback, or automatic Chrome registration/profile mutation.