# Repository agent entry

Read the current project entry and active-work issue before material changes. Use an explicit non-default work branch and the existing ownership checks.

## Source validation and continuation

Use `.github/validation-profiles.json` and the owning workflow's **Plan affected source validation** step. The shared implementation is pinned to DevelopmentInfrastructure's `Shared/Validation/validation-reuse.mjs`. Run focused changed-behavior checks during iteration; accept the workflow's execute/reuse decision for final source proof. Inspect the existing run/attempt and cited executed job before retrying. Failed, missing, expired or unobservable evidence executes the affected checks. Do not replay a full suite solely for a merge, channel move or new chat. Package delivery, live diagnostics, protected admission, rollback and user apply authority remain on their existing current routes. Keep the active issue body current; shared operating rules are in DevelopmentInfrastructure.

