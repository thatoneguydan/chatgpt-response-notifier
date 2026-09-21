# Notifier + Quick Continue deep debug — 2026-09-21

Scope: ChatGPT Response Notifier v0.9.53 and standalone Quick Continue v1.2.3, following the live reports of terminal timer flicker, delayed Continue after terminal status, monitoring-state instability, and toolbar flicker.

## Confirmed findings

1. **Terminal policy was not `BLOCKED_HUMAN`-specific.** The canonical continuation policy permits automatic continuation only for `INCOMPLETE_LIMIT`, `INCOMPLETE_TOOL_FAILURE`, `INCOMPLETE_CONTINUE`, and `INCOMPLETE_HANDOFF`. Every other recognized terminal code is a stop. The observed differences were races around correct policy, not different intended treatment by status code.
2. **v0.9.53 still had an ordering ambiguity.** Worker reconciliation/alarm mutations were serialized, but attachment freshness ordered same-enrollment watchdog overviews by millisecond `updatedAt`. Two durable writes in the same millisecond could therefore be indistinguishable while `chrome.tabs.sendMessage` delivery was free to reverse them.
3. **Two watchdog mutations remained outside the v0.9.53 queue.** Explicit disable/clear and manual allowance reset could overlap reconciliation/alarm work.
4. **Quick Continue and notifier share page DOM.** Quick Continue owns `#chatgpt-quick-continue-toolbar`; notifier injects its indicator/countdown into that toolbar. Both extensions observed broad document mutations, so notifier countdown updates unnecessarily woke Quick Continue.
5. **Quick Continue had stale-runtime lifecycle debt.** Its content script used a permanent install boolean; helper APIs kept first-generation globals; disposal omitted document/window listeners; and a detached toolbar remained referenced but was not reattached.
6. **Quick Continue could self-trigger continuous layout work.** `syncToolbar()` always rewrote the clock's `textContent`, while the full-document `MutationObserver` watched child-list changes. The clock write could therefore schedule the next sync itself even when the displayed time had not changed.

## Repairs

- Add `watchdogRevision` to durable watchdog records and prefer logical revision ordering in attachment runtime v12.
- Serialize reconcile, alarm, disable/clear, and allowance-reset mutations through one conversation queue.
- Advance notifier release to v0.9.54 and keep timestamp ordering only as migration fallback for legacy watchdog records.
- Version Quick Continue prompt/config/content runtimes; dispose owned listeners; restore detached toolbar DOM; suppress notifier-only mutation wakeups.
- Guard the Quick Continue clock assignment so unchanged text produces no DOM mutation.
- Advance standalone Quick Continue to v1.2.4.

## Regression gates

- Reversed same-millisecond watchdog overviews cannot replace a newer stopped record.
- A revisioned watchdog cannot be replaced by a timestamp-only legacy overview at the same enrollment revision.
- Disable/clear and allowance reset are statically required to use the watchdog mutation queue.
- Quick Continue source is required to use versioned runtime replacement, matching add/remove listener pairs, detached-root recovery, notifier-mutation suppression, and guarded clock text updates.
- Existing policy tests continue to assert `BLOCKED_HUMAN` is not auto-continuable.

PR: #167.
