# Runtime regression — occluded Windows virtual desktop

Date: 2026-09-15
Authority: `thatoneguydan/DevelopmentInfrastructure#439`
Live baseline: v0.9.24

## Observed failure

A coded completion notification did not appear while the Chrome window remained on another Windows virtual desktop. It appeared only after that Chrome window was brought back into view.

Sanitized runtime evidence from `Collect notifier runtime evidence` run `35009987984`, attempt 3 / artifact `10414237424` shows:

- conversation request completion wake: `2026-09-15T19:17:05.338Z`;
- tab lifecycle at request completion: `frozen=false;discarded=false;active=true`;
- first coded observation/claim/queue: approximately `2026-09-15T19:19:42.692Z`;
- delivered path: `coded-completion-status-observer`.

This rules out Chrome frozen/discarded state as the cause for this reproduction. The remaining boundary is page-side publication: `monitor-script.js` batches DOM/request-state publication behind a 200 ms page `setTimeout()`, while the extension background worker receives `webRequest.onCompleted` immediately.

## Candidate v0.9.25 repair

On successful conversation-request completion, the background lifecycle hook now:

1. requires the exact Chrome `documentId` from the completed request;
2. refuses frozen/discarded/unroutable pages;
3. directly calls the existing read-only `queryTerminalStatus()` status observer for that exact document;
4. requires a valid terminal status and complete conversation/prompt/assistant/revision identity;
5. hands the synthesized monitor snapshot to the existing `scheduleObservedStatusDelivery()` durable pipeline.

The status query waits on the existing DOM `MutationObserver`, so the primary request-completion wake no longer waits for the page-side monitor publish timer. The original monitor publication path remains enabled as fallback/dedupe.

No ChatGPT API/session polling, response replay, debugger attachment, automatic foregrounding, or new browser permission is introduced.

## Acceptance

Promotion still requires exact-head validation, release publication, protected Glass deployment, post-install runtime evidence, and a real live coded completion while the Chrome window remains on another Windows virtual desktop.
