# ChatGPT Response Notifier

Canonical source: **thatoneguydan/chatgpt-response-notifier**.

Current shipped/runtime line at this checkpoint:

- **ChatGPT Response Notifier 0.9.101**
- **ChatGPT Quick Continue 1.2.35**
- Canonical `main` after Quick Continue 1.2.35 feed publication: `0af6b476ca2409cda6cc415267bf6df32674a8e4`

Always reconcile current GitHub `main`, releases, and installed Glass evidence before making a newer status claim.

## Read next

- [RELEASE_NOTES.md](RELEASE_NOTES.md) — current notifier behavior and recent release history.
- [ROADMAP.md](ROADMAP.md) — long-form workstream history plus explicitly planned future work. Its older dated “current priorities” sections are historical checkpoints, not authority over a newer `PROJECT.md`/release state.
- [Independent failure review](docs/INDEPENDENT-FAILURE-REVIEW-2026-09-16.md) — historical investigation and acceptance matrix that drove the reliability work.
- DevelopmentInfrastructure [#443](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/443), [#442](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/442), and [#453](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/453) are **completed historical owners**, not active blockers.

## Current checkpoint — 2026-10-01

The active extension repair line requested through October 1 is complete in canonical source and deployed on Glass.

Notifier **0.9.101** preserves Monitor, manual timestamp, and Simple state while a fresh unsaved ChatGPT route becomes an assigned conversation and suppresses ordinary composer typing before unrelated document-wide terminal/status observers wake. The normal/smart watchdog continues to honor the shared `watchdog.stopOnStatus` classification table; Quick Continue no longer exposes user-configurable respect gates for that normal watchdog. Release validation and Glass installation verification for 0.9.101 remain accepted.

Quick Continue **1.2.35** preserves the 1.2.34 new-chat state-transfer, typing-performance, and exhausted-Simple behavior, and moves the two status-class respect controls to the place they actually belong: `simpleWatchdog`.

Current JSON ownership is:

```json
"watchdog": {
  "timerMinutes": 30,
  "attempts": 3,
  "stopOnStatus": {
    "PLANNING_ACTIVE": true,
    "COMPLETE_APPLIED": true,
    "COMPLETE_NO_CHANGES": true,
    "BLOCKED_HUMAN": true,
    "INCOMPLETE_LIMIT": false,
    "INCOMPLETE_TOOL_FAILURE": false,
    "INCOMPLETE_CONTINUE": false,
    "INCOMPLETE_HANDOFF": false
  }
},
"simpleWatchdog": {
  "timerMinutes": 30,
  "attempts": 3,
  "stopToRefreshSeconds": 30,
  "refreshToContinueSeconds": 30,
  "respectStopStatusCodes": true,
  "respectContinueStatusCodes": true
}
```

`watchdog.stopOnStatus` remains the shared classification table: `true` means stop class and `false` means continue class. The two `simpleWatchdog.respect*StatusCodes` switches control whether Simple acts on each class. Setting either switch to `false` means **ignore that class**; it never inverts the class into the opposite action.

For Simple:

- a respected stop-class terminal footer turns Simple off;
- an ignored stop-class footer leaves the Simple timer unchanged;
- a respected continue-class footer sends one immediate Continue, consumes the same finite Simple attempt budget, deduplicates that exact conversation/assistant-turn/status footer, and starts the next Simple countdown;
- an ignored continue-class footer leaves the Simple timer unchanged;
- if a respected continue-class footer consumes the final allowed attempt, Simple remains enabled/green in `Auto-continues exhausted` state until explicitly turned off;
- a terminal footer already visible when Simple is enabled is baselined and cannot fire merely because the runtime is enabled or hot-replaced.

Existing saved 1.2.33/1.2.34 configurations that still have the two respect flags under `watchdog` migrate automatically: their values are carried into `simpleWatchdog`, and the normalized saved/serialized config removes those keys from `watchdog`.

Recent canonical integration sequence:

- PR #267 — new-chat toggle persistence, original status-code gates, and remaining typing-lag observer work.
- PR #268 — 0.9.101 release-note/version fixture repair.
- PR #269 — browser runtime fixture alignment and release-inert test-only merges.
- PR #270 — Simple remains enabled after attempt exhaustion; Quick Continue 1.2.34.
- PR #274 — move status-class respect gates into Simple, add exact terminal-footer handling/migration, and release Quick Continue 1.2.35.

Exact-head validation for PR #274 passed the notifier/source validator, Quick Continue live-controls probe, Chrome Web Store package validation, and Playwright extension regressions. Release `quick-continue-v1.2.35` targets source `3d5a541c624e77ff2728060128ae2996088ba10d`; its managed ZIP SHA-256 is `8499b82698f2f59070fb571155d80bff7c0785e740fca9d2072ed350259fc1cc`. The independent release workflow built/published the release and installed/verified Quick Continue 1.2.35 on Glass successfully.

At this checkpoint there are no intended open implementation PRs for this work. Do not resurrect older draft/acceptance work merely because a historical roadmap section names it as “current.” Start future extension work only from fresh canonical state plus a new user request or newly observed regression.

### Planned but not active

ROADMAP Workstream 6/6 — Firefox Android handoff / browser-independent reception — remains a planned future feature. It is not implemented by this checkpoint and is not part of the completed reliability repair unless the operator explicitly resumes it.

Chrome Web Store migration remains contingency rather than the active distribution path.

## Boundaries

- **Permanent install-independence policy:** ChatGPT Response Notifier and ChatGPT Quick Continue are deployed independently. Never hold either extension's requested install or update for human/user testing, live proof, acceptance evidence, or unresolved acceptance work for either extension. Human testing may inform follow-up debugging after installation, but it is not an installation prerequisite unless the operator explicitly requests that gate for that specific deployment.
- Observe existing ChatGPT requests only: no ChatGPT API/session polling, duplicate backend requests, broad background scraping, or constant-refresh behavior.
- Preserve profile/account traffic safety, persistent rate-limit breaker/governor behavior, request identity, durable attempt budgets, and authentication/approval/rate-limit vetoes.
- Do not write Chrome Preferences, Secure Preferences, or external integrity state to repair registration.
- Do not use recurring/production CDP `loadUnpacked`, native Win32 foreground routing, Chrome process/window enumeration, or undocumented virtual-desktop switching as passive repair machinery.
- Preserve the fixed notifier registration/root, exact extension-origin validation, loopback-only helper, rollback lineage, and protected deployment gates.
- Passive monitoring and notification presentation must not steal focus. Physical notification clicks may use the accepted explicit user-initiated route to the existing target chat.
- Do not export conversations, raw Chrome profiles, credentials, signing secrets, or unnecessary user paths in evidence.

## Operator interaction

Complete safe deterministic source, validation, release, and deployment work before asking for manual action. Do not reintroduce already-completed reboot/login, cross-desktop click, Store-registration, or old draft-PR acceptance gates unless current evidence demonstrates a regression that actually requires them.

For future work, treat this file plus current GitHub `main`, release metadata, and current Glass evidence as the continuity entrypoint. Historical roadmap/review documents explain why earlier decisions were made but do not override a newer accepted runtime state.
