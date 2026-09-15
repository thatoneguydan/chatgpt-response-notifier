# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. Source authority: this repository. Historical incident authority: [DevelopmentInfrastructure #283](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/283). Status-contract v2 rollout authority: [DevelopmentInfrastructure #432](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/432). Explicit-interruption regression authority: [DevelopmentInfrastructure #434](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/434). Timestamp/quick-prompt UX rollout authority: [DevelopmentInfrastructure #435](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/435). Current quick-prompt layout / persistent timeout-recovery follow-up authority: [DevelopmentInfrastructure #436](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/436).

## Current checkpoint — 2026-09-15, v0.9.20 accepted; v0.9.21 follow-up active

Notifier **v0.9.20** remains the accepted live baseline. It is merged, released, installed on `GLASS\dan`, and observed live. The accepted live candidate is `c084ed2364491cba3f42af0cb9f798e4377e70e2`; notifier PR #45 merged as `93702bd63c74eab2c5b27ed270ffc4927b30725d`, release **v0.9.20** was published, and the managed-update manifest was refreshed on `main` by `723936b5332c19830192667bf84216ab9f3b6daf`. The exact pre-change fallback remains preserved at `stable/v0.9.19-pre-timestamp-toolbar` (`e67c28f253fc9b3a5b020d96c8d71adfba7e3024`).

v0.9.20 added local completion time to native toasts and an isolated timestamped quick-prompt toolbar with Continue, Status, Checkpoint, and Handoff presets. The toolbar is insert-only, draft-safe, runtime-attached, and isolated from automatic recovery/action budgets.

**Active follow-up #436** addresses two quick-prompt UI defects and one recovery reliability defect observed on the accepted live build:

1. The quick-prompt toolbar is currently positioned relative to the send button, so it can overlap an expanding composer. It must instead track the composer container and remain immediately above the full composer as the composer grows or shrinks.
2. The toolbar currently uses a near-maximum z-index and can cover ChatGPT-owned popups/menus. It must remain below native ChatGPT popover/menu/modal layers while still remaining visible above ordinary conversation content.
3. Quick-prompt hover/title text must show the **actual current local timestamp** in the same format used by the inserted timestamped prompt, rather than prose such as `Adds the current local timestamp`.
4. Current-request timeout/system/connection/generation interruption UI can remain stuck until a manual reload. Recoverable current-request interruptions must enter a persistent bounded reload/reinspection schedule.

### Active recovery contract for #436

For a verified current-request recoverable interruption (`connection-interrupted`, `request-error`, `request-rejected`, `timed-out`/`timeout`, `connection-lost`, `systems-taking-longer`, `generation-error`, and equivalent current-request semantic UI):

- first recovery reload occurs as soon as the interruption is safely attributable to the current request;
- after each reload, re-inspect the same conversation + prompt identity;
- if the interruption disappears or work resumes, resolve the incident without sending anything;
- if the same interruption survives, wait **5 minutes** before the next reload;
- perform at most **5 total reload attempts** for that incident;
- after the fifth reload/reinspection still shows the interruption / no resumed work, send exactly **one** guarded Continue message;
- preserve Pause/manual-stop, draft/upload, auth/approval/rate-limit/offline, identity mismatch, uncertain-action, dedupe, profile-spacing, and action-budget vetoes;
- never loop indefinitely, replay the original prompt, use Regenerate, poll ChatGPT APIs/session state, or foreground Chrome.

Silent-stop recovery remains separately bounded at its accepted current policy (up to three reload/reinspections then at most one eligible continuation) unless a future work item explicitly changes it.

Project policy continues to make operator interaction a last resort. Safe non-interactive updater, loopback-helper, protected Glass deployment, and repository-defined automation routes must be exhausted before asking the operator to click Update, run an installer/command, reload Chrome, or perform another manual deployment/recovery step.

The coordinated producer contract remains **`github-work-status/v2`** with semantic SHA-256 `a2570315b911add3c57231f08b84214daa56750f9c93fd76c5d8b459d28c3efb`. `INCOMPLETE_CONTINUE`, `INCOMPLETE_LIMIT`, and `INCOMPLETE_TOOL_FAILURE` use the shared guarded continuation path; `INCOMPLETE_HANDOFF` remains notification-only. Missing-footer format repair remains retired and passive.

## Accepted proof

- v0.9.17 click/registration incident: accepted; Chrome API click route physically proved without Chrome hang or extension-registration loss.
- v0.9.18 status-contract v2 consumer: accepted, deployed, live-proven, and published before producer activation.
- v0.9.19 explicit-interruption precedence repair: accepted and live-proven.
- v0.9.20 exact validation: candidate `c084ed2364491cba3f42af0cb9f798e4377e70e2`; validation run `34989700101`; artifact `10405451336`; digest `sha256:a3e266fa27412e1539de64b0e8e4aeef543c6ce8a21b19b95d9533164dbe3691`.
- v0.9.20 publication: PR #45 merge `93702bd63c74eab2c5b27ed270ffc4927b30725d`; release workflow `34990096418`; update-manifest commit `723936b5332c19830192667bf84216ab9f3b6daf`; published ZIP SHA-256 `3c314b001cbdb81f216f1b00ebb634097440909cc986c39a09beb213c27371f8`; Setup SHA-256 `ac111deb19b7460966d394a250cef3091ad9fc3fdda888964f8ab69b8b27336f`.
- v0.9.20 protected Glass deployment: Glass PR #136 / bridge run `34991836269`; installed source `c084ed2364491cba3f42af0cb9f798e4377e70e2`; installed 0.9.20; helper-owned listener; rollback available; extension identity not deferred.
- v0.9.20 post-install runtime evidence: run `34989699828`, artifact `10406127305`, digest `sha256:2d4cef0acf20b45fc37187374d2a36fc22285b735697cf5d4b66c757be447c30`; installed/current/historical extension all 0.9.20, live runtime identity true, zero Windows incidents.
- Operator-interaction-last-resort policy: notifier PR #46 merged as `ab434ecebc89e6f1a137c096e688ddb9557caf20`.
- v0.9.20 roadmap closeout: notifier PR #47 merged as `dd126824a3ee789fe7933e3eef43fdde59cc0b4e`.

## Program structure

| Workstream | Scope | Current state |
| --- | --- | --- |
| Workstream 1/5 — Foundation and Conversation Identity | Completion sensor, stable chat routing, loopback helper protocol. | Complete; retained. |
| Workstream 2/5 — Native Toast UX | Persistent stacked notifications, deliberate click/dismiss routing, timestamps, and manual quick prompts. | **Active follow-up #436:** quick-prompt geometry, layering, and live timestamp preview. |
| Workstream 3/5 — Installation, Release, and Acceptance | Per-user installer, stable unpacked root, managed updater, rollback, release publication. | Complete through v0.9.20; next candidate must use protected non-interactive rollout. |
| Workstream 4/5 — Reliable Background Automation | Durable ownership, guarded continuation, recovery, delivery/outbox. | **Active follow-up #436:** persistent explicit-interruption retry schedule. |
| Workstream 5/5 — Status Contract and Bounded Recovery | Contract retention, current-run recognition, bounded recovery, proof and rollout. | v2 contract retained; #436 must re-prove bounded recovery and live activation. |

## Workstream 1/5 — Foundation and Conversation Identity

### Stage 1/1 — Retained Foundation

#### Step 1/1 — Preserve identity and transport

##### Gate 1/1 — Foundation invariants remain true

- Task 1/3 — Stable conversation/request identity and current-turn observation. **Complete; retained.**
- Task 2/3 — Loopback-only helper transport with no ChatGPT API/session polling. **Complete; retained.**
- Task 3/3 — Stable extension root/ID and manual-only Chrome registration. **Complete; retained.**

## Workstream 2/5 — Native Toast UX

### Stage 1/2 — Accepted Native Notification Surface

#### Step 1/1 — Preserve non-activating notification behavior

##### Gate 1/1 — Deliberate user actions are the only focus authority

- Task 1/5 — Persistent stacked notifications and rolling coded history. **Complete.**
- Task 2/5 — Dismiss/quiet-close behavior does not create false attention. **Complete.**
- Task 3/5 — Deliberate toast click uses Chrome APIs only and may focus Chrome only because the user clicked. **Complete and physically accepted.**
- Task 4/5 — Native toast renders the persisted completion timestamp in local time without changing delivery/dedupe semantics. **Complete in v0.9.20.**
- Task 5/5 — Composer-adjacent timestamped Continue/Status/Checkpoint/Handoff toolbar is extension-owned, insert-only, draft-safe, runtime-attached, and isolated from automatic recovery/action budgets. **Complete in v0.9.20 baseline.**

### Stage 2/2 — Quick-Prompt Layout Hardening

#### Step 1/1 — Keep manual controls attached to the composer without owning ChatGPT UI layers

##### Gate 1/1 — Expanding composer and native popups remain unobstructed

- Task 1/3 — Anchor toolbar geometry to the full composer/form container, not the send button; observe composer size changes and reposition without overlap. **Active — #436.**
- Task 2/3 — Lower toolbar stacking below ChatGPT-owned popover/menu/modal layers while keeping it above normal page content. **Active — #436.**
- Task 3/3 — Replace static timestamp-description tooltips with a live current-time preview using the same formatter as the inserted prompt. **Active — #436.**

## Workstream 3/5 — Installation, Release, and Acceptance

### Stage 1/1 — Managed Installation and Publication

#### Step 1/1 — Preserve exact-source deploy/update/rollback

##### Gate 1/1 — Published and installed identity remain reconcilable

- Task 1/3 — Per-user installer preserves the stable unpacked extension root. **Complete.**
- Task 2/3 — Managed updater/release workflow publishes exact validated source and handles existing releases idempotently. **Complete through v0.9.20.**
- Task 3/3 — Protected Glass deployment/rollback reports installed source/version and never mutates Chrome registration/profile automatically. **Complete through v0.9.20; required for #436 rollout.**

Operational policy: operator interaction is a last resort. Safe non-interactive managed-update, loopback-helper, protected Glass, and repository-defined automation paths must be exhausted before requesting a manual click/install/reload/command.

## Workstream 4/5 — Reliable Background Automation

### Stage 1/3 — Coordinated Continuation

#### Step 1/1 — Own and revalidate one terminal turn

##### Gate 1/1 — Only contract-eligible, identity-matched turns may continue

- Task 1/3 — Durable transactional turn ownership and dedupe. **Complete.**
- Task 2/3 — Separate read-only observation from authorized DOM action and preserve document/conversation/prompt/assistant/revision identity. **Complete.**
- Task 3/3 — One shared continuation predicate covers LIMIT, TOOL_FAILURE, and CONTINUE while HANDOFF remains notification-only. **Complete since v0.9.18; retained.**

### Stage 2/3 — Reliable Delivery and Recovery

#### Step 1/1 — Deliver once and recover within persisted budgets

##### Gate 1/1 — Uncertain delivery never authorizes duplicate generation

- Task 1/4 — Durable outbox, stable notification IDs, helper ACK, dismissal/restart deduplication. **Complete.**
- Task 2/4 — Unified finalization, version-aware attachment, reconnect/replay and diagnostics. **Complete.**
- Task 3/4 — Existing explicit-interruption/silent-stop recovery preserves Pause/user guards, identity, action budgets and uncertainty vetoes; verified current-request interruptions may outrank only stale generating/tool affordances. **Complete baseline through v0.9.20.**
- Task 4/4 — Replace one-reload explicit-interruption behavior with persisted five-attempt / five-minute retry scheduling, then exactly one guarded Continue on exhausted retries. Keep silent-stop at its separate accepted three-reload bound. **Active — #436.**

### Stage 3/3 — Runtime Acceptance

#### Step 1/1 — Prove current source on the workstation

##### Gate 1/1 — Source, install state, runtime liveness and visible behavior agree

- Task 1/4 — Exact candidate architecture/helper/installer proof. **Complete through v0.9.20; re-run for #436 candidate.**
- Task 2/4 — Live bridge/runtime heartbeat and current-version identity proof. **Complete through v0.9.20; re-run for #436 candidate.**
- Task 3/4 — Physical click and foreground/navigation behavior accepted without native foreground fallback. **Complete.**
- Task 4/4 — Live acceptance for expanding-composer toolbar placement, native-popup stacking, timestamp preview, and a naturally or deterministically reproduced interruption recovery path. **Pending #436 implementation.**

## Workstream 5/5 — Status Contract and Bounded Recovery

### Stage 1/4 — Retain the Contract

#### Step 1/2 — Retain canonical work-session classification

##### Gate 1/1 — Long chats preserve exact terminal semantics

- Task 1/3 — Reconcile source/install identity and active work before mutation. **Complete; retained.**
- Task 2/3 — Canonical scope retention, carry-forward capsule, final check and START signal. **Complete.**
- Task 3/3 — Versioned grammar parity and long-conversation fixtures. **Complete.**

#### Step 2/2 — Activate v2 same-chat continuation semantics

##### Gate 1/1 — Consumer compatibility precedes producer activation

- Task 1/3 — Define `github-work-status/v2` with `INCOMPLETE_CONTINUE`, narrow HANDOFF to explicit transfer, and retain LIMIT/TOOL_FAILURE meanings. **Complete.**
- Task 2/3 — Implement the v1+v2 consumer with one shared continuation predicate across dispatch, page revalidation, normal observation and recovery paths. **Complete.**
- Task 3/3 — Validate, install, prove live v1+v2 capability, then activate producer v2. **Complete.**

Acceptance: one exact terminal footer remains sufficient. Missing/malformed footer is passive; no second action marker, free-text terminal inference, or browser format-repair prompt is permitted. Unsupported contract/digest combinations fail closed.

### Stage 2/4 — Observe Every Pending Request

#### Step 1/1 — Observe current request without historical leakage

##### Gate 1/1 — Only fresh assistant/current-run state may authorize automation

- Task 1/4 — Enrollment, human-run identity, auto-recognition and sticky Pause. **Complete.**
- Task 2/4 — Current-request observation excludes hidden/detached/quoted/prose historical errors and remains document/prompt bound. **Complete.**
- Task 3/4 — Bounded structural diagnostics, separate attention/history and quiet close. **Complete.**
- Task 4/4 — Broaden current-request semantic interruption recognition for timeout / systems-busy / response-generation failure surfaces without admitting historical message text as recovery evidence. **Active — #436.**

### Stage 3/4 — Recover Within a Budget

#### Step 1/1 — Bound reload/continuation behavior

##### Gate 1/1 — Recovery cannot loop or replay uncertain side effects

- Task 1/4 — Durable incident/run budget, breaker, earliest alarm, restart reconstruction and user vetoes. **Complete.**
- Task 2/4 — Silent stop: up to three reload/reinspections then at most one eligible continuation. **Complete; retained.**
- Task 3/4 — Explicit interruption: up to five total reload/reinspections with five-minute spacing between surviving attempts, then at most one eligible continuation. **Active — #436.**
- Task 4/4 — Regression coverage for resolution after any reload, retry-cap exhaustion, restart reconstruction, user vetoes, duplicate prevention, and no infinite loop. **Active — #436.**

Current defaults after #436 is accepted: 30-second missing-footer grace; silence requires at least 90 seconds idle and two consistent inspections at least 30 seconds apart; 15-minute ambiguous-thinking diagnostic without forced retry; silent-stop reload cap 3; explicit-interruption reload cap 5; explicit-interruption retry interval 5 minutes after a failed reload/reinspection; at most one recovery continuation per incident; zero format-repair prompts; at least 30 seconds profile spacing; persisted 12-generation-producing-action ceiling per human-started run. Reset only by a genuinely new trusted human request or explicit Resume.

### Stage 4/4 — Prove and Roll Out

#### Step 1/1 — Require deterministic and live proof at the changed trust boundary

##### Gate 1/1 — Release and contract activation require exact accepted evidence

- Task 1/5 — Repair and prove source decisions. **Active for #436.**
- Task 2/5 — Automatic bounded read-only Glass runtime evidence. **Required after candidate deployment.**
- Task 3/5 — Guarded Glass-only candidate deployment/rollback with no Chrome registration mutation. **Required; use existing protected lane.**
- Task 4/5 — Real current-build acceptance for the changed UI/recovery boundary. **Pending implementation/validation.**
- Task 5/5 — Merge/release, managed update identity, roadmap closeout. **Pending #436 acceptance.**

## Continuing work

The v0.9.17 click/registration incident, v0.9.18 status-contract v2 amendment, v0.9.19 explicit-interruption precedence regression, and v0.9.20 timestamp/quick-prompt rollout remain **complete**.

**Current active work is #436** on branch `fix/quick-prompts-timeout-recovery`. Finish the quick-prompt geometry/layering/live-time fixes and persistent explicit-interruption retry scheduler, add deterministic regressions, run full validation, deploy via the protected Glass lane without operator action, collect fresh runtime evidence, then close the issue/roadmap only after accepted live proof.

Preserve loopback-only helper transport, rolling coded history, durable ACK/deduplication, unified Monitor/Recover enrollment, sticky Pause/user guards, current-request interruption attribution, stable extension ID/root, updater/rollback, passive missing-footer behavior, deliberate-click-only foregrounding, local toast timestamps, and insert-only quick prompts. Do not add ChatGPT API/session polling, original-prompt replay, Regenerate, auto-approval, unbounded retries, free-text continuation inference, browser format repair, automatic foregrounding, native foreground fallback, or automatic Chrome registration/profile mutation.
