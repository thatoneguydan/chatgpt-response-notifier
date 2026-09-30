# Watchdog zero-send acceptance — 2026-09-30

## User-facing invariant

When an active watchdog reaches its deadline, uncertainty is biased toward sending the configured Continue text. Observation uncertainty must not silently consume an attempt or defer a due watchdog. Explicit safety/content blockers remain authoritative.

## Root cause

The watchdog cadence owner reserved an attempt before page dispatch. The page command could then return a successful-looking result even when it never clicked Send. Finalization treated that definitively unclicked dispatch like a consumed attempt and advanced the cadence, so the visible timer could reach zero without any Continue message being submitted.

A second fail-closed layer also rejected due sends when page observation or identity evidence was temporarily incomplete, even when no explicit blocker existed.

## Repair

- A definitively unclicked dispatch releases its cadence reservation, restores the prior attempt budget/deadline state, and remains eligible for retry.
- A click that may have fired remains consumed so uncertain post-click outcomes cannot replay and spam the conversation.
- Once the watchdog deadline is due, missing or ambiguous observation fails open toward a send attempt.
- Explicit blockers still prevent automatic sending: offline state, authentication/approval barriers, rate limits, a user draft, an upload, explicit pause/stop, and terminal GitHub status policy.
- Permanent regressions cover both no-click retry and uncertain-observation fail-open behavior.

## Exact accepted candidate

Notifier source: `d62a3f21787f1d1663f40ad014fe85b406ee0c97`

The exact candidate passed source/build validation, Chrome Web Store packaging, installed-system-Chrome fresh-load, runtime-evidence collection, Quick Continue live controls, Playwright MV3 regressions, and installed normal-profile acceptance. It was then deployed through the protected Glass broker to the logged-in `GLASS\dan` session with exact-source verification and rollback availability.

PR #254 merged that accepted source to canonical `main` as merge commit `52254a0ea50bea24114e34cfb69607802f4d5a3f`.

## Release follow-up

The first post-merge notifier release run was blocked by a stale test that still required Quick Continue and notifier publishing to share one concurrency group. PR #257 had intentionally decoupled those release queues. The release regression now checks the intended independent serialized groups while preserving non-cancellation and current-main rebase requirements.