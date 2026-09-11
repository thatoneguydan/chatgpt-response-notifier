# ChatGPT Response Notifier

Persistent, independently stacked Windows notifications for completed ChatGPT responses.

## What it does

- uses Ram Haidar's upstream prompt-bound completion monitor unchanged for completion detection;
- observes the ChatGPT response request that the page already makes, then inspects the rendered assistant turn in the page DOM;
- does **not** poll ChatGPT APIs, fetch conversation data, or request authentication/session data;
- creates one persistent Windows notification window per completed response;
- stacks multiple notifications instead of replacing earlier ones;
- persists unresolved notifications across helper/browser restarts;
- dismisses a conversation's outstanding notifications when you deliberately interact with that conversation, click a notification, or press its X button;
- clicking a notification focuses an existing matching chat or opens the saved chat URL;
- communicates with the Windows helper only over a loopback WebSocket (`127.0.0.1`);
- checks, downloads, verifies, and installs updates silently in the Windows helper;
- plays the existing two-note completion chime from the helper.

The custom Windows notification contains the chat title, response preview, completion time, and dismiss button. It does not include an extra "click to return" instruction.

## Completion-monitor boundary

`extension/content-script.js` is intentionally kept byte-for-byte identical to upstream revision `cbe00dcfcff8a571f407c6109ed4d5f97cef60a9` (`ChatGPT Prompt-Bound Completion Alert` 1.0.8).

The service worker preserves upstream's monitoring path:

1. observe completion of the existing ChatGPT conversation POST with `chrome.webRequest.onCompleted`;
2. signal the upstream content script;
3. let that content script bind the rendered assistant answer to the latest user prompt;
4. route the resulting `CHATGPT_RESPONSE_COMPLETE` event to the localhost Windows helper.

The helper/update integration must not add ChatGPT HTTP requests. `tests/extension/architecture.test.mjs` and the release workflow enforce this boundary.

## Notification persistence

The Windows helper owns notification lifetime and stacking. Outstanding notifications are saved to disk and restored when the helper restarts. Returning to a tab by itself does not clear them; deliberate pointer/keyboard interaction in the matching conversation does.

## Install

Use the latest `ChatGPT-Response-Notifier-Setup-<version>.exe` from GitHub Releases. The Chrome extension is installed as an unpacked extension from the stable LocalAppData folder created by Setup.

## Update model

The Windows helper reads `update/manifest.json`, downloads the matching release ZIP directly over HTTPS, verifies SHA-256 plus the bundle's internal file inventory, installs the new helper/extension, and hands off to the replacement helper. Chrome does not use its Downloads API for managed updates.

## Upstream and license

Completion monitoring is based on Ram Haidar's **ChatGPT Response Complete Notifier**.

Upstream: `ramhaidar/ChatGPT-Response-Complete-Notifier`, revision `cbe00dcfcff8a571f407c6109ed4d5f97cef60a9`.

Original and modified portions are distributed under GNU GPL v3.0. See `LICENSE` and `NOTICE`.
