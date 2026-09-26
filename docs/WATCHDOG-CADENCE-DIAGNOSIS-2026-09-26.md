# Watchdog cadence diagnosis — 2026-09-26

Work owner: [DevelopmentInfrastructure #612](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/612).
Baseline: main `35a06c94dce06ce058d6003a967d9de53c37a631`, Notifier 0.9.88 / Quick Continue 1.2.21.
User requirement: one automatic Continue per watchdog expiry, then a fresh 30-minute interval. Stop this Work investigation once remaining repair is deterministic.

## Checkpoint 1 — source defects located; runtime attribution still open

The supplied screenshot shows Continue messages at 09:50 twice, 09:51, 09:52 twice, 09:53, 09:54, and 09:55 America/New_York. It shows a stopped timer with three attempts left at the bottom. Do not infer the final stopped state existed throughout the capture.

PR #237 removed bounded-recovery sends. PR #238 vetoed legacy continuation primitives and removed invariant-created one-minute alarms. Those changes do not cover all timing and delivery ambiguity paths inside the watchdog itself.

Confirmed source findings requiring behavioral reproduction:

1. `monitor-background.js:handleCodeWatchdogAlarmState` checks existence, stopped/enrollment/budget, but does not check the persisted deadline or elapsed time since a previous send before calling the page sender. The page-authority wrapper checks due state before entering the mutation queue; the queued authoritative handler does not repeat it. A stale alarm or already-queued duplicate can therefore pass an obsolete outer check.
2. `status-script.js:performWatchdogContinuation` explicitly returns `{ok:false, clicked:true}` after a click when a user turn is not observed within 3500 ms, or when a page error is visible. `monitor-background.js` ignores `clicked` and turns every non-ok result into a 60000 ms retry. Failed confirmation is not proof no message was sent.
3. `sendCodeWatchdogContinuation` repeats the command after a messaging exception without an idempotency identity; this can replay an uncertain first dispatch.
4. Deadline/counter/reset state is written after the send result. There is no durable pre-dispatch reservation protecting the external side effect across response loss or worker restart.

Evidence separation:

- Release run `36245774427` / job `108414906435` reported installed 0.9.88 at 2026-09-26 13:39:48Z.
- That acceptance script only compares the helper's installed version. It does not establish the currently loaded worker/page version or successful 30-minute behavior.
- Runtime run `36213973353` attempt 1 / artifact `10896114254` is an older 03:10Z snapshot of loaded 0.9.87. It predates the reported morning failure and cannot attribute it.
- A bounded rerun of that existing read-only collector is requested to capture current Glass evidence. It reads existing sanitized helper evidence; no live conversation messages, page refreshes, preference changes, or runtime deployment.

Next: reproduce the internal send/cadence gaps against actual canonical functions, inspect the new runtime evidence, then specify the single-owner transaction/state transition and acceptance matrix. Do not declare the live issue fixed or deploy another wrapper as an unproven workaround.

## Continuation contract

GitHub status contract: `github-work-status/v2`; grammar SHA-256 `a2570315b911add3c57231f08b84214daa56750f9c93fd76c5d8b459d28c3efb`.
This work segment requires a terminal-only final `[GITHUB_STATUS: CODE]` line. START was already emitted for the human request. Retain applicability on continuation, interruption, and tool failure. Canonical definitions remain in DevelopmentInfrastructure/GITHUB-WORK-STATUS-POLICY.md.
