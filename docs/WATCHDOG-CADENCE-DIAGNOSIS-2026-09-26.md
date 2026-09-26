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

## Checkpoint 2 — failures reproduced; current runtime verified

Fresh bounded evidence: runtime workflow `36213973353`, attempt 2, job `108418879240`, artifact `10907419377` (SHA-256 `c895ff6b56146bbea4d1ccee649663a764120068a51ccb98f0fe660a2b4db2ad`). Snapshot observed at **2026-09-26 14:06:00Z** reports installed and live-loaded **0.9.88**, installed source `e5671eea48c826976413016901f4f951826bb2da`, fresh worker heartbeat 14:05:56Z and a live helper bridge. The collector source ref is the historical 0.9.88 PR head; the read-only collector ran now against current installed evidence. Do not confuse collector source with installed source.

The fresh snapshot contains 200 general records and 128 delivery records. It includes the reported conversation's shortened identifier in host dismissal records, but **zero watchdog dispatch/result/cooldown records**. The incident traces retain stream-read errors and mapping ambiguity; these cannot be claimed as the exact cause of this chat's repeated Sends. The observed screenshot is authoritative symptom evidence; code replay establishes viable failure paths. The exact historical triggering path remains unrecorded.

### Executable baseline reproduction

Run `node tools/reproduce-watchdog-cadence-20260926.mjs` from the repository root. This executes actual production monitor, policy, persistence-invariant, sole-authority, and page-authority modules in a VM with deterministic time, in-memory IndexedDB and stubbed Chrome message transport. It does not open Chrome, transmit messages, or contact ChatGPT. The page sender's possible production outcomes are injected at the transport boundary; this is not a live-browser acceptance test.

The script's assertions intentionally recognize the vulnerable baseline. Replace them with safe expected behavior in the production regression suite when implementing; a successful run of this diagnostic does **not** mean the product is fixed.

| Input sequence | Observed at baseline | Required after repair |
| --- | --- | --- |
| Alarm arrives while persisted deadline is 30 minutes in the future | 1 Continue command | 0 commands |
| Two page-authority expiry signals both pass their outer check before the queue executes | 2 commands in the same instant | 1 command, second claim rejected inside transaction |
| Page reports clicked=true, ok=false; repeat at +60 seconds | 2 commands; sendCount remains 0; original deadline remains expired | 1 command; durable cooldown retained and attempt accounted |
| First dispatch rejects after a possibly completed click | 2 immediate command dispatches via injection/retry fallback | At most 1 dispatch; outcome unknown, no replay |

The minute retry result explains how the UI can still show three attempts left after many real messages: the counter advances only on `ok:true`. The combination of a 3500 ms confirmation wait and a 60000 ms retry is consistent with the screenshot's roughly 1m03s cycles, but this timing match is an inference rather than a captured per-send trace.

### Why the earlier tests missed this

The 0.9.88 tests assert wrapper installation and absence of alarm creation in one invariant; they stub legacy primitives. They do not run the competing alarm/page entry points through the same persisted queue or simulate a click followed by missing confirmation/transport loss. Serializing callbacks prevents simultaneous execution but does not reject a second obsolete send after the first callback has advanced the deadline.

Quick Continue 1.2.21's atomic-send repair affects its human-operated buttons/timestamp sends. Its background timer checks managed updates, not automatic Continue. The notifier watchdog still uses its separate `status-script.js` sender, so the Quick Continue fix does not repair these paths.

## Settled repair contract — normal chat owns implementation

**The remaining work is deterministic. No product/runtime code was changed or deployed by this investigation.** Continue the same work claim and branch/PR; implement the contract below, then validate and deploy through the existing managed Glass route. Do not add another monkey-patch wrapper.

### 1. One authoritative state owner and atomic dispatch claim

Keep the existing monitor database/profile store; add a record schema marker without changing the IndexedDB database version used by existing readers. Move watchdog mutation ownership into `monitor-background.js` (or a directly imported state-owner module), using a short IndexedDB readwrite transaction for read/check/update. A transaction must finish before any browser messaging await.

All alarm, page nudge, startup restore, status, Stop/Pause, manual arm, and request observation paths use this owner. The in-memory per-conversation queue remains useful but is not the durable authority. The state owner's transition reducer must retain terminal monotonicity, prompt/run identity, attempts, and cooldown explicitly.

Remove the watchdog `IDBObjectStore.prototype` interception after moving its terminal/continuation preservation rules into that reducer. Route the direct writes currently in `watchdog-request-lifecycle-fix-background.js`, `terminal-watchdog-authority-background.js`, and `watchdog-sole-continuation-authority-background.js` through the same exported owner API. Their observers/notification work can remain; they no longer write a stale full watchdog record independently.

Use a durable attempt record within the watchdog state, with at least: attempt ID, request/run epoch, target tab/document/prompt, reservation time, authorization expiry, outcome (reserved/confirmed/unknown/definitively-not-clicked), and next-send eligibility time. Persist the attempt and consume its attempt budget **before** dispatch. A crash after reservation may conservatively skip one send; it must never permit a duplicate.

Immediately before granting the command, atomically reread current state and require:
- monitoring enabled, not paused/stopped, correct current epoch and applicable budget;
- a real positive send deadline has elapsed; zero/missing deadline is not due;
- the durable next-send eligibility floor has elapsed;
- no existing claim for that expired interval/attempt;
- target identity and prepared page runtime are still the ones inspected.

Do not let an expired historical `deadlineAt` OR a due `retryAt` bypass the cooldown. A page's due signal is a wake-up hint only. Both browser alarm and page hint must pass the same check **inside** the transaction after previous work has finished.

### 2. Reserve once; uncertainty never grants another Send

Before sending, use the non-mutating page query/handshake to establish a current compatible runtime and document identity. Send one `CHATGPT_WATCHDOG_CONTINUE_COMMAND` with the reserved attempt ID, epoch, target identity and a short authorization expiry. Delete the catch/inject/resend behavior from this send function. Injection belongs before reservation/dispatch, not after an uncertain result.

The page sender must validate the authorized document/prompt, current safety vetoes, expiration, and an in-flight/completed attempt-ID dedupe before clicking. Repeated delivery of the same token yields its cached/in-flight outcome without another click. It must not accept an expired or unrecognized legacy tokenless automatic command.

Preserve Pause/Stop and definitive-status vetoes before click. Use the existing composer safeguards; do not introduce an API call, refresh loop, new prompt wording, or focus change. Do not wait for the assistant's response before sending when the authorized watchdog boundary arrives.

A failed result after `clicked:true`, a missing user-turn confirmation, a page error after click, a disconnected message port, or a worker restart is an **unknown send outcome**, never permission to replay. Preserve the consumed attempt and the cooldown. A later observation can confirm that attempt, but cannot dispatch it again. Only a separately due next interval gets a new attempt.

Use a bounded command authorization window (10 seconds is sufficient for the existing 5-second pre-click readiness path). During uncertainty, reserve the next-send floor through **authorizationExpiresAt + 30 minutes**, so a click at the end of that window cannot be followed early after restart. When a trusted page acknowledgement includes actual `clickedAt`, set the normal next deadline to `clickedAt + 30 minutes`; reject impossible timestamps. The conservative unknown-outcome delay can be a few seconds longer than 30 minutes. Do not claim exactly-once delivery under crash uncertainty; enforce at-most-one attempt with no early replay.

### 3. Observation cannot shorten the send interval

Every current status/reconciliation/manual-arm transition must preserve the dispatch floor unless it is resolving that same attempt with a validated click timestamp. Trusted human/Quick Continue/Project sends start a fresh 30-minute timer; they do not make an old automatic attempt replayable. Existing legitimate counter-reset semantics can remain, but counters and cooldown are separate invariants.

Definitive terminal codes and Stop park the timer. Pause disables automatic actions. They invalidate any unconsumed authorization for the old epoch. A delayed async result must not unpark a stopped timer, reset a newer user's timer, or overwrite a newer attempt. Route changes and duplicate tabs share the conversation owner, while commands target an exact document.

Separate optional short **observation** retries from send eligibility. A 60-second observation retry may inspect whether a prior attempt landed or whether a veto cleared; it must not grant or repeat an automatic Send. Prefer the ordinary 30-minute timer display after an attempted dispatch, with attempts based on the durable reservation rather than DOM confirmation. Startup alarm reconstruction must use the same eligibility calculation, not prefer an expired deadline over a future cooldown.

### 4. Safe state migration and diagnostics

Migrate older records once under the state owner's transaction:
- preserve stopped/paused state and terminal reasons;
- preserve a known last automatic send plus a full 30-minute floor;
- for legacy expired/short-retry active records whose last side effect cannot be established, arm a fresh conservative 30-minute interval at migration time;
- never treat zero timestamp or absence of old confirmation as proof of no previous send;
- restore at most one wake-up alarm per monitored conversation after commit.

Add bounded sanitized events at claim refusal, reservation, dispatch, confirmed/unknown result, migration and restored wakeup. Retain attempt/document/request suffixes, worker version/source, revision/epoch, trigger, due time, eligibility time, click/outcome and remaining attempts. No prompt/response text, full conversation URLs, credentials or profile paths. Carry fields through the existing host sanitizer and evidence collector. Ensure terminal and error observation remains separate from action authority.

## Acceptance matrix and exact continuation

Convert the four diagnostic cases above into safe-behavior regression tests loading the **composed production bootstrap**, not source-string assertions. The in-memory test fixture must model IndexedDB request listeners, transaction completion and persistence across worker recreation; verify emitted commands/clicks and durable state, not just function call order.

Required additional boundary cases:
1. Three racing nudges (alarm and two tabs) for one expiry; exactly one reserved command.
2. Confirmed send at T; zero commands at T+1s, +60s and +29m59s; one at T+30m; the next interval behaves identically.
3. Clicked-but-unconfirmed, page error after click, message-port loss and worker restart; no replay and no return of consumed budget.
4. Worker stops after reservation/before dispatch and after dispatch/before result; persisted state permits neither immediate replay nor an early next attempt.
5. Delayed old results, stale status/request snapshots, restored alarms, and incomplete statuses cannot reduce the floor or resurrect Stop/Pause/terminal state.
6. A genuinely new trusted human or Quick Continue/Project message resets to 30 minutes. Preserve existing terminal notification and manual Stop behavior.
7. Offline/auth/approval/rate-limit/draft/upload/frozen/unobservable vetoes produce zero forbidden clicks.
8. The page sender refuses duplicate/expired attempt tokens, wrong document/prompt and an unsupported legacy runtime; no post-error reinjection/resend.
9. Migration covers stopped, known-send, poisoned short-retry and missing-confirmation records; repeated startup/migration is idempotent.

Then run the existing complete extension suite on Glass, bump/package the notifier via its existing release path, and verify a **fresh loaded worker and page runtime identity**, not only the helper's installed version. Inspect sanitized attempt logs for the new version. Controlled disposable-page/virtual-clock proof can accelerate multi-interval testing without sending test prompts into the user's real conversations. Keep real-world 30-minute acceptance explicitly open until observed; do not report another live fix solely from green source tests or install acknowledgement.

Normal-chat continuation starts at **claim #612 → this branch/PR → implement state-owner transaction and single-dispatch protocol above**. Reconcile current main before editing. No operator decision is needed. The requested Work boundary has been reached; remaining source changes, regression execution, packaging, managed deployment and live evidence collection transfer to normal chat.
