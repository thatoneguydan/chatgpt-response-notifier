# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. Source authority: this repository. Historical incident authority: [DevelopmentInfrastructure #283](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/283). Status-contract v2 rollout authority: [DevelopmentInfrastructure #432](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/432). Explicit-interruption regression authority: [DevelopmentInfrastructure #434](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/434). Timestamp/quick-prompt UX rollout authority: [DevelopmentInfrastructure #435](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/435). Historical implementation/review evidence remains in notifier PRs #33, #38, #39, #40, #41, #43, #45, and #46.

## Current checkpoint — 2026-09-15, v0.9.20 timestamp and quick-prompt UX accepted

Notifier **v0.9.20** is merged, released, installed on `GLASS\dan`, and observed live. The accepted live candidate is `c084ed2364491cba3f42af0cb9f798e4377e70e2`; notifier PR #45 merged as `93702bd63c74eab2c5b27ed270ffc4927b30725d`, release **v0.9.20** was published, and the managed-update manifest was refreshed on `main` by `723936b5332c19830192667bf84216ab9f3b6daf`. The exact pre-change fallback remains preserved at `stable/v0.9.19-pre-timestamp-toolbar` (`e67c28f253fc9b3a5b020d96c8d71adfba7e3024`).

v0.9.20 adds the already-persisted local completion time to native notifier toasts and adds an isolated timestamped quick-prompt toolbar beside the ChatGPT composer with Continue, Status, Checkpoint, and Handoff presets. Presets are insert-only: they do not auto-send, do not overwrite a non-empty draft, do not call recovery commands, and do not consume recovery/action budgets. The pinned upstream completion detector and reviewed manifest content-script list remain unchanged; quick prompts attach at runtime to existing and future/reloaded ChatGPT tabs.

Project policy now explicitly makes operator interaction a last resort. PR #46 merged that policy into `PROJECT.md`: safe non-interactive updater, loopback-helper, protected Glass deployment, and repository-defined automation routes must be exhausted before asking the operator to click Update, run an installer/command, reload Chrome, or perform another manual deployment/recovery step. Ordinary update cadence or the existence of a UI button is not an operator blocker.

The coordinated producer contract remains **`github-work-status/v2`** with semantic SHA-256 `a2570315b911add3c57231f08b84214daa56750f9c93fd76c5d8b459d28c3efb`. `INCOMPLETE_CONTINUE`, `INCOMPLETE_LIMIT`, and `INCOMPLETE_TOOL_FAILURE` use the shared guarded continuation path; `INCOMPLETE_HANDOFF` remains notification-only. Missing-footer format repair remains retired and passive.

The v0.9.19 explicit-interruption precedence repair remains accepted: a verified current-request explicit interruption may override a stale Stop-generating/tool affordance for bounded recovery while historical, hidden, detached, quoted, ambiguous, identity-mismatched, manual-stop, Pause/user, draft/upload, auth/approval/rate-limit/offline, budget, uncertainty, and profile-spacing vetoes remain intact. The earlier Chrome-click incident also remains closed; a physical v0.9.17 toast click proved helper → bridge → worker → Chrome API navigation without Chrome hang or extension registration loss.

## Accepted proof

- v0.9.17 incident acceptance: merged PR #33; live candidate `f80fc75ad4909cdfa65106f26fd427218f69b2b9`; published source `0054cef8f14474f29654501007618aeccf1cb41a`; identical Git tree `3ad4172b5f93bbc147e48364091041b5b01aa943`.
- v0.9.17 release hardening: PR #38 expanded the release validation aggregate to 92/92; PR #39 repaired the existing-tag PowerShell refspec; PR #40 closed the incident roadmap state.
- v0.9.18 exact validation: run `34973477670`, artifact `10398346886`, digest `sha256:f7361258c888b122ebd4e5e74088eea43bf5eb63b04f3da8976c092eeff420a7`.
- v0.9.18 protected Glass deployment: run `34974145865`; installed source `468b5803f5e0a8e8b4e733d8098e658abf0da721`, installed version 0.9.18, helper-owned listener, rollback available, Chrome registration preserved.
- v0.9.18 post-install runtime evidence: run `34974835098`, artifact `10398193731`, digest `sha256:cf58cfc9412d06749b3181efb01948160c56aeddbebcc721359f007a8e68a20b`; current extension v0.9.18, bridge connected/live, repeated heartbeat freshness, v1+v2 contract capability.
- v0.9.18 publication: notifier PR #41 merge `d9a57852de8be6e674deb25c03f5c57777d0c1c8`; release tag `v0.9.18`; update-manifest commit `8d5ed12b1f7911cbedb7ab28ae122f10b5f28c36`.
- Producer v2 activation: DevelopmentInfrastructure PR #433 merge `e37dd0d2c58e2b009d62f565d2e59570d2fba8ca`; active contract digest `a2570315b911add3c57231f08b84214daa56750f9c93fd76c5d8b459d28c3efb`.
- v0.9.19 regression validation: exact candidate `8bc17081d9383b9badb055aaf0fca7e43b085332`; run `34981276931`, artifact `10401382253`, digest `sha256:cb13662d5fc0eb9a38f2ecf0ea988335678c8a0e70d1c71d2daa5740a6b6f72e`.
- v0.9.19 protected Glass deployment: run `34981734591`; installed source `8bc17081d9383b9badb055aaf0fca7e43b085332`, installed version 0.9.19, helper-owned listener, rollback available, Chrome registration preserved.
- v0.9.19 post-install runtime evidence: run `34981276975`, artifact `10402326647`, digest `sha256:ab1fef0c4cc6d024281521623db5c659f20e75cb5fcf3caf886d01a76fcc85d5`; installed/current extension v0.9.19, bridge connected/live, repeated heartbeat freshness for more than nine minutes after deployment.
- v0.9.19 publication: notifier PR #43 merge `44fe89e170cb6b408c0f63f5640206bdd2558dc5`; release workflow run `34983818917`; release tag `v0.9.19`; update-manifest commit `95259f481092b6970bc72950a6dd67d2c3af337c`; published ZIP SHA-256 `65573d30b3b4f4fef6d89a4bb1a86338a46c345be783cd7e73554e9fa52775a0`.
- v0.9.20 exact validation: exact candidate `c084ed2364491cba3f42af0cb9f798e4377e70e2`; validation run `34989700101`; artifact `10405451336`; digest `sha256:a3e266fa27412e1539de64b0e8e4aeef543c6ce8a21b19b95d9533164dbe3691`.
- v0.9.20 publication: notifier PR #45 merge `93702bd63c74eab2c5b27ed270ffc4927b30725d`; release workflow run `34990096418`; release tag `v0.9.20`; update-manifest commit `723936b5332c19830192667bf84216ab9f3b6daf`; published ZIP SHA-256 `3c314b001cbdb81f216f1b00ebb634097440909cc986c39a09beb213c27371f8`; Setup SHA-256 `ac111deb19b7460966d394a250cef3091ad9fc3fdda888964f8ab69b8b27336f`.
- v0.9.20 protected Glass deployment: Glass PR #136 / deployment bridge run `34991836269`; user-session `GLASS\dan`, session 1; installed source `c084ed2364491cba3f42af0cb9f798e4377e70e2`; installed version 0.9.20; helper-owned listener; runtime evidence present; rollback available; extension identity not deferred.
- v0.9.20 post-install runtime evidence: runtime-evidence run `34989699828` latest rerun; artifact `10406127305`, digest `sha256:2d4cef0acf20b45fc37187374d2a36fc22285b735697cf5d4b66c757be447c30`; safe installed/current/historical extension all 0.9.20, live runtime identity true, zero Windows incidents.
- Operator-interaction-last-resort policy: notifier PR #46 exact head `8bb5857c8732cf554fd6d41290159f30370f452e` passed source validation and merged as `ab434ecebc89e6f1a137c096e688ddb9557caf20`.

## Program structure

| Workstream | Scope | Current state |
| --- | --- | --- |
| Workstream 1/5 — Foundation and Conversation Identity | Completion sensor, stable chat routing, loopback helper protocol. | Complete; retained. |
| Workstream 2/5 — Native Toast UX | Persistent stacked non-activating notifications, deliberate click/dismiss routing, timestamps, and manual quick prompts. | Complete through v0.9.20. |
| Workstream 3/5 — Installation, Release, and Acceptance | Per-user installer, stable unpacked root, managed updater, rollback, release publication. | Complete through v0.9.20. |
| Workstream 4/5 — Reliable Background Automation | Durable ownership, guarded continuation, recovery, delivery/outbox. | Complete for current contract; v0.9.20 preserves accepted behavior. |
| Workstream 5/5 — Status Contract and Bounded Recovery | Contract retention, current-run recognition, bounded recovery, proof and rollout. | v2 amendment complete and active; v0.9.20 live identity accepted. |

## Workstream 1/5 — Foundation and Conversation Identity

### Stage 1/1 — Retained Foundation

#### Step 1/1 — Preserve identity and transport

##### Gate 1/1 — Foundation invariants remain true

- Task 1/3 — Stable conversation/request identity and current-turn observation. **Complete; retained.**
- Task 2/3 — Loopback-only helper transport with no ChatGPT API/session polling. **Complete; retained.**
- Task 3/3 — Stable extension root/ID and manual-only Chrome registration. **Complete; retained.**

## Workstream 2/5 — Native Toast UX

### Stage 1/1 — Accepted Native Notification Surface

#### Step 1/1 — Preserve non-activating notification behavior

##### Gate 1/1 — Deliberate user actions are the only focus authority

- Task 1/5 — Persistent stacked notifications and rolling coded history. **Complete.**
- Task 2/5 — Dismiss/quiet-close behavior does not create false attention. **Complete.**
- Task 3/5 — Deliberate toast click uses Chrome APIs only and may focus Chrome only because the user clicked. **Complete and physically accepted.**
- Task 4/5 — Native toast renders the persisted completion timestamp in local time without changing notification delivery/dedupe semantics. **Complete in v0.9.20.**
- Task 5/5 — Composer-adjacent timestamped Continue/Status/Checkpoint/Handoff toolbar is extension-owned, insert-only, draft-safe, runtime-attached, and isolated from automatic recovery/action budgets. **Complete in v0.9.20.**

## Workstream 3/5 — Installation, Release, and Acceptance

### Stage 1/1 — Managed Installation and Publication

#### Step 1/1 — Preserve exact-source deploy/update/rollback

##### Gate 1/1 — Published and installed identity remain reconcilable

- Task 1/3 — Per-user installer preserves the stable unpacked extension root. **Complete.**
- Task 2/3 — Managed updater/release workflow publishes exact validated source and handles existing releases idempotently. **Complete through v0.9.20.**
- Task 3/3 — Protected Glass deployment/rollback reports installed source/version and never mutates Chrome registration/profile automatically. **Complete through v0.9.20.**

Operational policy: operator interaction is a last resort. Safe non-interactive managed-update, loopback-helper, protected Glass, and repository-defined automation paths must be exhausted before requesting a manual click/install/reload/command. Manual intervention is reserved for inherently interactive steps or concrete failure/unavailability of applicable automated routes.

## Workstream 4/5 — Reliable Background Automation

### Stage 1/3 — Coordinated Continuation

#### Step 1/1 — Own and revalidate one terminal turn

##### Gate 1/1 — Only contract-eligible, identity-matched turns may continue

- Task 1/3 — Durable transactional turn ownership and dedupe. **Complete.**
- Task 2/3 — Separate read-only observation from authorized DOM action and preserve document/conversation/prompt/assistant/revision identity. **Complete.**
- Task 3/3 — One shared continuation predicate covers LIMIT, TOOL_FAILURE, and CONTINUE while HANDOFF remains notification-only. **Complete since v0.9.18; retained in v0.9.20.**

### Stage 2/3 — Reliable Delivery and Recovery

#### Step 1/1 — Deliver once and recover within persisted budgets

##### Gate 1/1 — Uncertain delivery never authorizes duplicate generation

- Task 1/3 — Durable outbox, stable notification IDs, helper ACK, dismissal/restart deduplication. **Complete.**
- Task 2/3 — Unified finalization, version-aware attachment, reconnect/replay and diagnostics. **Complete.**
- Task 3/3 — Explicit interruption and silent-stop recovery preserve Pause/user guards, identity, action budgets and uncertainty vetoes; a verified current-request interruption may override only a stale Stop-generating/tool affordance. **Complete through v0.9.20; behavior unchanged by the timestamp/quick-prompt release.**

### Stage 3/3 — Runtime Acceptance

#### Step 1/1 — Prove current source on the workstation

##### Gate 1/1 — Source, install state, runtime liveness and visible behavior agree

- Task 1/3 — Exact candidate architecture/helper/installer proof. **Complete through v0.9.20.**
- Task 2/3 — Live bridge/runtime heartbeat and current-version identity proof. **Complete through v0.9.20.**
- Task 3/3 — Physical click and foreground/navigation behavior accepted without native foreground fallback. **Complete.**

## Workstream 5/5 — Status Contract and Bounded Recovery

### Stage 1/4 — Retain the Contract

#### Step 1/2 — Retain canonical work-session classification

##### Gate 1/1 — Long chats preserve exact terminal semantics

- Task 1/3 — Reconcile source/install identity and active work before mutation. **Complete; retained.**
- Task 2/3 — Canonical scope retention, carry-forward capsule, final check and START signal. **Complete.**
- Task 3/3 — Versioned grammar parity and long-conversation fixtures. **Complete.**

#### Step 2/2 — Activate v2 same-chat continuation semantics

##### Gate 1/1 — Consumer compatibility precedes producer activation

- Task 1/3 — Define `github-work-status/v2` with `INCOMPLETE_CONTINUE`, narrow HANDOFF to explicit transfer, and retain LIMIT/TOOL_FAILURE meanings. **Complete in DevelopmentInfrastructure PR #433.**
- Task 2/3 — Implement the v1+v2 consumer with one shared continuation predicate across dispatch, page revalidation, normal observation and recovery paths. **Complete in notifier v0.9.18 / PR #41; retained in v0.9.20.**
- Task 3/3 — Validate, install, prove live v1+v2 capability, then activate producer v2. **Complete.** Protected deployment and fresh runtime evidence preceded producer merge.

Acceptance: one exact terminal footer remains sufficient. Missing/malformed footer is passive; no second action marker, free-text terminal inference, or browser format-repair prompt is permitted. Unsupported contract/digest combinations fail closed.

### Stage 2/4 — Observe Every Pending Request

#### Step 1/1 — Observe current request without historical leakage

##### Gate 1/1 — Only fresh assistant/current-run state may authorize automation

- Task 1/3 — Enrollment, human-run identity, auto-recognition and sticky Pause. **Complete.**
- Task 2/3 — Current-request observation excludes hidden/detached/quoted/prose historical errors and remains document/prompt bound. **Complete.**
- Task 3/3 — Bounded structural diagnostics, separate attention/history and quiet close. **Complete.**

### Stage 3/4 — Recover Within a Budget

#### Step 1/1 — Bound reload/continuation behavior

##### Gate 1/1 — Recovery cannot loop or replay uncertain side effects

- Task 1/3 — Durable incident/run budget, breaker, earliest alarm, restart reconstruction and user vetoes. **Complete.**
- Task 2/3 — Explicit interruption: one reload/reinspection then at most one eligible continuation; verified current-request interruption outranks a stale generating/tool affordance but never higher-priority human/safety vetoes. Silent stop: up to three reload/reinspections then at most one eligible continuation. **Complete through v0.9.20.**
- Task 3/3 — Concurrency, late-response, uncertainty, crash/restart, lifecycle, and explicit-interruption precedence regressions. **Complete through v0.9.20.**

Current defaults: 30-second terminal/error grace; silence requires at least 90 seconds idle and two consistent inspections at least 30 seconds apart; 15-minute ambiguous-thinking diagnostic without forced retry; at most one recovery continuation per incident; zero format-repair prompts; at least 30 seconds profile spacing; persisted 12-generation-producing-action ceiling per human-started run. Reset only by a genuinely new trusted human request or explicit Resume.

### Stage 4/4 — Prove and Roll Out

#### Step 1/1 — Require deterministic and live proof at the changed trust boundary

##### Gate 1/1 — Release and contract activation require exact accepted evidence

- Task 1/5 — Repair and prove source decisions. **Complete.**
- Task 2/5 — Automatic bounded read-only Glass runtime evidence. **Complete.**
- Task 3/5 — Guarded Glass-only candidate deployment/rollback with no Chrome registration mutation. **Complete.**
- Task 4/5 — Real current-build acceptance including bridge/runtime identity and deliberate-click route where applicable. **Complete.** v0.9.20 live acceptance proves installed/current identity and helper/runtime liveness; the UX additions do not broaden focus authority or recovery behavior.
- Task 5/5 — Merge/release, managed update identity, canonical producer activation and roadmap closeout. **Complete through v0.9.20 and status-contract v2.**

## Continuing work

The v0.9.17 click/recovery/registration incident, coordinated v0.9.18 status-contract v2 amendment, v0.9.19 explicit-interruption precedence regression, and v0.9.20 timestamp/quick-prompt UX rollout are **complete**. There is no deterministic unfinished work in these scopes.

Future notifier work starts from current `main`, this roadmap, `PROJECT.md`, and current DevelopmentInfrastructure policy. Any future Chrome hang/registration loss or naturally recurring interruption failure is a new incident requiring fresh bounded evidence. Any future status-taxonomy change requires a new versioned contract review and consumer-before-producer compatibility proof. Operator interaction remains a last resort: do not ask for a manual update/install/reload/command until safe applicable automated routes have been exhausted or proven unavailable/failed.

Preserve loopback-only helper transport, rolling coded history, durable ACK/deduplication, unified Monitor/Recover enrollment, sticky Pause/user guards, bounded explicit/silent-stop recovery, current-request interruption attribution, stable extension ID/root, updater/rollback, passive missing-footer behavior, deliberate-click-only foregrounding, local toast timestamps, and insert-only quick prompts. Do not add ChatGPT API/session polling, original-prompt replay, Regenerate, auto-approval, unbounded retries, free-text continuation inference, browser format repair, automatic foregrounding, native foreground fallback, or automatic Chrome registration/profile mutation.
