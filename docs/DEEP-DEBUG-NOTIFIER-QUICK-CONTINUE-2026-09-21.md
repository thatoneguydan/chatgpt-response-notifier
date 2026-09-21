# Notifier + Quick Continue deep debug — 2026-09-21

Scope: ChatGPT Response Notifier v0.9.53 and standalone Quick Continue v1.2.3, following the live reports of terminal timer flicker, delayed Continue after terminal status, monitoring-state instability, and toolbar flicker.

## Confirmed findings

1. **Terminal policy was not `BLOCKED_HUMAN`-specific.** The canonical continuation policy permits automatic continuation only for `INCOMPLETE_LIMIT`, `INCOMPLETE_TOOL_FAILURE`, `INCOMPLETE_CONTINUE`, and `INCOMPLETE_HANDOFF`. Every other recognized terminal code is a stop. The observed differences were races around correct policy, not different intended treatment by status code.
2. **v0.9.53 still had an ordering ambiguity.** Worker reconciliation/alarm mutations were serialized, but attachment freshness ordered same-enrollment watchdog overviews by millisecond `updatedAt`. Two durable writes in the same millisecond could therefore be indistinguishable while `chrome.tabs.sendMessage` delivery was free to reverse them.
3. **Two watchdog mutations remained outside the v0.9.53 queue.** Explicit disable/clear and manual allowance reset could overlap reconciliation/alarm work.
4. **Quick Continue and notifier share page DOM.** Quick Continue owns `#chatgpt-quick-continue-toolbar`; notifier injects its indicator/countdown into that toolbar. Both extensions observed broad document mutations, so notifier countdown updates unnecessarily woke Quick Continue.
5. **Quick Continue had stale-runtime lifecycle debt.** Its content script used a permanent install boolean; helper APIs kept first-generation globals; disposal omitted document/window listeners; and a detached toolbar remained referenced but was not reattached.
6. **Quick Continue could self-trigger continuous layout work.** `syncToolbar()` always rewrote the clock's `textContent`, while the full-document `MutationObserver` watched child-list changes. The clock write could therefore schedule the next sync itself even when the displayed time had not changed.
7. **Watchdog revisions are lifecycle-local.** Clearing monitoring deletes the watchdog record, so its logical revision restarts on the next enrollment. Comparing watchdog revisions across different enrollment revisions could reject a valid post-resume watchdog as stale.
8. **New-chat Project enrollment could lose freshness.** A Project Continue can begin while the tab is still `/`. If the monitor runtime is replaced when ChatGPT assigns `/c/<id>`, the replacement runtime can receive only the request's completed/error event. The old handler left `requestStartedAt = 0`, which made the otherwise valid project-start signal fail the worker's fresh-request gate.
9. **CI did not execute standalone Quick Continue tests.** The self-hosted validate/release workflows discovered only `tests/extension/*.test.mjs`, so companion runtime changes could ship behind notifier-only green checks.
10. **Standalone update activation needs a host-page reload.** Quick Continue is a static content-script extension with no background/scripting reinjection path. Chrome's documented development lifecycle requires reloading the extension **and the host page** for content-script changes; replacing files plus only reloading the extension is insufficient for already-open ChatGPT tabs.

## Repairs

- Add `watchdogRevision` to durable watchdog records and prefer logical revision ordering in attachment runtime v12.
- Serialize reconcile, alarm, disable/clear, and allowance-reset mutations through one conversation queue.
- Advance notifier release to v0.9.54 and keep timestamp ordering only as migration fallback for legacy watchdog records.
- Version Quick Continue prompt/config/content runtimes; dispose owned listeners; restore detached toolbar DOM; suppress notifier-only mutation wakeups.
- Guard the Quick Continue clock assignment so unchanged text produces no DOM mutation.
- Scope watchdog freshness ordering to one enrollment revision so Pause/Resume can restart the watchdog record safely.
- Carry request-start evidence from the worker into every request phase; monitor runtime v11 restores it when a replacement page sees only completion/error.
- Run standalone Quick Continue syntax/behavior gates in both validation and release.
- Add a pinned 1.2.4 updater that replaces the changed runtime files without overwriting `config.json`, and explicitly reports both the extension-reload and ChatGPT-page-reload requirements.
- Advance standalone Quick Continue to v1.2.4.

## Regression gates

- Reversed same-millisecond watchdog overviews cannot replace a newer stopped record.
- A revisioned watchdog cannot be replaced by a timestamp-only legacy overview at the same enrollment revision.
- Disable/clear and allowance reset are statically required to use the watchdog mutation queue.
- Quick Continue source is required to use versioned runtime replacement, matching add/remove listener pairs, detached-root recovery, notifier-mutation suppression, and guarded clock text updates.
- Existing policy tests continue to assert `BLOCKED_HUMAN` is not auto-continuable.
- A higher enrollment revision accepts a newly reset watchdog revision instead of inheriting stale ordering from the previous lifecycle.
- Request completion preserves the original browser-observed start time, and a completed-only page runtime reconstructs nonzero `requestStartedAt`.
- Standalone Quick Continue tests are executed by both PR validation and release gates.

PR: #167.
