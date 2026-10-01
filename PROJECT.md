# ChatGPT Response Notifier

Canonical source: **thatoneguydan/chatgpt-response-notifier**.

Current shipped/runtime line at this checkpoint:

- **ChatGPT Response Notifier 0.9.102**
- **ChatGPT Quick Continue 1.2.36**
- Canonical `main` after Quick Continue 1.2.36 feed publication: `1817ddb68f03a1e68e377b5947460d9ac7ac4662`

Always reconcile current GitHub `main`, releases, and installed Glass evidence before making a newer status claim.

## Read next

- [RELEASE_NOTES.md](RELEASE_NOTES.md) — current notifier behavior and recent release history.
- [ROADMAP.md](ROADMAP.md) — long-form workstream history plus explicitly planned future work. Its older dated “current priorities” sections are historical checkpoints, not authority over a newer `PROJECT.md`/release state.
- [Independent failure review](docs/INDEPENDENT-FAILURE-REVIEW-2026-09-16.md) — historical investigation and acceptance matrix that drove the reliability work.
- DevelopmentInfrastructure [#443](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/443), [#442](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/442), and [#453](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/453) are **completed historical owners**, not active blockers.

## Current checkpoint — 2026-10-01

The active extension repair line requested through October 1 is complete in canonical source and deployed on Glass.

Notifier **0.9.102** preserves the accepted 0.9.101 new-chat state-transfer and typing-performance behavior, and exposes its existing rendered-terminal authority as a sanitized in-page status bridge. The normal notifier detector remains the single authority for terminal-footer DOM interpretation and for the shared `watchdog.stopOnStatus` stop/continue classification, including the already-proven sibling-footer handling. Release validation and Glass installation verification for 0.9.102 succeeded.

Quick Continue **1.2.36** removes the duplicate Simple terminal-footer parser and duplicate status classification logic introduced in 1.2.35. Simple now consumes only the notifier authority's sanitized terminal identity, status code, and `stop`/`continue` class, then applies its own two respect switches. A read-only canonical-terminal query baselines a footer already visible when Simple is enabled or restored. Quick Continue 1.2.36 was built, published, installed, and verified on Glass successfully.

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

- terminal-footer detection and stop/continue classification are owned by the normal notifier authority; Simple does not maintain a second DOM parser or classification table;
- a respected stop-class terminal footer turns Simple off, including when Simple is still green in `Auto-continues exhausted` state;
- an ignored stop-class footer leaves the Simple timer/state unchanged;
- a respected continue-class footer sends one immediate Continue, consumes the same finite Simple attempt budget, deduplicates that exact conversation/assistant-turn/status footer, and starts the next Simple countdown;
- an ignored continue-class footer leaves the Simple timer/state unchanged;
- if a respected continue-class footer consumes the final allowed attempt, Simple remains enabled/green in `Auto-continues exhausted` state but sends no further continue-class actions until explicitly turned off or a respected stop-class footer turns it off;
- a terminal footer already visible when Simple is enabled is baselined and cannot fire merely because the runtime is enabled or hot-replaced.

Existing saved 1.2.33/1.2.34 configurations that still have the two respect flags under `watchdog` migrate automatically: their values are carried into `simpleWatchdog`, and the normalized saved/serialized config removes those keys from `watchdog`.

Recent canonical integration sequence:

- PR #267 — new-chat toggle persistence, original status-code gates, and remaining typing-lag observer work.
- PR #268 — 0.9.101 release-note/version fixture repair.
- PR #269 — browser runtime fixture alignment and release-inert test-only merges.
- PR #270 — Simple remains enabled after attempt exhaustion; Quick Continue 1.2.34.
- PR #274 — move status-class respect gates into Simple, add migration, and release Quick Continue 1.2.35.
- PR #277 — remove Simple's duplicate terminal parser/classifier, reuse the normal notifier terminal authority, and release Notifier 0.9.102 with Quick Continue 1.2.36.

PR #277 merged at `fb05ce65cfb82cd79f627d283ab0146543da3876`. The production notifier workflow passed source validation, built and published **ChatGPT Response Notifier 0.9.102**, and installed/verified it on Glass. The independent Quick Continue workflow validated, built, published, and installed/verified **ChatGPT Quick Continue 1.2.36** on Glass. Release `quick-continue-v1.2.36` targets `fb05ce65cfb82cd79f627d283ab0146543da3876`; its managed ZIP SHA-256 is `9507d943c0f87dde6a14a1323342516e380bba4c8340cc2a522bab7911378576`. The canonical update feed records the same source commit and digest.

The final exact-head source validator for PR #277 also passed extension architecture/source checks, helper/installer/candidate build, isolated Setup, legacy-root preservation, stable-root replacement, localhost helper handshake, and candidate upload. Earlier runtime-equivalent heads passed Chrome Web Store package validation, Quick Continue live-controls probing, Playwright extension regressions, runtime evidence collection, and fresh-load probing; the only pre-release installed-profile failure correctly rejected the then-stale 0.9.101 runtime before 0.9.102 was published.

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
