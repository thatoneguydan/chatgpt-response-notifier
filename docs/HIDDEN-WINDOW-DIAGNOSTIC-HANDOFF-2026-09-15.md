# v0.9.26 hidden-window failure — diagnostic handoff

Date: 2026-09-15. Owner: [DevelopmentInfrastructure #439](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/439).

## Decision and stop boundary

The operator reports v0.9.26 still fails while Chrome is unfocused and requests evidence-led diagnosis, checkpoints, stronger diagnostics where needed, and transfer once the remaining work is deterministic.

**Implement the bounded diagnostic contract below before another behavior release.** The exact live transport/framing/focus cause is not yet proven. Do not equate a green build, deployed version, live service worker, or a synthetic parser test with hidden-window acceptance.

This investigation changed documentation/coordination only. It collected existing read-only Glass evidence and ran isolated synthetic source probes. It did not install/update/reload Chrome, change browser settings, focus a window, send a test prompt, or add ChatGPT traffic.

## Canonical and live identity

- Audited notifier main: `fb207b3e106b1b92608521620a84ff8093138e32`.
- Published v0.9.26 merge: `54fb172d34544c199ad613fd9f76c1a31769cad7`, PR #55.
- Installed candidate: `e303eaff6d4ef1c9e4cc922f316ab8b6d550dd1b`, version 0.9.26.
- Protected Glass deployment: Glass PR #142 / run 35021459189, successful; request PR closed unmerged.
- Fresh read-only collection: [run 35018543523](https://github.com/thatoneguydan/chatgpt-response-notifier/actions/runs/35018543523), attempt 3, job 104563425810.
- Evidence artifact: [10417809946](https://github.com/thatoneguydan/chatgpt-response-notifier/actions/runs/35018543523/artifacts/10417809946); downloaded ZIP SHA-256 verified as `40f39e3b36415d3ec397aeb3ad66cf4f5670692f9c33deb7c9b0e9bf7be08a80`.
- Existing collector: `.github/workflows/runtime-evidence.yml`, `tools/Collect-NotifierRuntimeEvidence.ps1`, `tools/Add-NotifierSafeEvidence.ps1`. Re-running its existing exact-source collect job is a supported read-only route. Reconcile current runs before replaying it.
- Service-account access to the private application root is intentionally denied. The bounded safe-evidence adapter proved installed/current version 0.9.26 and a connected live helper bridge. The base collector's unavailable/zero fields are not proof of a missing helper.
- Registry shape/collision validation: DevelopmentInfrastructure run 35023385851, job 104564422653, passed.
- Read the current #439 body and live branch/PR heads before continuing. These SHAs describe this investigation, not permission to overwrite later work.

Artifacts expire after seven days. The bounded facts below are the durable interpretation; private diagnostic payloads and raw response content must not be committed to this public repository.

## What the fresh capture proves

Retained evidence spans 20:51:18.433Z–21:00:57.273Z. It contains 200 entries. Installed/current runtime is 0.9.26. The 48 worker-alive events share one worker identity; maximum heartbeat gap is 20.013 seconds.

The following events share a tab and, where recorded, a Chrome document. The stream diagnostics do **not** carry a request ID, so this is temporal/document association, not a fully correlated request trace.

| UTC | Existing event | Interpretation |
| --- | --- | --- |
| 20:51:37.268 | response-stream-stream-observed, fetch | MAIN fetch observer and isolated bridge are executing. |
| 20:51:45.706 | request-completion-wake, request 104000 | Worker receives a request completion. |
| 20:51:45.707 | frozen=false; discarded=false; active=true | Tab is neither reported frozen nor discarded at this instant. |
| 20:51:45.710 | response-stream-stream-ended-no-status | Raw stream scanner reaches EOF without a matching status token. |
| 20:52:13.263 | request-completion-status-probe-observed, COMPLETE_NO_CHANGES | DOM status becomes observable 27.557 seconds after request completion. |
| 20:52:13.270 | notification-durable-queued | Notification is retained for delivery. |
| 20:52:13.515 | toast-presented | Helper reports presentation about 252 ms after DOM status observation. |
| 20:52:13.523 | helper-durable-accepted | Worker receives the helper acknowledgment. |
| 20:57:46.503 / .861 | fetch observed / stream-ended-no-status | A second observed fetch also yields no raw status token; nearby wake is request 104377. |

The helper's presentation timestamp was 16:52:13.515-04:00, normalized above to UTC. Presentation evidence proves the helper's presentation operation, not that pixels were visible on the operator's current virtual desktop.

Supported boundary: in this sample the delay precedes notification queueing. The helper does not spend those 27 seconds holding an already-queued notification. The stream hook is not wholly absent. There are no stream-terminal-seen or stream-notification-queued events in the retained sample.

**Still unknown:** exact foreground/virtual-desktop transition time, whether the observed POST carries answer text or transport handoff metadata, the actual response media type/framing, logical message boundaries, and an exact stream/request/prompt linkage. Do not claim ChatGPT painting is the proven cause. Earlier v0.9.25 evidence established delayed DOM *observation*, not which internal rendering/transport stage caused it.

Chrome's [Tab.active definition](https://developer.chrome.com/docs/extensions/reference/api/tabs#property-Tab-active) describes tab selection inside a window, not whether that window is focused. Chrome's [frozen definition](https://developer.chrome.com/docs/extensions/reference/api/tabs#property-Tab-frozen) describes a separate lifecycle state. Neither alone measures Windows occlusion or virtual-desktop membership.

## Proven defects and diagnostic gaps

### 1. Raw text matching does not parse the response protocol

`extension/response-stream-status-main.js` scans concatenated raw response bytes with a regex, retains a 512-character tail, remembers the last matching code anywhere, and publishes it only when the reader ends. It does not parse SSE events/JSON deltas, constrain assistant role/channel, or establish a final standalone footer.

Bounded Node VM probes evaluated the unchanged source with synthetic input:

| Fixture | Actual v0.9.26 result |
| --- | --- |
| One complete status token | terminal-status |
| Same token split across network byte chunks | terminal-status |
| `data: {"v":"[GITHUB_STA"}` followed by `data: {"v":"TUS: COMPLETE_NO_CHANGES]"}`, separate SSE events | stream-ended-no-status |
| Status token inside a nonterminal prose example | terminal-status, a false positive |

The third fixture proves a parser limitation; it does **not** establish that the live response used that format. `tests/extension/response-stream-status.behavior.test.mjs` tests the second case, not the third. Its background safety checks are primarily source assertions, not an end-to-end identity/lifecycle simulation.

[SSE event framing](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation) is distinct from network chunk boundaries. Actual ChatGPT message/delta semantics must be observed before choosing a decoder. Do not broaden the regex or treat every string field as assistant output.

### 2. Five-minute request-context expiration is unconditional

`response-stream-status-background.js`: `CONTEXT_TTL_MS = 5 * 60 * 1000`; `pruneContexts()` compares current time to **startedAt**, even while the request is unsettled. `currentContext()` prunes before terminal handling.

With the unchanged background source, synthetic context age 299,999 ms reaches status handling; age 300,001 ms becomes `response-stream-status-unroutable / request-identity-missing`. This definitively rejects long requests on the stream path even if parsing succeeds. It is not the demonstrated explanation for the 20:51 sample, where no token reached identity handling.

Contexts also live only in in-memory maps. A worker restart loses them. Chrome [documents worker shutdown and loss of globals](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle); the captured interval instead shows one worker identity, so restart is a risk, not the observed cause.

### 3. The early stream path still awaits the page

`currentContext()` awaits the initial monitor-query promise. `identityForStreamEvent()` then queries the page again. Neither query has an explicit application deadline or separate started/received/timeout diagnostic. A stalled page reply can therefore stall the supposedly early path without a useful event. Record this boundary before removing any identity requirement.

MAIN messages have no per-fetch nonce; the worker selects the latest request for that document. Concurrent requests, delayed old events, and navigation cannot be safely diagnosed with this association. Missing context, failed context, expired context, conversation mismatch, and missing request identity collapse to generic rejection or silent exits.

### 4. Retention and error classification obscure the incident

The 200-entry ring contains 129 `monitor-terminal-seen` repeats and 48 heartbeats: **177/200 slots**, leaving 23 other events. One repeated state alone occupies 72 entries in about 15.4 seconds.

The DOM path delivers the logical turn, while a competing observation receives `claim-refused:already-delivered-logical-turn`, retries four times, and becomes `observation-attention`. This is confirmed by the capture and the no-record refusal branch in `normal-continuation-budget-hook.js`. A proven delivered duplicate should resolve; a generic refusal must not be silently treated as success.

Relevant pipeline: `delivery-reliability-background.js` → `DiagnosticsSanitizer.cs` → `RuntimeEvidencePublisher.cs` → `Add-NotifierSafeEvidence.ps1`. New fields must survive **every** projection. Increasing only the collector's tail does not recover events already evicted from the helper mirror.

Hook installation failures and bridge send failures are swallowed. There is no installation/version acknowledgment, stream start time from MAIN, frame/byte count, response-shape classification, eviction count, or per-request retained outcome. Therefore an absent event currently cannot distinguish “did not happen,” “not instrumented,” “message failed,” and “was evicted.”

## Implementation roadmap

Parent: **ChatGPT Response Notifier → Workstream 1/5 — Foundation and Conversation Identity → Stage 1/1 — Hidden-window completion evidence and repair**.

### Step 1/3 — Make one incident diagnosable

**Gate 1/1 — A bounded, self-contained trace identifies the first missing/failed boundary, or explicitly reports insufficient evidence.**

1. **Task 1/4 — Correlate transport and recognition.** Add observer/bridge version and installation outcome; a per-observation stream nonce; worker instance plus event sequence; explicit request-capture/mapping result. Retain request-start/settled times and context age. MAIN cannot know Chrome's webRequest ID: record mapping confidence and ambiguity; do not silently assign concurrent events to the latest request. Add response HTTP status and allowlisted media-type/route class, byte/chunk/frame counts, first-byte/EOF/error timing, and bounded protocol-shape counters. Report raw-token count, decoded-candidate count, semantic-final eligibility and fixed rejection reasons separately. Keep diagnostics non-authorizing.
2. **Task 2/4 — Measure page/lifecycle waits.** Log both page-origin and worker-receipt times, observer installation identity, page visibility/focus/freeze/resume transitions, tab frozen/discarded state, window focused/minimized state and snapshot age. Record page-query issued/replied/error/deadline with one correlation ID. Use worker-owned deadlines, with late results ignored for that diagnostic attempt; no new page keepalive loop. Mark virtual-desktop/occlusion state unknown unless independently observed—do not infer it from active=true. Read-only diagnostics must never activate a window, refresh a page, attach a debugger or send a prompt.
3. **Task 3/4 — Retain useful evidence.** Preserve at most 20 bounded request/incident summaries with up to 48 stage transitions each and a 128 KiB total metadata budget. Use explicit oldest-incident eviction, sequence bounds and dropped/coalesced counts. Keep heartbeat liveness/version in a separate aggregate. Coalesce repeated identical status/reason/identity into first/last time plus count. Persist the summary across helper/worker restart through the existing storage boundary; expose retention/completeness in the safe evidence. An incomplete trace must say unknown, never “no error.” Extend the four projections named above and test exported evidence, not just in-memory events.
4. **Task 4/4 — Prove instrumentation before release.** Add synthetic fixtures for byte splitting versus logical delta splitting, UTF-8/JSON escapes, EOF versus semantic terminal, unknown/handoff transport shape, quoted/nonterminal codes, two overlapping requests, delayed old-document events, >5-minute requests, worker restart, never-replying page query, helper disconnect, duplicate delivery and noisy retention. Assert zero extra ChatGPT requests, no actions authorized by diagnostics, bounded CPU/memory/storage and no response/prompt/title/URL leakage. Run the normal self-hosted exact-head validation and reviewed protected deployment only for the finished diagnostic candidate. Obtain fresh runtime evidence of the exact diagnostic version.

All limits above are explicit proposed diagnostic defaults, not claims about existing product behavior. Record any evidence-driven limit change in this handoff. Do not retain arbitrary JSON keys/values, body fragments, headers, cookies, authorization, full URLs, tokens or request bodies. Protocol classification uses fixed enum/boolean/count projections with bounded ephemeral parsing; unknown/oversized shape stays unknown.

### Step 2/3 — Repair only the evidenced failing boundary

**Gate 1/1 — A captured shape/state reproduces the failure in a deterministic fixture and the proposed repair passes without weakening identity or status semantics.**

1. **Task 1/2 — Choose the measured branch.**

| Measured boundary | Required next action |
| --- | --- |
| POST contains answer deltas; decoded candidate exists but raw scanner misses it | Implement an incremental decoder for the observed schema; reconstruct only bounded final assistant text, exclude tool/quoted/example material and enforce final standalone canonical status. |
| POST is a descriptor/handoff or unsupported shape | Document that the current hook lacks answer coverage. Stop and design a reviewed passive observer for the actual existing transport; do not add polling, replay or guess another endpoint. |
| MAIN receives bytes/status late while worker remains alive | Preserve the origin/receipt timeline and lifecycle state; changing only the worker detector cannot fix page-side delivery. Escalate with this precise boundary. |
| Token arrives but identity expires/is lost | Persist exact context and bind to the same document/request lineage. Retain active contexts until settle/cancel/supersede, with a bounded explicit abandonment policy; expire completed contexts by completion time. Never resurrect ambiguous requests. |
| Valid context exists but page query never replies | Remove a page round trip only if previously captured exact identity suffices; otherwise return a bounded unavailable state and retain evidence. Never substitute “current tab” identity. |
| Queue/ACK missing, or ACK exists but presentation is wrong | Follow the existing outbox/helper stages. A presented acknowledgment alone does not prove visibility on the current Windows desktop. |

2. **Task 2/2 — Resolve verified delivered duplicates.** Reconcile the `already-delivered-logical-turn` result with the canonical logical-turn/delivery record and resolve the redundant observation once proven. Preserve retries for uncertain/unacknowledged delivery. Add a regression ensuring one real delivery, no false attention, no retry storm, and bounded diagnostic output.

The parser and >5-minute defects are established source bugs; fixing them must not be advertised as the live unfocused-window cure until the relevant trace and final gate pass. Stream-derived status remains notification-only. Automatic Continue retains DOM identity, Pause, draft/manual-stop, uncertainty and action-budget guards.

### Step 3/3 — Prove real unfocused-window behavior

**Gate 1/1 — A correctly attributed coded completion reaches the native notification before focus returns, with complete retained evidence.**

1. **Task 1/2 — Capture distinct conditions.** Use the diagnostic build during ordinary operator-authorized work: visible/focused control, visible/unfocused window, background tab, minimized window, and another Windows virtual desktop. Include at least one long response exceeding five minutes and one already-open tab across managed update. These are different conditions; do not report one as proof of all. Synthetic browser fixtures can establish boundaries but cannot replace the Windows reproduction. Do not take focus or generate paid/test prompts automatically to manufacture acceptance.
2. **Task 2/2 — Verify outcome and close only on proof.** For each scenario retain exact build/runtime/request identity; semantic terminal observation; focus/visibility timeline and its evidence source; queue/ACK/presentation times; delay breakdown; no duplicate; bounded capture/cleanup state. User perception remains necessary only where safe read-only telemetry cannot prove visibility. If evidence is incomplete, leave #439 open with the first unresolved boundary. Version promotion alone does not close it.

## First action for the receiving chat

Adopt #439 and this documentation PR after reconciling canonical state. Implement **Step 1/3 → Gate 1/1 → Task 1/4**, then the remaining three diagnostic tasks. The diagnostic implementation is deterministic; the ultimate live repair remains evidence-gated. Preserve this handoff in the owning branch and checkpoint every material result.

Do not redeploy v0.9.26, change Chrome flags, increase arbitrary timers, or repeat a focus test without recording the fields needed to distinguish its outcome. If the new trace proves a transport coverage gap, hand back that specific design question instead of shipping another guess.
