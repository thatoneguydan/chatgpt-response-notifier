# Notifier rate-limit incident — 2026-09-17

Status: **stop-ship for live automatic recovery**. The extension was disabled after ChatGPT began showing **“too many requests” shortly after the extension was enabled**. Keep the extension disabled for live use until the traffic-safety gate below is implemented and proven.

This checkpoint records the new field evidence and source-level implications. It does **not** claim that the notifier is the proven sole cause of the server-side rate limit. The timing is strong enough that automatic recovery must be treated as unsafe until disproven.

## What source inspection establishes

1. The extension does not intentionally issue its own HTTP fetch/XHR calls to ChatGPT. Production watches ChatGPT's existing `POST /backend-api/f/conversation` / `/backend-api/conversation` traffic through `chrome.webRequest`.
2. Automatic recovery can still create real ChatGPT traffic indirectly because it can:
   - reload ChatGPT tabs with `chrome.tabs.reload(...)`; and
   - click/submit continuation messages through the page, which then produce normal ChatGPT conversation requests.
3. Recognized work chats can auto-enroll into monitoring/recovery when a fresh request has a work-start signal or valid status code. Recovery is therefore not limited to a single manually enabled tab.
4. Current bounded-recovery policy permits, per incident/run, up to:
   - 3 silent-stop reloads;
   - 5 explicit-interruption reloads;
   - 1 recovery Continue per incident;
   - at least 30-second profile action spacing;
   - 12 generation-producing actions per trusted human-started run.
5. A rate-limit observation already opens a profile breaker, but this only helps **after** the page has surfaced and the monitor has classified the rate limit. It does not prove the extension cannot create a request burst or cumulative account-level pressure before that point.
6. The production worker currently composes the legacy recovery state layer, monitor layer, bounded-recovery executor, normal-continuation hook, and service-worker continuation path. Source inspection so far does not prove duplicate Send actions, but the layered composition increases the need for one authoritative profile-wide traffic ledger and adversarial restart/multi-tab tests.

## New safety conclusion

The existing recovery budgets are **bounded**, but they are not yet an adequate proof of **account-level request safety**. A finite loop can still be too aggressive if several work chats are enrolled, if stale incidents wake after extension restart/re-enable, or if full-page reloads amplify backend traffic beyond the single generation request the recovery model counts.

Do not re-enable live automatic recovery merely because the existing per-incident caps are finite.

## Immediate implementation contract

### Gate A — passive mode must be traffic-inert

Before any live re-enable, prove that notification/monitoring mode can run with **zero notifier-authored ChatGPT navigation or generation actions**. Passive observation may inspect DOM/runtime state and observe existing browser requests, but must not reload a ChatGPT tab, submit a prompt, create a ChatGPT tab, or otherwise cause ChatGPT network traffic without a direct user action.

### Gate B — no startup/re-enable replay burst

Extension startup, worker restart, helper restart, and re-enabling the extension must not automatically execute stale recovery work. Persisted incidents may be reconstructed for diagnostics, but automatic page-affecting actions require a fresh trusted human-started run after the current extension runtime is active, unless the operator explicitly resumes that exact incident.

### Gate C — one profile-wide traffic governor

Add one worker-owned governor covering **all** automatic page-affecting recovery actions across all ChatGPT tabs. It must own reload and continuation admission rather than relying only on per-incident budgets.

Until measured live evidence supports a less conservative value, use a provisional safety envelope of **at most one automatic page-affecting recovery action per five minutes profile-wide**. A reload counts as an action because it can generate many backend requests. A continuation Send counts as an action. This governor is in addition to, not instead of, existing per-incident limits.

### Gate D — hard persistent breaker on throttling evidence

The first current rate-limit / too-many-requests observation opens a persistent profile-wide breaker immediately. While open:

- no automatic reload;
- no automatic Continue;
- no replay of overdue incidents after worker restart;
- passive observation/notification remains allowed.

Clearing the breaker must require an explicit operator Resume and fresh current-page safety inspection. Merely waiting for a timer, restarting Chrome, restarting the worker, or updating the extension must not clear it.

### Gate E — authoritative action ledger

Persist a compact profile-wide action ledger sufficient to prove what the extension did around an incident:

- timestamp;
- conversation suffix / run identity;
- action kind (`reload`, `continue`, normal coded continuation);
- admission source/reason;
- whether a matching conversation POST was observed afterward;
- request status/result when available;
- breaker state before/after;
- extension runtime identity/document identity.

Do not log prompt/response content.

## Required tests before live use

Add deterministic composed tests for:

1. multiple enrolled work chats with simultaneous recoverable incidents — only the profile-wide governor winner may act;
2. extension disable/re-enable with overdue incidents — zero automatic actions until a fresh trusted run or explicit Resume;
3. worker restart with scheduled incidents — no action burst and no budget/governor reset;
4. rate-limit fixture arriving before an action — action vetoed and breaker persisted;
5. rate-limit fixture arriving immediately after an action — no second automatic action and breaker persists across restart;
6. reload followed by a new document that lacks original request state — no immediate retry solely because state is missing;
7. normal `INCOMPLETE_LIMIT` continuation plus bounded-recovery state present — at most one page Send / one matching accepted request;
8. passive monitoring with several open ChatGPT tabs for an extended virtual-time interval — zero `tabs.reload` and zero continuation commands.

## Live acceptance after source tests

Only after the deterministic tests pass:

1. enable the extension on Glass with automatic recovery initially paused/passive;
2. verify passive monitoring produces no notifier-authored page actions;
3. enable recovery for one fresh test run only;
4. capture the action ledger and existing correlated diagnostics for that run;
5. stop immediately if ChatGPT shows any rate-limit / too-many-requests state;
6. expand to multiple chats only after the single-run behavior is clean.

Do not ask the operator to repeatedly reproduce throttling as a diagnostic technique.

## Relationship to the 2026-09-16 independent review

The independent review correctly required finite recovery, persistent incident identity, rate-limit vetoes, and a breaker. This incident adds a higher-level missing acceptance property: **finite per-incident recovery is not enough; the extension must prove profile/account-level traffic safety across tabs and restarts before automatic recovery is considered deployable.**
