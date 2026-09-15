# v0.9.27 hidden-window diagnostics candidate checkpoint

Date: 2026-09-15. Owner: DevelopmentInfrastructure #439. Candidate PR: #56.

This checkpoint supersedes the implementation-start boundary in `HIDDEN-WINDOW-DIAGNOSTIC-HANDOFF-2026-09-15.md`. The original v0.9.26 evidence remains the factual basis for the work.

## State

Step 1/3 of the hidden-window roadmap now has a bounded implementation candidate. This is **diagnostic instrumentation, not a claimed hidden-window behavior fix**. Existing notification and automatic-Continue authorization remain owned by the canonical notifier paths. The diagnostic path cannot authorize either action.

The candidate version is 0.9.27. The public managed update channel remains on 0.9.26 until exact-head validation and the reviewed deployment path succeed.

## What was added

### Passive MAIN-world transport observer

`extension/hidden-window-diagnostics-main.js` observes only the existing ChatGPT conversation POSTs already made by the page. It clones the existing Fetch response or observes XHR completion; it does not issue a second request.

It records bounded metadata only:

- observer/version identity and a per-stream nonce;
- fixed route/media/protocol classifications;
- HTTP status;
- byte, chunk, SSE frame, JSON frame and `[DONE]` counts;
- response-start, first-byte and EOF/error timing;
- raw status-token count versus decoded string-candidate count;
- a fixed semantic rejection reason.

Response bodies, prompts, titles, cookies, headers, auth/session material and full URLs are not forwarded or retained. The observer may detect strings resembling a status token while decoding observed JSON, but every such result is diagnostic-only: `semanticFinalEligible` is always false in this candidate.

### Isolated page/lifecycle bridge

`extension/hidden-window-diagnostics-page.js` forwards only allowlisted scalar metadata from MAIN world and exposes an immediate page-state diagnostic query. It records visibility, document focus and page freeze/resume/pagehide/pageshow transitions. It never sends prompts or changes page state.

### Worker correlation and failure boundaries

`extension/hidden-window-diagnostics-background.js` correlates Chrome `webRequest` request/document identity with stream nonces without pretending MAIN can know the Chrome request ID.

- A single eligible request on the same Chrome document is marked `document-single-request`.
- Concurrent candidates are reported as `ambiguous-overlap` with an explicit `request-stream-mapping-ambiguous` boundary rather than silently choosing the newest request.
- Page diagnostic queries have a worker-owned 2-second deadline with issued/replied/error/deadline transitions.
- Request settlement without a stream final reaches an explicit 30-second diagnostic deadline.
- Browser snapshots include tab active/frozen/discarded and Chrome window focused/state values. These do **not** claim Windows occlusion or virtual-desktop membership.
- Existing ChatGPT tabs are attached bridge-first, then MAIN-observer, without foregrounding or reload.

The worker persists at most 20 incidents, at most 48 transitions per incident and at most 128 KiB of projected metadata. Repeated equivalent transitions coalesce and eviction/drop counters are explicit.

### Helper and safe evidence retention

The native helper sanitizes diagnostic events before the external evidence sink sees them. Hidden-window incident snapshots are upserted into a separate bounded bucket instead of competing with the existing noisy 200-event ring. `tools/Add-NotifierSafeEvidence.ps1` exports the same bounded incident surface.

This separation directly addresses the v0.9.26 capture where terminal repeats and heartbeats occupied most retained slots.

## Candidate safety invariants

The v0.9.27 diagnostic path must continue to satisfy all of these:

1. No additional ChatGPT HTTP request, session polling, replay or endpoint guessing.
2. No debugger attachment.
3. No tab/window foregrounding.
4. No automatic refresh caused by diagnostics.
5. No prompt generation or send action caused by diagnostics.
6. No response/prompt/title/full-URL leakage into helper or exported evidence.
7. No diagnostic candidate can authorize a notification or automatic Continue.
8. Ambiguous identity stays ambiguous; there is no “latest request wins” fallback.
9. Missing evidence is reported as an unresolved boundary or insufficient evidence, never as proof that nothing failed.

## Deterministic fixtures

The candidate test surface now covers, in addition to the existing notifier suites:

- a canonical token split across raw network chunks;
- the v0.9.26 gap case where one logical token is split across separate SSE JSON string values;
- JSON escape decoding where the raw transport does not contain the literal token;
- EOF / `[DONE]` metadata while semantic authorization remains false;
- one request remaining traceable beyond five minutes;
- two overlapping requests producing an explicit ambiguous mapping instead of silent reassignment;
- a page query that never replies reaching the worker-owned deadline;
- retention beyond 20 incidents reporting eviction;
- bridge allowlisting that drops injected response text and URL fields;
- source guards proving diagnostics contain no Continue path, foreground action or ChatGPT polling request.

The existing notifier test suites continue to cover duplicate delivery, action budgets, Pause/manual-stop/draft safety, restart-safe notifier coordination and non-foregrounding behavior. Those product paths were not replaced by this diagnostic observer.

## Validation and release gate

Do not promote this checkpoint based on source review alone.

1. Run the normal self-hosted exact-head notifier validation, including the new diagnostics fixture.
2. Require the helper/installer/candidate-bundle build and isolated Setup acceptance from that same exact SHA.
3. Record the candidate artifact identity and hashes.
4. Use the existing reviewed protected Glass deployment path; do not directly install/reload Chrome from this investigation.
5. Collect fresh runtime evidence proving the installed/live version and that bounded hidden-window incident data survives the helper/export projections.
6. Only then obtain real operator-authorized hidden-window evidence. Do not manufacture acceptance with automated paid/test prompts or focus manipulation.

A successful deployment only means the diagnostic build is present. #439 remains open until an actual coded completion while Chrome is unfocused identifies the first failing boundary and, after any evidence-specific repair, reaches native notification before focus returns.

## Next decision boundary

Once v0.9.27 captures a failed hidden-window incident, follow the measured branch from the original handoff:

- decoded candidate present but production raw scanner misses it → implement a schema-specific bounded decoder only for the observed shape;
- unsupported/handoff transport → design a passive observer for that existing transport rather than guessing an endpoint;
- MAIN receives bytes late → preserve page/lifecycle timing; worker-only detector changes cannot fix that boundary;
- request identity is lost/expired → persist exact lineage until settlement/cancel/supersede;
- page query misses its deadline → remove a round trip only if already-captured exact identity is sufficient;
- queue/helper boundary fails → repair the existing durable delivery path.

No branch above is selected by this checkpoint. The next behavior repair is evidence-gated.
