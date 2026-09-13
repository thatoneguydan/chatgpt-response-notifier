# Work handoff — notifier 0.9.7 delivery and continuation contract

Date: 2026-09-13. Program: **ChatGPT Response Notifier**. Owner: [DevelopmentInfrastructure #283](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/283). Active implementation: draft [PR #33](https://github.com/thatoneguydan/chatgpt-response-notifier/pull/33), branch `fix/durable-notifier-coordination`.

## Scope and evidence identity

Dan explicitly asked Work to investigate, put missing work in the roadmap, and stop once implementation becomes deterministic. This segment changed documentation/coordination only. No application source fix, build, installation, release or live browser action was performed.

Reviewed application source: `80dd47cfb64f44fc5a02ad7270de6c074bcf427f`, version 0.9.7. Its existing Glass proof is run `34722414342`, artifact `10306153982`. Dan reported this candidate already installed in [#34](https://github.com/thatoneguydan/chatgpt-response-notifier/issues/34#issuecomment-5649465926); later comments supersede the older issue/PR-body request to install it. A roadmap-only descendant is not a new application candidate.

The live report is absent notifications over several versions, including 0.9.7. Earlier acceptance notes record valid BLOCKED_HUMAN and INCOMPLETE_HANDOFF replies with zero notifications. The 0.9.6 error capture contained source text rather than an exception header. This investigation did not retrieve Glass's live 0.9.7 diagnostics and cannot attribute every miss to a particular source defect. Do not invent an exception or infer worker liveness from install-state.json.

## Prior proposal reconciliation

| Item | Status at reviewed 0.9.7 |
| --- | --- |
| INCOMPLETE_CONTINUE | Absent from canonical v1 contract, bundled parser/grammar and continuation guards. |
| Narrow HANDOFF to explicit requested/required transfers | Not implemented; canonical v1 still permits broader voluntary durable handoffs. |
| Shared contract-driven continuation eligibility | Not implemented; LIMIT comparisons remain hardcoded across policy/worker/normal observer. |
| Original proposal in roadmap | Absent; existed only in [PR comment](https://github.com/thatoneguydan/chatgpt-response-notifier/pull/33#issuecomment-5648524554). Now a planned contract step. |
| Unified control, START, sticky Pause, quiet close | Implemented. Preserve existing accepted behavior. |
| Automatic candidate/evidence lane and external Chrome error capture | Requested in later #34/#283 comments; no such lane appears in reviewed notifier workflows. Now explicit tasks. |
| Recovery reload count | Source/current tracking says three; stale roadmap said one. Roadmap corrected. |

Normative status meanings remain in DevelopmentInfrastructure. V2 must coordinate detailed policy, compact authority contract/capsule, grammar/digest, generated consumer fixture and evaluation tests. Add CONTINUE, narrow HANDOFF, retain genuine LIMIT and all other meanings. Producer activation follows proven installed consumer support. Keep one footer; no blind legacy HANDOFF continuation. An unblocked chat should keep working, and a checkpoint is not permission to stop.

## Confirmed source defects and repair recipes

### 1. Terminal observation is consumed before success — notification stall

Source: [normal-continuation-budget-hook.js](https://github.com/thatoneguydan/chatgpt-response-notifier/blob/80dd47cfb64f44fc5a02ad7270de6c074bcf427f/extension/normal-continuation-budget-hook.js), `scheduleObservedStatusDelivery` / `observeCodedCompletion`.

The scheduler adds its logical key to `codedSnapshotObservations` before the status requery, page checks, claim, or queue succeeds. Null/error/unavailable results never release or reschedule it. Later identical terminal observations are discarded. The key also omits several state changes that can restore eligibility.

**Reproduction on unchanged source:** send a valid monitor terminal snapshot; return null for its first status requery; restore the reader; send the same snapshot again. Result: one automatic query, zero queued notifications. Calling the existing observer directly after restoration queues successfully. This establishes an event/retry problem rather than absence of the terminal code.

**Repair:** distinguish attempted/in-flight/resolved observation state. Bind an immutable expected observation to the originating conversation, Chrome document, current prompt, assistant and revision. A safe pre-action query failure must permit a bounded retry/reattachment/reconciliation of that same observation. Mark it resolved only after an owned durable outcome (queued notification or confirmed continuation), not after scheduling. Retain pending state/wake across worker restart; cap retries and surface one structural attention result when they cannot finish. Deliberate close, navigation, supersession and uncertain Send never authorize replay.

Do not simply delete dedupe or keep querying whichever latest turn happens to be present. The current observer accepts a requestId parameter but does not use it to bind the subsequent status result to the original event.

**Required proof:** first-null and first-throw then valid identical snapshot; temporarily unavailable page then safe return; SPA/new-prompt replacement while the query waits; duplicate tabs/rerenders; restart before resolution. Exactly one durable eligible outcome, and zero continuation on a superseded identity.

### 2. Enqueue can lose its wake behind an active outbox flush — notification stall

Source: [service-worker.js](https://github.com/thatoneguydan/chatgpt-response-notifier/blob/80dd47cfb64f44fc5a02ad7270de6c074bcf427f/extension/service-worker.js), `queueDurableNotification`, `flushNotificationOutbox`, `handleNativeMessage`.

The single-flight flush captures one outbox snapshot. A later enqueue's flush call only joins the already-running promise. If the original snapshot was empty or omitted that enqueue, neither caller performs another scan. The ordinary pong path does not drain pending outbox items. ACK failure likewise returns without an independent retry schedule.

**Reproduction on unchanged source:** start a flush for notification A and delay its helper ACK; enqueue notification B while that flush is active; then acknowledge A. Result: B remains pending with zero toast.show messages for B. A normal version-bearing pong leaves B pending. A later explicit flush sends B, receives its matching ACK, and clears it.

**Repair:** use a wake-safe serial drain: enqueue requests another pass even if a flush is active, and the drain must not lose work arriving at completion. Back it with a bounded local alarm/backoff/reconnect wake while durable entries remain. Reconcile on worker startup. Keep the same notification ID for resend and require the matching durable helper ACK before removal. Sustained failure must retain the entry and report attention rather than busy-loop or silently stop. These are loopback delivery retries, not new ChatGPT requests.

**Required proof:** enqueue during another item's ACK wait; enqueue at drain completion; concurrent scans/enqueues; delayed/lost ACK; helper reconnect and worker restart. Stable IDs and helper tombstones must prevent duplicate or reopened dismissed windows.

### 3. DOM-triggered continuation targets a local UUID as a Chrome document

Source: same normal observer, plus `status-script.js` runtime creation and `service-worker.js:sendTabMessage`.

The normal observer passes `status.documentId` to `handleContinuationClaim` as the Chrome message target. That value is generated by crypto.randomUUID inside the status script. The monitor has yet another local UUID. Chrome supplies the actual document identity in message sender metadata.

**Reproduction:** emit a monitor message with Chrome sender document ID A while the status reader returns local runtime UUID B. The hook passes B to continuation routing. The original browser document A is discarded.

**Repair:** carry a clearly distinct `chromeDocumentId` from browser sender/request provenance. Preserve status/monitor runtime identifiers as independent freshness guards. Use the browser ID for tabs.sendMessage and scripting targets; use the local runtime ID only to validate the installed page reader. For request-only triggers lacking verified document provenance, reconcile through the corresponding current monitor observation rather than substitute a random local ID. Recheck the observed turn/status before a claim and immediately before Send. Preserve migration/compatibility for existing persisted records.

Chrome documents the browser identity in [MessageSender](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender) and the target in [tabs.sendMessage](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-sendMessage). The source implication is that this path can fail delivery to the content script and fall back to a notification; it does not alone explain every missing Windows toast.

**Required proof:** Chrome and both local runtime IDs are deliberately different; normal DOM LIMIT reaches the correct document, while route/new-document/new-turn changes veto action.

### 4. Diagnostics can overstate delivery and miss the actual decision

Source: [delivery-diagnostics-hook.js](https://github.com/thatoneguydan/chatgpt-response-notifier/blob/80dd47cfb64f44fc5a02ad7270de6c074bcf427f/extension/delivery-diagnostics-hook.js).

The diagnostic hook performs a second independent status query, waits 750 ms, then sets deliveredNow from “turn exists and no pending entry.” A claimed turn before enqueue, an acknowledged notification, a successful quiet continuation, and some failure states can all satisfy that condition. A later query may also inspect a different revision/turn. It is not proof a toast appeared.

**Repair:** emit bounded structural events at the actual observation/claim/queue/send/ACK/presentation/dismissal decisions using one logical event correlation ID. Record retry/refusal/duplicate/uncertainty explicitly. Distinguish helper durable acceptance from window presentation and deliberate dismissal; neither transport success nor absence of an outbox item proves visibility. Keep sanitization and payload caps; never export chat text or title/prompt/body contents as diagnostics.

Bootstrap failures need an independent collector because a failed worker cannot reliably report its own failure. Do not treat a missing diagnostics tail as proof there was no error.

## Validation basis and limits

An isolated Node VM loaded all 15 worker imports in the real background.js order with simulated Chrome, WebSocket and IndexedDB boundaries: no bootstrap exception; observer and diagnostic hooks present. This rules out an unconditional import-order failure in that simulation only. It does not prove actual Chrome load/update behavior.

The three behavioral reproductions above used the unchanged downloaded source. The outbox probe delayed notification A's helper ACK, enqueued B, then supplied the matching idempotent ACKs. The observation probe supplied a transient null status read. These controlled preconditions are explicit; no live ChatGPT state or request was manufactured.

Current architecture tests for the DOM delivery and diagnostic additions mostly assert source strings. Preserve those boundary checks but add executable integration cases for the failures above, real import composition, current-document routing and notification queue/ACK state. A green helper build or mock-only claim test is not live notification acceptance.

## Automatic Glass evidence and deployment direction

Use the two distinct roadmap tasks: read-only collection first, controlled per-user deployment second. These requirements originated in [the deployment/evidence amendment](https://github.com/thatoneguydan/chatgpt-response-notifier/issues/34#issuecomment-5649465926) and [the external-error amendment](https://github.com/thatoneguydan/chatgpt-response-notifier/issues/34#issuecomment-5649473549).

1. Start with existing installed 0.9.7. Collect install-state version/source, installed files, running helper path/version/user/session, loaded extension runtime identity when observable, and a bounded sanitized diagnostics.jsonl tail. Return evidence through the existing GitHub/Glass path without manual PowerShell or copy/paste. An installation receipt alone cannot prove which worker is loaded.
2. The repository-scoped runner is a NETWORK SERVICE build/control actor. Running a per-user installer directly there can target the service account and leave UI in a noninteractive session. Use a reviewed, fixed notifier adapter in Dan's interactive user-session infrastructure; do not grant arbitrary runner commands or pretend existing ChompBox-only broker policy already authorizes notifier operations. Inspect current installed broker capability and project policy before onboarding. The canonical [user-session broker handoff](https://github.com/thatoneguydan/DevelopmentInfrastructure/blob/main/Glass/UserSessionDeploymentBroker/HANDOFF.md) identifies the fixed SID/session and narrow action boundary.
3. Return allowed structural Chrome target/worker errors independently when a supported observer is available. First prove capability on the actual browser/session. Chrome's [remote-debugging change](https://developer.chrome.com/blog/remote-debugging-port) disallows debugging the default data directory with the ordinary remote-debugging switches from Chrome 136. Do not promise effortless CDP access to Dan's running default profile, restart/move his profile, weaken protection, or copy authenticated profile data. An isolated Chrome-for-Testing worker-load test can give independent bootstrap evidence, but must be labeled isolated rather than evidence from his live chat. If live error capture is unavailable, report that specific capability gap and retain useful install/helper diagnostics.
4. Candidate deployment is a fixed opt-in action bound to validated PR/head, artifact/digest, expected prior installed identity and rollback target. Preserve Data/config/history, installer safety and windowless execution with temporary PowerShell execution-policy bypass. Record previous exact known-good identity. Keep candidate deployment separate from public release.
5. Verify helper and extension activation converge to the exact new candidate. The 0.9.7 heartbeat lives in the new content script, so it cannot by itself prove an older stalled runtime will activate the first upgrade. Test from the actual loaded predecessor; retain bounded external activation/evidence if needed, without relying on Dan to reload Chrome.
6. Human acceptance concerns visible toast number/title and foreground/focus behavior. The next failure should identify the recorded boundary; do not launch another series of timing guesses or ask Dan to transport extension errors.

## Normal-chat continuation

Current next work: **ChatGPT Response Notifier → Workstream 5/5 — Status Contract and Bounded Recovery → Stage 4/4 — Prove and Roll Out → Step 1/1 — Validate the real background workflow → Gate 1/1 — Exact-source evidence supports enabling recovery → Task 1/5 — Repair and prove delivery, routing and diagnostic decisions.**

Adopt current #283/PR #33; reconcile live head/in-flight state. Preserve the recorded 0.9.7 application identity separately from documentation-only commits. Collect existing diagnostics as soon as the supported read-only path permits; implement the bounded repairs, then have Glass prove the exact new candidate. Build the planned evidence/deployment tasks and finish live acceptance before public publication. Schedule the coordinated v2 status amendment after the delivery path is dependable.

The repair directions are ready for normal-chat implementation. Actual live cause attribution and acceptance remain evidence tasks, not a reason to spend Work on installation or repeated CI.
