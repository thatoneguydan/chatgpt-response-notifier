# ChatGPT Response Notifier

Persistent, independently stacked Windows notifications for GitHub-backed ChatGPT work that ends with a terminal work-session status footer.

## What it does

- uses Ram Haidar's upstream prompt-bound completion monitor unchanged for normal completion detection;
- observes the ChatGPT response request that the page already makes, then inspects the rendered assistant turn in the page DOM;
- does **not** poll ChatGPT APIs, fetch conversation data, or request authentication/session data;
- recognizes only the canonical GitHub work-session status codes mirrored from `DevelopmentInfrastructure/GITHUB-WORK-STATUS-POLICY.md`;
- automatically responds to a completed `INCOMPLETE_LIMIT` turn with `continue until you finish or need something from me` through the existing ChatGPT composer when it is safe to do so;
- falls back to the ordinary `INCOMPLETE_LIMIT` notification if the composer is focused, non-empty, unavailable, still generating, changes underneath the attempt, or cannot confirm that Send was accepted;
- locally remembers an in-progress conversation so monitoring can recover after a page refresh or Chrome restart;
- creates one persistent Windows notification window per eligible completed response that still requires notification;
- stacks multiple notifications instead of replacing earlier ones;
- persists unresolved notifications across helper/browser restarts and managed-update handoffs;
- keeps the 20 most recent eligible coded notifications in extension-local history, even after their Windows toast is dismissed;
- makes those recent notifications clickable from the pinned extension popup;
- dismisses a conversation's outstanding notifications when you deliberately interact with that conversation, click a notification, or press its X button;
- clicking a Windows notification focuses an existing matching chat or opens the saved chat URL;
- communicates with the Windows helper only over a loopback WebSocket (`127.0.0.1`);
- checks, downloads, verifies, and installs updates silently in the Windows helper;
- plays the existing two-note completion chime from the helper.

The Windows toast is intentionally compact and light themed. It renders the full Chrome tab title, the GitHub work-session status code, and the dismiss button. The response preview and completion timestamp remain in the notification payload/persisted model for popup history and possible future toast layouts, but are not rendered in the Windows toast.

## Completion-monitor boundary

`extension/content-script.js` is intentionally kept byte-for-byte identical to upstream revision `cbe00dcfcff8a571f407c6109ed4d5f97cef60a9` (`ChatGPT Prompt-Bound Completion Alert` 1.0.8).

The normal path remains upstream's monitoring path:

1. observe completion of the existing ChatGPT conversation POST with `chrome.webRequest.onCompleted`;
2. signal the upstream content script;
3. let that content script bind the rendered assistant answer to the latest user prompt;
4. receive the resulting `CHATGPT_RESPONSE_COMPLETE` event;
5. query the separate local DOM status layer for an exact terminal `[GITHUB_STATUS: CODE]` footer;
6. if the code is `INCOMPLETE_LIMIT`, attempt the guarded local composer continuation;
7. otherwise, or if that continuation cannot be completed safely, create the persistent Windows notification.

Ram's content script intentionally normalizes response whitespace, so terminal-line recognition and the local composer continuation live in separate `status-code.js` / `status-script.js` files that preserve DOM line boundaries. These scripts make no network requests.

The helper/update/recovery/history integration must not add ChatGPT HTTP requests. `tests/extension/architecture.test.mjs` and the release workflow enforce this boundary.

## Status-footer eligibility

Only the final non-whitespace line of the latest assistant response is eligible. A status-looking line mentioned earlier in a response does not trigger notifier handling.

The accepted structural form is:

```text
[GITHUB_STATUS: UPPERCASE_CODE]
```

The current accepted codes are `PLANNING_ACTIVE`, `COMPLETE_APPLIED`, `COMPLETE_NO_CHANGES`, `BLOCKED_HUMAN`, `INCOMPLETE_LIMIT`, `INCOMPLETE_TOOL_FAILURE`, and `INCOMPLETE_HANDOFF`. The list intentionally mirrors the canonical DevelopmentInfrastructure policy rather than accepting arbitrary uppercase tokens, so a future taxonomy change requires an intentional notifier update.

A completed response without a valid terminal footer is ignored: no auto-continuation, Windows toast, chime, or popup-history entry.

## `INCOMPLETE_LIMIT` auto-continuation

`INCOMPLETE_LIMIT` is treated as a machine-actionable continuation request instead of something that normally needs operator attention. Once the same terminal footer used by the notifier is confirmed, `status-script.js` tries to place exactly this text into ChatGPT's existing composer:

```text
continue until you finish or need something from me
```

The extension then clicks an enabled semantic Send button. This is DOM interaction only: it does not call a ChatGPT backend API, reuse authentication data, or create additional HTTP requests itself.

The continuation is intentionally conservative. It will not proceed if the composer already contains text or currently has keyboard focus, if a Stop-generating control is still present, if the assistant turn changes during the attempt, or if the inserted text changes before Send. It also verifies that the send was accepted. If any safeguard fails, the original `INCOMPLETE_LIMIT` code remains eligible and the ordinary persistent notification is shown instead of silently dropping the handoff.

Successful auto-continuations do not create a Windows toast or popup-history item. The next assistant response is monitored normally and can itself auto-continue, notify, or complete according to its terminal status code.

## Refresh and Chrome-restart recovery

Recovery is a separate layer; it does not make the normal detector stricter and it does not modify `content-script.js`.

When the existing ChatGPT conversation POST starts, `extension/recovery-background.js` records only the conversation ID, URL, and local start time in extension-local IndexedDB. It does not read the request body and does not make a request of its own. The pending marker expires after seven days and is cleared on normal completion or a manual Stop action.

If that same conversation page later reloads while the marker is still pending, `extension/recovery-script.js` watches the latest assistant turn for the same terminal GitHub status footer used by the normal notification path. Once the footer appears, recovery re-arms the unchanged upstream content script, which produces the ordinary completion event and runs through the same eligibility/deduplication and `INCOMPLETE_LIMIT` auto-continuation path. Recovery does not depend on More Actions, Copy, rating, Read Aloud, or other finished-response UI controls.

The composer Stop/send control is never used to decide that a response is complete. Manual-stop cleanup remains separate and protects pre-typed follow-up text from being mistaken for a cancellation.

If Chrome is completely closed when the response finishes, the extension cannot act while Chrome is closed. The pending marker survives; recovery occurs after Chrome reopens and that conversation page loads again.

## Notification persistence

The Windows helper owns active notification lifetime and stacking. Outstanding notifications are saved to disk and restored when the helper restarts. Helper teardown during a managed update is not treated as a user dismissal, so active notifications return after the replacement helper starts. Returning to a tab by itself does not clear them; deliberate pointer/keyboard interaction in the matching conversation does.

Notifications persisted by v0.6.0 remain loadable after later updates. Older outstanding notifications have no stored status code, so they restore title-only rather than being discarded.

## Popup history

The pinned extension popup is intentionally minimal. Its main surface is the rolling 20 most recent eligible coded ChatGPT notifications, newest first. Each item contains the full tab title, status code, response preview, and completion time and can be clicked to focus or reopen that conversation. This history is stored in extension-local IndexedDB and is separate from active Windows-toast state, so dismissing a toast does not remove it from recent history. Old uncoded history, test notifications, and successful `INCOMPLETE_LIMIT` auto-continuations are not shown.

The footer contains only the extension version plus compact **Update** and **Test** buttons.

## Known-good rollback

The last pre-status-gating build is release `v0.6.0`. Canonical commit `9d50efe196ce0c1145790548e320824133092340` is also preserved on branch `known-good/v0.6.0` so the complete working source plus its v0.6.0 managed-update manifest remains easy to recover.

## Install

Use the latest `ChatGPT-Response-Notifier-Setup-<version>.exe` from GitHub Releases. Setup installs the extension files into `%LOCALAPPDATA%\ChatGPTResponseNotifier\Extension`. On the first install, load that folder once with Chrome's **Load unpacked** button; managed updates keep using the same stable folder and extension ID afterward.

## Update model

The Windows helper reads `update/manifest.json`, downloads the matching release ZIP directly over HTTPS, verifies SHA-256 plus the bundle's internal file inventory, installs the new helper/extension, and hands off to the replacement helper. Chrome does not use its Downloads API for managed updates.

## Upstream and license

Completion monitoring is based on Ram Haidar's **ChatGPT Response Complete Notifier**.

Upstream: `ramhaidar/ChatGPT-Response-Complete-Notifier`, revision `cbe00dcfcff8a571f407c6109ed4d5f97cef60a9`.

Original and modified portions are distributed under GNU GPL v3.0. See `LICENSE` and `NOTICE`.
