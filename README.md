# ChatGPT Response Notifier

Persistent, independently stacked Windows notifications for completed ChatGPT responses.

## What it does

- uses Ram Haidar's upstream prompt-bound completion monitor unchanged for normal completion detection;
- observes the ChatGPT response request that the page already makes, then inspects the rendered assistant turn in the page DOM;
- does **not** poll ChatGPT APIs, fetch conversation data, or request authentication/session data;
- locally remembers an in-progress conversation so monitoring can recover after a page refresh or Chrome restart;
- creates one persistent Windows notification window per completed response;
- stacks multiple notifications instead of replacing earlier ones;
- persists unresolved notifications across helper/browser restarts and managed-update handoffs;
- keeps the 10 most recent real completion notifications in extension-local history, even after their Windows toast is dismissed;
- makes those recent notifications clickable from the pinned extension popup;
- dismisses a conversation's outstanding notifications when you deliberately interact with that conversation, click a notification, or press its X button;
- clicking a Windows notification focuses an existing matching chat or opens the saved chat URL;
- communicates with the Windows helper only over a loopback WebSocket (`127.0.0.1`);
- checks, downloads, verifies, and installs updates silently in the Windows helper;
- plays the existing two-note completion chime from the helper.

The custom Windows notification contains the chat title, response preview, completion time, and dismiss button. It does not include an extra "click to return" instruction.

## Completion-monitor boundary

`extension/content-script.js` is intentionally kept byte-for-byte identical to upstream revision `cbe00dcfcff8a571f407c6109ed4d5f97cef60a9` (`ChatGPT Prompt-Bound Completion Alert` 1.0.8).

The normal path remains upstream's monitoring path:

1. observe completion of the existing ChatGPT conversation POST with `chrome.webRequest.onCompleted`;
2. signal the upstream content script;
3. let that content script bind the rendered assistant answer to the latest user prompt;
4. route the resulting `CHATGPT_RESPONSE_COMPLETE` event to the localhost Windows helper.

The helper/update/recovery/history integration must not add ChatGPT HTTP requests. `tests/extension/architecture.test.mjs` and the release workflow enforce this boundary.

## Refresh and Chrome-restart recovery

Recovery is a separate layer; it does not make the normal detector stricter and it does not modify `content-script.js`.

When the existing ChatGPT conversation POST starts, `extension/recovery-background.js` records only the conversation ID, URL, and local start time in extension-local IndexedDB. It does not read the request body and does not make a request of its own. The pending marker expires after seven days and is cleared on normal completion or a manual Stop action.

If that same conversation page later reloads while the marker is still pending, `extension/recovery-script.js` watches the latest assistant turn. It does **not** require the composer Stop/send button to be in any particular state. Any recognized finished-response action on that assistant turn (for example More actions or Copy) is enough to re-arm the unchanged upstream content script, which then produces the normal completion event and notification.

If Chrome is completely closed when the response finishes, the extension cannot notify while Chrome is closed. The pending marker survives; recovery occurs after Chrome reopens and that conversation page loads again.

## Notification persistence

The Windows helper owns active notification lifetime and stacking. Outstanding notifications are saved to disk and restored when the helper restarts. Helper teardown during a managed update is not treated as a user dismissal, so active notifications return after the replacement helper starts. Returning to a tab by itself does not clear them; deliberate pointer/keyboard interaction in the matching conversation does.

## Popup history

The pinned extension popup is intentionally minimal. Its main surface is the 10 most recent real ChatGPT completion notifications, newest first. Each item contains the chat title, response preview, and completion time and can be clicked to focus or reopen that conversation. This history is stored in extension-local IndexedDB and is separate from active Windows-toast state, so dismissing a toast does not remove it from recent history. Test notifications are not added to history.

The footer contains only the extension version plus compact **Update** and **Test** buttons.

## Install

Use the latest `ChatGPT-Response-Notifier-Setup-<version>.exe` from GitHub Releases. Setup installs the extension files into `%LOCALAPPDATA%\ChatGPTResponseNotifier\Extension`. On the first install, load that folder once with Chrome's **Load unpacked** button; managed updates keep using the same stable folder and extension ID afterward.

## Update model

The Windows helper reads `update/manifest.json`, downloads the matching release ZIP directly over HTTPS, verifies SHA-256 plus the bundle's internal file inventory, installs the new helper/extension, and hands off to the replacement helper. Chrome does not use its Downloads API for managed updates.

## Upstream and license

Completion monitoring is based on Ram Haidar's **ChatGPT Response Complete Notifier**.

Upstream: `ramhaidar/ChatGPT-Response-Complete-Notifier`, revision `cbe00dcfcff8a571f407c6109ed4d5f97cef60a9`.

Original and modified portions are distributed under GNU GPL v3.0. See `LICENSE` and `NOTICE`.
