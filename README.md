# ChatGPT Response Notifier

Persistent, independently stacked Windows notifications for completed ChatGPT responses.

## What it does

- detects completed responses on `chatgpt.com` with a Chromium extension;
- creates one native Windows toast window per completed response;
- keeps alerts tied to the ChatGPT **conversation**, not a temporary browser tab;
- clicking an alert focuses an existing matching chat or opens the saved chat URL;
- revisiting a conversation dismisses its outstanding alerts;
- persists unresolved alerts across browser/helper restarts;
- communicates only over a loopback WebSocket (`127.0.0.1`);
- checks and downloads updates silently in the Windows helper;
- restores the original two-note completion chime.

## Install

Use the latest `ChatGPT-Response-Notifier-Setup-<version>.exe` from GitHub Releases. The Chrome extension is installed as an unpacked extension from the stable LocalAppData folder created by Setup.

## Update model

The Windows helper reads `update/manifest.json`, downloads the matching release ZIP directly over HTTPS, verifies SHA-256 plus the bundle's internal file inventory, installs the new helper/extension, and hands off to the replacement helper. Chrome does not use its Downloads API for managed updates.

## Upstream and license

This project began from Ram Haidar's **ChatGPT Response Complete Notifier** and was substantially modified in September 2026 to add conversation-owned persistent native Windows notifications, the localhost helper, installer, and managed updater.

Upstream: `ramhaidar/ChatGPT-Response-Complete-Notifier`, revision `cbe00dcfcff8a571f407c6109ed4d5f97cef60a9`.

Licensed under GNU GPL v3.0. See `LICENSE`.
