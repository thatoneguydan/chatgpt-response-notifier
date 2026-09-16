# v0.9.27 hidden-window diagnostics — installed checkpoint

Date: 2026-09-15. Authority: DevelopmentInfrastructure #439.

## Current state

Notifier v0.9.27 is published and installed on Glass. This release is diagnostic instrumentation, not a claimed hidden-window fix.

Validated candidate source: `d87d80a08093d985aad315b2fc6fa837535b7e4e`.

- exact-head validation run: `35027713156` — success
- candidate artifact: `10419289977`
- artifact digest: `sha256:3fe89305ef47f97386b9acf437eacf14186a77eefd0ce36a1c0fc77489543685`
- notifier PR #56 merged as `c86261e1a3b987f6fac7f04b078aac9ff45d5988`
- release workflow: `35029842133` — success
- release: `v0.9.27`
- managed ZIP digest: `sha256:d6a77e2113c6db9fffdcb7565ab372f3c47a2a56801fd6c67eff624a5b305c33`
- Setup EXE digest: `sha256:22a41a28d7780ec1ea9c859c4f3c1faa402582966afbd81db50cd411139943cc`

Protected Glass deployment:

- Glass PR #143, closed unmerged after guarded execution
- bridge run `35040349647` — success
- request ID `notifier-v0927-deploy-20260915`
- installed version: 0.9.27
- installed source: `d87d80a08093d985aad315b2fc6fa837535b7e4e`
- helper listener owned: true
- rollback available: true
- extension identity deferred: false

## Post-install proof

The exact-source runtime-evidence job was rerun after deployment:

- workflow run `35027713122`, fresh job `104619459156` — success
- evidence artifact `10425037384`
- artifact ZIP digest `sha256:8687d86d659892858075ea4c7953bd5935d61c6b0d89545cfd42b45c63decba7`

Safe evidence reports:

- installed/current/historical extension version = 0.9.27
- source = `d87d80a08093d985aad315b2fc6fa837535b7e4e`
- bridge connected = true
- extension connection live = true
- `hiddenWindowDiagnostics` survives the full extension → helper → safe-evidence projection
- diagnostic bounds: 20 incidents, 48 transitions per incident, 131072 bytes projected metadata
- retained incidents: 1
- host evictions: 0

The retained incident is from the deployment/update lifecycle, not the target hidden-window failure. It began at 2026-09-16T00:30:25.833Z while the page/window was visible, focused, active and maximized. It captured request and stream observation, then pagehide/visibility-hidden during the deployment transition. The request later records `traceState=insufficient-evidence`, `firstUnresolvedBoundary=page-query-error`, and a `stream-final-not-observed` diagnostic deadline. This is useful proof that uncertainty and lifecycle transitions survive retention; it is not evidence that `page-query-error` causes the user's unfocused-window failure.

## What is complete

The v0.9.27 Step 1 diagnostic implementation is built, tested, published, protected-deployed and proven through the safe-evidence export. Do not repeat timer/rAF/focus guesses and do not build another behavior release before a real failing trace selects the repair branch.

The diagnostic surface now records bounded transport/protocol counters, request/document/stream correlation, ambiguous mapping, page-query issue/reply/error/deadline, page visibility/focus/freeze, tab frozen/discarded, window focus/state, stream-final deadline, retention completeness and explicit first unresolved boundary. Diagnostic evidence cannot authorize notifications or automatic Continue.

## Next required action

A human must create the condition telemetry cannot safely manufacture: a notifier-eligible coded completion while Chrome remains unfocused/occluded, preferably on another Windows virtual desktop because that is the previously reproducible failure condition.

During that test:

1. Keep the ChatGPT Chrome window on the other Windows virtual desktop or otherwise genuinely unfocused/occluded.
2. Let a build chat reach a notifier-eligible terminal status without returning focus to Chrome.
3. Note whether the native notification arrives before Chrome is brought back into view.
4. After the response is complete, return to the work chat and report only whether the notification arrived while hidden and, if useful, the approximate local time. Do not reload Chrome or manually restart the helper before evidence is collected.

The receiving chat must then immediately rerun the exact-source runtime-evidence collector from run `35027713122`, inspect `safeRuntimeEvidence.hiddenWindowDiagnostics`, identify the first unresolved/failing boundary, and choose only the corresponding repair branch from the v0.9.26 diagnostic handoff. If the trace is incomplete, improve only the missing diagnostic boundary; do not infer a cause.

## Acceptance boundary

DevelopmentInfrastructure #439 remains open. The issue can close only after a real hidden/unfocused completion produces a native notification before focus returns and the retained evidence is correctly attributed, or after an evidenced failing trace is repaired and that acceptance subsequently passes.
