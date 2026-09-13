# ChatGPT Response Notifier — Guarded User-Session Deployment Design

Status: Task 3/5 design checkpoint. This document does **not** authorize or perform a broker upgrade or workstation deployment.

Canonical rollout position:

`ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 4/4 — Prove and Roll Out → Step 1/1 — Validate the real background workflow → Gate 1/1 — Exact-source evidence supports enabling recovery → Task 3/5 — Add the guarded Glass-only candidate deployment/rollback lane`

## Existing broker constraints

The standing Glass User Session Deployment Broker is the correct execution boundary because the notifier must be installed in Dan's real interactive Windows profile while the normal Glass runner is `NETWORK SERVICE` in session 0.

The existing broker already provides the required security properties:

- `InteractiveToken` + `LeastPrivilege` execution in Dan's session;
- fixed GitHub repository/workflow/actor/run identity through OIDC;
- request and artifact hashes bound into the OIDC audience;
- project/action policy and installed adapter hash verification;
- constrained Inbox/Outbox access for the runner;
- no requester-supplied commands, paths, destinations, registry paths, or arbitrary arguments;
- one bounded transaction per task instance.

Two current core limits matter for this project:

1. each project may allow at most 16 artifact paths;
2. each artifact file is currently capped at 5,000,000 bytes.

The validated notifier candidate contains a self-contained host executable around 188 MB, a managed bundle archive around 80 MB, and a Setup executable over 200 MB. Therefore the notifier cannot be onboarded merely by adding a policy entry under the current 5 MB global per-file limit.

## Required shared-broker change after lane ownership clears

Do **not** raise the global artifact limit.

Add one optional project policy field such as `maxArtifactFileBytes`:

- omitted projects retain the current 5,000,000-byte limit;
- the broker validates the optional value against a hard broker maximum;
- artifact validation uses the resolved project-specific limit;
- existing ChompBox and CPU Monitor policy/behavior remains byte-for-byte equivalent;
- notifier policy alone receives the larger bounded allowance required for one exact candidate bundle.

The broker must continue rejecting extra artifact paths, reparse points, undeclared files, hash mismatches, and unsafe relative paths. No generic command or executable path is added to request JSON.

This shared-broker source/policy work must wait until DevelopmentInfrastructure #384 releases `glass-deployment-lane`.

## Proposed notifier broker project

Project ID: `chatgpt-response-notifier`.

Trusted workflow ref:

`thatoneguydan/glass/.github/workflows/chatgpt-response-notifier-deployment-bridge.yml@refs/heads/main`

Recommended fixed actions, using the broker's existing maximum of four:

1. `user-preflight` — read-only installed identity, helper/session, startup registration, Evidence state, and rollback readiness;
2. `deploy` — install one exact validated candidate and retain a single verified rollback snapshot;
3. `rollback` — restore the previous exact installed state after a failed or rejected candidate;
4. `runtime-status` — read-only installed/runtime evidence suitable for GitHub receipts.

Fixed live root:

`C:\Users\dan\AppData\Local\ChatGPTResponseNotifier`

The adapter must assert Dan's fixed SID/profile, interactive session ID greater than zero, Explorer in the same session, and least-privilege identity before any mutation.

## Candidate artifact contract

Prefer the validated managed bundle archive rather than the much larger Setup executable as the broker payload. The adapter remains the reviewed installer; the request payload remains data plus the exact host/extension candidate.

Artifact contents should be exactly:

- `candidate.zip` — the exact bundle ZIP from a successful notifier `Validate notifier source` run;
- `candidate-manifest.json` — the matching exact-source manifest from that same Actions artifact.

The trusted Glass bridge must resolve a successful notifier validation run for the requested full source SHA, require the exact artifact name for that SHA, record the GitHub artifact digest, download the artifact, verify `candidate-manifest.json`, verify the named bundle SHA-256, and stage only the normalized two-file broker payload. The broker's own aggregate artifact hash then binds those exact bytes to the OIDC request.

The public notifier repository means this can use the public Actions artifact as evidence/input; no ChatGPT credential, browser profile, or user token belongs in the broker request.

The data-only Glass request should identify the notifier source and exact successful validation run/artifact digest. Those fields are validated by the trusted workflow and are not promoted into arbitrary broker command/path parameters.

## Adapter validation before mutation

For `deploy`, the adapter must validate all of the following before stopping the current helper:

- exact two-file broker payload;
- candidate manifest version/source equals the trusted request source;
- candidate bundle SHA-256 equals the manifest;
- ZIP entries use safe relative paths and contain no reparse/link escape;
- `bundle-manifest.json` project identity is `ChatGPT Response Notifier`;
- bundle manifest version/source matches the candidate manifest/request;
- every declared bundle file exists with exact size and SHA-256;
- bundle contains one host executable, one bundle manifest, and only the reviewed extension/support file set;
- current install state, extension manifest, startup Run value, and helper process are internally consistent or the adapter fails closed with a read-only diagnostic receipt.

The adapter must refuse to stop a same-named process whose executable cannot be proven to live under the fixed notifier install root.

## Transaction and rollback model

Before mutation, stop only the verified current notifier helper and create a protected, fixed-location single rollback snapshot containing:

- current `Data\install-state.json`;
- current `Extension` directory;
- current helper executable when the target version would overwrite the same version path;
- current per-user startup registration value/presence;
- hashes and identity metadata needed to verify restoration.

Do not roll back the whole mutable `Data` directory: notification acceptance/history/log data may legitimately advance. Snapshot only the deployment-owned state required to restore executable/extension identity and startup behavior.

Deployment then stages and verifies the candidate on the same volume before commit, installs the exact host under `Host\<version>`, transactionally swaps the extension directory, writes exact install state, writes the fixed startup registration, and starts the exact new helper hidden in the interactive session.

Any commit or post-install verification failure restores extension/install state/startup registration and any overwritten host bytes, restarts the previous exact helper, and verifies the restored state before returning failure. A successful deploy retains one rollback snapshot until the candidate is accepted or superseded.

`rollback` restores that retained snapshot and verifies the same fixed invariants. It never accepts a requester-supplied rollback path or version.

## Runtime activation and rollback activation

A candidate is not accepted merely because files were copied.

After deploy the adapter/automatic evidence must prove, when observable:

- exact installed version and source commit;
- installed extension manifest version;
- expected helper path in Dan's interactive session;
- loopback listener 38473 owned by that helper;
- fixed startup registration points to the exact helper;
- bounded `Evidence\runtime-evidence.json` reports the same installed/source identity;
- loaded extension runtime identity converges to the installed version without foregrounding Chrome.

The already-installed predecessor must be capable of discovering a newer installed extension and reloading itself. Conversely, rollback must also converge from a newer loaded worker to an older restored extension. The notifier therefore reloads the Chrome extension runtime on **any valid installed/current version mismatch**, not only upgrades. Same-version and malformed-version reports do not reload.

If no live ChatGPT extension worker is available to report identity, deployment may return `extensionIdentityDeferred=true`; Task 4/5 automatic evidence must establish loaded identity before live notification acceptance.

No deployment or rollback path may activate/focus a Chrome window or tab.

## Trusted Glass bridge

The Glass bridge follows the existing CPU Monitor pattern:

- `pull_request_target` on one data-only request JSON;
- repository-owner/canonical-head/ownership-field checks;
- exact request schema and source SHA validation;
- exact successful notifier validation-run lookup;
- exact candidate artifact/digest lookup and download;
- local artifact rehash and normalization;
- fresh broker heartbeat check;
- OIDC token audience bound to project/action/request/source/content hash;
- `.staging` → `.ready` Inbox transaction;
- bounded receipt wait;
- exact receipt identity verification;
- PR comment with source, artifact digest, installed identity, session, mutation/rollback result, and deferred/observed extension-runtime identity.

The runner remains only the authenticated submitter. It never writes the notifier live root directly.

## Acceptance order

1. Source-review and self-test the notifier adapter, project policy, project-specific size bound, and Glass bridge without installing the protected broker.
2. Merge exact reviewed infrastructure and Glass bridge source.
3. Perform the explicit user-approved UAC broker upgrade from exact merged DevelopmentInfrastructure source.
4. Run `user-preflight` against the still-installed baseline.
5. Run one exact `deploy` request for the accepted notifier candidate.
6. Rerun automatic notifier runtime evidence and require exact installed/source/helper identity plus loaded extension identity when observable.
7. Perform Task 4/5 real notification/LIMIT/Pause/close/lifecycle acceptance.
8. If acceptance fails because of the candidate, run the fixed `rollback` action and prove restored identity.
9. Only after Task 4/5 and focus/fullscreen Task 5/5 acceptance may the exact candidate be promoted to the public updater/release path.

## Non-goals

This lane does not add a general remote shell, arbitrary executable runner, ChatGPT API integration, Chrome remote debugging, browser-profile copying, helper-Origin impersonation, automatic foregrounding, prompt replay, Regenerate, or unbounded retries. It does not grant the session-0 runner write access to the notifier live root or private `Data` directory.
