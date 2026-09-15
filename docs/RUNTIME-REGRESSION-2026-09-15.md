# Runtime regression checkpoint — 2026-09-15

## Observed failure

At approximately 2026-09-15T12:32:00Z, an enrolled build chat ended with the exact terminal footer `[GITHUB_STATUS: INCOMPLETE_LIMIT]`, but the installed v0.9.17 notifier did not automatically submit the configured continuation text.

This is a regression against the accepted v0.9.17 behavior. `INCOMPLETE_LIMIT` is already an auto-continuable status in the installed contract; the failure is therefore being investigated independently of the planned v2 `INCOMPLETE_CONTINUE` amendment.

## Evidence goal

Capture the helper's bounded runtime-evidence buffer as soon as possible after the failure and determine whether the coded terminal was observed, claimed, refused by an enrollment/budget/user guard, or lost before the continuation action. Do not infer the cause from absence of a notification or from older heartbeat evidence.

## Rollout gate

Do not deploy or activate producer v2 until PR #41 both removes remaining LIMIT-only consumer routing and includes enough sanitized continuation-decision diagnostics to localize this failure class.
