# Traffic-safety live acceptance — 2026-09-17

## Status

**Accepted.** The profile/account-level traffic-safety gate is implemented, validated, live-accepted on Glass, and canonical on notifier `main` through PR #83.

This acceptance does **not** attribute the original ChatGPT “too many requests” incident solely to the notifier. The timing exposed a plausible automatic-action path and justified a stop-ship gate; future incidents should be attributed from the action ledger rather than intentionally reproduced.

## Canonical traffic-safety source

- Implementation PR: #83 — `fix: add profile-wide traffic safety gate`
- Exact validated implementation head: `6287972d62c2bd600e77814771637ad4c070fb63`
- Canonical squash merge: `0a8c7ab8b2dc793a03dd3a72232e7c75b4cf137f`
- Exact-head workflows: source/build/isolated Setup, installed-Chrome fresh-load, runtime evidence, and Store-package validation all passed.

The implementation provides:

- passive observation that does not itself create a ChatGPT page request;
- a fresh-current-runtime authorization requirement that prevents stale recovery replay after extension/service-worker restart or re-enable;
- one profile-wide five-minute minimum between automatic page-affecting recovery actions;
- a persistent breaker opened by current rate-limit / “too many requests” evidence;
- a bounded local action ledger without prompt/response content;
- one shared guard covering bounded recovery and normal coded continuation.

## Live Glass acceptance

Traffic safety was accepted on top of the separately accepted `Extension-v2` persistence lineage so the live test did not regress the installation repair.

- Exact combined source: `0b4d045c92accc62c7914b2c0bcf2b0a33a71741`
- Combined exact-head workflows: all four passed again.
- Protected deploy: Glass run `35271989869`; installed v0.9.29 source `0b4d045...` under `GLASS\dan`; helper/listener healthy; runtime evidence present; rollback available; extension identity deferred.
- Read-only post-deploy status: Glass run `35272448291`; passed with `mutationPerformed=False`.
- Operator then enabled intended fixed-ID extension `lciedmoiiapbgemklkpoadimhffaaaah` in normal Chrome UI.
- Read-only post-enable status: Glass PR #166 / run `35273071404`; passed with exact installed source `0b4d045...`, helper/listener healthy, runtime evidence present, rollback available, and `mutationPerformed=False`.

Acceptance intentionally did **not** send a synthetic Continue, force a reload, or reproduce throttling.

## Release and persistence boundary

The live Glass source remains `0b4d045...` because it combines the accepted traffic safety with the distinct-root persistence candidate. The temporary integration PR #85 was consumed for acceptance and closed unmerged after PR #83 became canonical.

DevelopmentInfrastructure #443 still owns the deferred Windows reboot/login persistence gate for `Extension-v2`. PR #80 remains the authoritative persistence source lane. Normal version/release advancement must not bypass that physical reboot gate, and the older persistence-only source must not be redeployed over the current combined live runtime.

DevelopmentInfrastructure #473 records the completed traffic-safety work and final evidence. DevelopmentInfrastructure #470 separately owns request-owned error classification.
