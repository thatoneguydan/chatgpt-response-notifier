# ChatGPT Quick Continue

A small, separately installable Chrome extension for timestamped continuation prompts and the settings-driven automatic continuation loop on `chatgpt.com`.

Quick Continue remains separate from ChatGPT Response Notifier for its send controls, editable config, per-chat timestamp state, and automatic watchdog state. The notifier supplies Monitor state plus the canonical rendered-terminal GitHub-status authority. Quick Continue owns two independent watchdog engines: the Monitor watchdog and the manually controlled Simple watchdog.

When the notifier helper is installed, Quick Continue also uses that already-running local helper as a narrowly scoped managed-update transport. If the helper is unavailable, the installed Quick Continue runtime keeps working normally; only managed updates pause.

## Controls

- **Monitor** is the small notifier-owned state indicator beside the Quick Continue controls. Turning Monitor on enables the independent Monitor watchdog; Pause turns that Monitor watchdog off.
- **Continue** immediately sends the configured Continue template.
- **Project** opens the non-modal project picker.
- **☰** opens the Quick Continue menu. It currently contains **Simple watchdog** and **Edit JSON**.
- **Simple watchdog** is a separate manual watchdog. Its toggle, state, alarms, retry budget, and settings do not follow Monitor.
- **Edit JSON** opens the live validated configuration editor.
- Click the **time at the right side of the toolbar** to toggle timestamps for ordinary manually typed ChatGPT messages.

Continue and Project use the configured `{time}` placeholder. Project also replaces `{project}`. Manual timestamping uses both `{time}` and `{message}`. JSON `\n` escapes remain real line breaks.

Manual timestamp mode is remembered independently for each ChatGPT conversation. Either watchdog can start before a new chat is saved and bind to that tab's first conversation ID without restarting its deadline.

## Independent Monitor and Simple watchdogs

Quick Continue 1.2.39 forks the current Simple implementation into a separate Monitor implementation. At the fork point they intentionally use the same proven state machine and recovery sequence, but they no longer share runtime ownership.

**Monitor** has its own storage key, Chrome alarm namespace, message types, state, retry budget, countdown surface, and `monitorWatchdog` configuration. Monitor on/off state is passed from ChatGPT Response Notifier to this Monitor runtime without ChatGPT API polling. Trusted manual sends and trusted Quick Continue/Project sends reset the Monitor countdown while Monitor is enabled. Programmatic automatic Continue sends do not reset their own finite retry allowance.

**Simple watchdog** retains its existing hamburger-menu toggle and its own `quickContinueSimpleWatchdogStates`, `quick-continue-simple-watchdog:` alarms, `QUICK_CONTINUE_SIMPLE_WATCHDOG_*` messages, and `simpleWatchdog` configuration. Monitor no longer toggles or resets Simple. Future Monitor-specific changes can therefore diverge without changing Simple unless Simple is explicitly changed as well.

On the first normalized configuration that does not yet contain `monitorWatchdog`, Monitor is seeded from the user's current normalized `simpleWatchdog` values. Once saved, the two configuration blocks are independent.

Both watchdogs can react to the exact terminal `[GITHUB_STATUS: ...]` footer from the current assistant turn. `watchdog.stopOnStatus` remains the shared classification table: `true` is a **stop class** and `false` is a **continue class**. Each watchdog has its own `respectStopStatusCodes` and `respectContinueStatusCodes` switches.

Ignoring a class never converts it into the opposite action. Status-triggered Continue is deduplicated by the exact conversation/assistant-turn/status footer and shares that watchdog's finite attempt cap with timer-triggered sends.

Each timer-driven attempt follows the same current sequence:

1. Wait that watchdog's `timerMinutes`.
2. Click ChatGPT's native **Stop** button if one is present. A missing Stop button does not cancel the sequence.
3. Wait that watchdog's `stopToRefreshSeconds`.
4. Reload the same ChatGPT tab.
5. Wait until Chrome reports that the reloaded page has finished loading.
6. Wait that watchdog's `refreshToContinueSeconds`.
7. Replace the composer contents with the configured `continueText` and submit it through Quick Continue's normal send transaction.
8. Count one attempt. If attempts remain, start a new `timerMinutes` countdown and repeat.

This ordering is intentionally designed for ChatGPT's **Connection interrupted** state: the watchdog performs Stop → wait → refresh → page-ready wait → configured wait → Continue instead of first attempting Continue against the interrupted page.

The phase, deadline, attempt count, conversation identity, settings snapshot, status classification, and last handled status fingerprint are persisted in Chrome local extension storage. Chrome alarms own phase deadlines, so ordinary MV3 service-worker sleep does not erase either loop. A footer already present when a watchdog is enabled is baselined rather than treated as a new status event.

At the send phase an enabled watchdog can replace an existing composer draft under its "send when due" contract. Each run remains scoped to the same tab and, once created, the same conversation.

## Editable JSON

The bundled `config.json` is the readable default. **☰ > Edit JSON** edits the validated live copy stored in Chrome local extension storage and applies changes immediately.

```json
{
  "continueText": "[{time}] Continue until you finish or need something from me.",
  "projectText": "[{time}] Continue {project} from canonical GitHub state until you finish or need me.",
  "manualTimestampText": "[{time}] {message}",
  "watchdog": {
    "stopOnStatus": {
      "PLANNING_ACTIVE": true,
      "COMPLETE_APPLIED": true,
      "COMPLETE_NO_CHANGES": true,
      "BLOCKED_HUMAN": true,
      "INCOMPLETE_LIMIT": false,
      "INCOMPLETE_TOOL_FAILURE": false,
      "INCOMPLETE_CONTINUE": false,
      "INCOMPLETE_HANDOFF": false
    }
  },
  "simpleWatchdog": {
    "timerMinutes": 30,
    "attempts": 3,
    "stopToRefreshSeconds": 30,
    "refreshToContinueSeconds": 30,
    "respectStopStatusCodes": true,
    "respectContinueStatusCodes": true
  },
  "monitorWatchdog": {
    "timerMinutes": 30,
    "attempts": 3,
    "stopToRefreshSeconds": 30,
    "refreshToContinueSeconds": 30,
    "respectStopStatusCodes": true,
    "respectContinueStatusCodes": true
  },
  "projects": [
    "campaign desk",
    "notifier extension"
  ]
}
```

`watchdog` owns only the shared GitHub-status classification table. `simpleWatchdog` configures the independent hamburger Simple watchdog; `monitorWatchdog` configures the independent Monitor watchdog. Both watchdog blocks use the same field schema:

- `timerMinutes` — countdown before each Stop/refresh/send sequence. Valid range: 0.1–1440 minutes.
- `attempts` — maximum number of Continue attempts for one run. Valid range: 0–20; `0` prevents the watchdog from starting.
- `stopToRefreshSeconds` — delay after the Stop click before reloading. Valid range: 0–3600 seconds.
- `refreshToContinueSeconds` — delay after the refreshed page is fully loaded before sending Continue. Valid range: 0–3600 seconds.
- `respectStopStatusCodes` — whether that watchdog acts on statuses classified `true` in `watchdog.stopOnStatus`.
- `respectContinueStatusCodes` — whether that watchdog acts on statuses classified `false` in `watchdog.stopOnStatus`.

Older saved configurations are normalized automatically. Legacy `watchdog.timerMinutes` / `watchdog.attempts` can seed Simple when Simple values are absent, and old `watchdog.respect*StatusCodes` values migrate into `simpleWatchdog`. If `monitorWatchdog` is absent, it is seeded once from the resulting Simple settings. The serialized current form stores both watchdog blocks independently and removes retired timing fields from `watchdog`.

Template placeholders:

- `{time}` — local send timestamp, for example `Sep 30, 2:46 PM`.
- `{project}` — selected or typed project name; required in `projectText`.
- `{message}` — manually typed message; required in `manualTimestampText`.

If a Continue or Project template omits `{time}`, config normalization inserts `[{time}] ` at the front.

To put the timestamp and manual message on separate lines:

```json
"manualTimestampText": "[{time}]\n{message}"
```

The installed default file is `%LOCALAPPDATA%\ChatGPTQuickContinue\Extension\config.json`. Normal ongoing changes should use **☰ > Edit JSON** so they apply immediately.

## Managed updates

- The ChatGPT Response Notifier Windows helper checks the published Quick Continue feed and accepts only the expected GitHub release route plus published SHA-256 digest.
- Updates are written in place to the stable unpacked-extension directory with `manifest.json` copied last; the installed `config.json` is preserved.
- Quick Continue's service worker polls only the loopback helper (`127.0.0.1`) every 15 minutes and at browser/extension startup. It does not download code itself.
- After a newer version is installed, Quick Continue reloads itself and reinjects the current runtime into already-open ChatGPT tabs. A manual ChatGPT refresh is not required for managed extension updates.

## Other safety behavior

Normal **Continue** and **Project** actions do not overwrite an existing draft. Manual timestamping only runs on trusted user Send/Enter actions, ignores Shift+Enter and IME composition, and does not stamp an already timestamped message again. Quick Continue's own programmatic sends are excluded from the manual timestamp hook.

An enabled automatic watchdog is the explicit exception to normal draft preservation at its scheduled or status-triggered send phase. This exception is limited to that watchdog's enabled run.

Config and per-chat state stay in Chrome local extension storage. Quick Continue does not poll ChatGPT APIs or send ChatGPT network requests outside the same page submission/reload actions the user requested.

## Install

Run the included installer from PowerShell with a temporary execution-policy bypass:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1
```

It copies the extension and bundled config to `%LOCALAPPDATA%\ChatGPTQuickContinue\Extension` and prints the one-time **Load unpacked** steps for `chrome://extensions`.

Once the managed extension is loaded, later releases require no PowerShell command, manual extension reload, or ChatGPT page refresh. The existing notifier helper installs the update and Quick Continue hot-reloads/reinjects itself.
