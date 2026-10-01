# ChatGPT Response Notifier

Canonical source: **thatoneguydan/chatgpt-response-notifier**.

Current shipped/runtime line at this checkpoint:

- **ChatGPT Response Notifier 0.9.101**
- **ChatGPT Quick Continue 1.2.34**
- Canonical `main` after Quick Continue feed publication: `494253b6605078014184aedabce0e90a3d5f20c6`

Always reconcile current GitHub `main`, releases, and installed Glass evidence before making a newer status claim.

## Read next

- [RELEASE_NOTES.md](RELEASE_NOTES.md) — current notifier behavior and recent release history.
- [ROADMAP.md](ROADMAP.md) — long-form workstream history plus explicitly planned future work. Its older dated “current priorities” sections are historical checkpoints, not authority over a newer `PROJECT.md`/release state.
- [Independent failure review](docs/INDEPENDENT-FAILURE-REVIEW-2026-09-16.md) — historical investigation and acceptance matrix that drove the reliability work.
- DevelopmentInfrastructure [#443](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/443), [#442](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/442), and [#453](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/453) are **completed historical owners**, not active blockers.

## Current checkpoint — 2026-10-01

The active extension repair line requested through September 30 is complete in canonical source and deployed on Glass.

Notifier **0.9.101** preserves Monitor, manual timestamp, and Simple state while a fresh unsaved ChatGPT route becomes an assigned conversation, adds independently configurable stop-class and continue-class status-code respect gates, and suppresses ordinary composer typing before unrelated document-wide terminal/status observers wake. Release validation and Glass installation verification completed successfully.

Quick Continue **1.2.34** carries the same new-chat state-transfer and typing-performance work and completes the literal Simple-toggle requirement: after its configured automatic attempts are exhausted, Simple remains enabled/green, displays `Auto-continues exhausted`, schedules no further Simple alarms, and clears only when the operator explicitly turns Simple off. Release `quick-continue-v1.2.34` was built from source `fb352bd631d8f9277414e24af6a93c0055a58571`, published, and installed/verified on Glass.

The status-policy JSON now exposes:

```json
"respectStopStatusCodes": true,
"respectContinueStatusCodes": true
```

`stopOnStatus` still assigns each definitive GitHub status to the stop or continue class. Disabling either respect flag means **ignore that class**; it does not invert the class into the opposite action.

Recent canonical integration sequence:

- PR #267 — new-chat toggle persistence, status-code gates, and remaining typing-lag observer work.
- PR #268 — 0.9.101 release-note/version fixture repair.
- PR #269 — browser runtime fixture alignment and release-inert test-only merges.
- PR #270 — Simple remains enabled after attempt exhaustion; Quick Continue 1.2.34.

Exact-head validation for the 1.2.34 integration passed the notifier/source architecture checks, Quick Continue live-controls probe, Chrome Web Store package validation, and a rerun of the Playwright extension suite at **22/22**. The independent Quick Continue release workflow then built, published, installed, and verified 1.2.34 on Glass.

At this checkpoint there are **no open pull requests or open issues in this repository**. Do not resurrect older draft/acceptance work merely because a historical roadmap section names it as “current.” Start future extension work only from fresh canonical state plus a new user request or newly observed regression.

### Planned but not active

ROADMAP Workstream 6/6 — Firefox Android handoff / browser-independent reception — remains a planned future feature. It is not implemented by this checkpoint and is not part of the completed September 30 reliability repair unless the operator explicitly resumes it.

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
