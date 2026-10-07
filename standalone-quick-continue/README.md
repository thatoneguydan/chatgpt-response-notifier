# ChatGPT Quick Continue

A small, separately installable Chrome extension for timestamped continuation prompts and the settings-driven automatic continuation loop on `chatgpt.com`.

Quick Continue remains separate from ChatGPT Response Notifier for its send controls, editable config, per-chat timestamp state, and automatic watchdog state. The notifier supplies Monitor state plus the canonical rendered-terminal GitHub-status authority. Quick Continue owns the only production automatic-Continue scheduler.

When the notifier helper is installed, Quick Continue also uses that already-running local helper as a narrowly scoped managed-update transport. If the helper is unavailable, the installed Quick Continue runtime keeps working normally; only managed updates pause.

## Controls

- **Monitor** is the small notifier-owned state indicator beside the Quick Continue controls. Turning Monitor on enables the Simple watchdog scheduler; Pause turns the Monitor-owned scheduler off.
- **Continue** immediately sends the configured Continue template.
- **Project** opens the non-modal project picker.
- **☰** opens the Quick Continue menu. It currently contains **Simple watchdog** and **Edit JSON**.
- **Simple watchdog** directly toggles the same deterministic watchdog code and remains available as a temporary manual/debug control.
- **Edit JSON** opens the live validated configuration editor.
- Click the **time at the right side of the toolbar** to toggle timestamps for ordinary manually typed ChatGPT messages.

Continue and Project use the configured `{time}` placeholder. Project also replaces `{project}`. Manual timestamping uses both `{time}` and `{message}`. JSON `\n` escapes remain real line breaks.

Manual timestamp mode is remembered independently for each ChatGPT conversation. The watchdog can start before a new chat is saved and binds to that tab's first conversation ID without restarting its deadline.

## Primary Simple watchdog

Quick Continue 1.2.37 is the first release where this Simple path is the primary Monitor watchdog rather than a fallback path.

Quick Continue's Simple watchdog is the production continuation scheduler behind Monitor. The former notifier watchdog scheduler and notifier countdown surface are retired in production.

Monitor state is passed to Quick Continue without ChatGPT API polling. When Monitor is enabled, trusted manual sends and trusted Quick Continue/Project sends reset the Simple watchdog to a fresh configured countdown. Programmatic automatic Continue sends do not reset their own finite retry allowance.

The watchdog can react to an exact terminal `[GITHUB_STATUS: ...]` footer from the current assistant turn. `watchdog.stopOnStatus` is the shared classification table: `true` is a **stop class** and `false` is a **continue class**. The two Simple settings decide whether each class is respected:

- `simpleWatchdog.respectStopStatusCodes: true` — a stop-class footer turns the watchdog off immediately. `false` ignores that class.
- `simpleWatchdog.respectContinueStatusCodes: true` — a continue-class footer sends one immediate Continue through the Simple send path, consumes one attempt, and starts the next countdown. `false` ignores that class.

Ignoring a class never converts it into the opposite action. Status-triggered Continue is deduplicated by the exact conversation/assistant-turn/status footer and shares the same finite attempt cap as timer-triggered sends.

Every timer-driven attempt follows this fixed sequence:

1. Wait `simpleWatchdog.timerMinutes`.
2. Click ChatGPT's native **Stop** button if one is present. A missing Stop button does not cancel the sequence.
3. Wait `simpleWatchdog.stopToRefreshSeconds`.
4. Reload the same ChatGPT tab.
5. Wait until Chrome reports that the reloaded page has finished loading. This prevents a stale/interrupted page from being treated as ready merely because `tabs.reload()` returned.
6. Wait `simpleWatchdog.refreshToContinueSeconds`.
7. Replace the composer contents with the configured `continueText` and submit it through Quick Continue's normal send transaction.
8. Count one attempt. If attempts remain, start a new `timerMinutes` countdown and repeat.

This ordering is intentionally designed for ChatGPT's **Connection interrupted** state: the watchdog does not attempt Continue against the interrupted page first. It performs Stop → wait → refresh → page-ready wait → configured wait → Continue.

The phase, deadline, attempt count, conversation identity, settings snapshot, status classification, and last handled status fingerprint are persisted in Chrome local extension storage. Chrome alarms own phase deadlines, so ordinary MV3 service-worker sleep does not erase the loop. A footer already present when the watchdog is enabled is baselined rather than treated as a new status event.

At the send phase the watchdog can replace an existing composer draft under its "send when due" contract. It remains scoped to the same tab and, once created, the same conversation.

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
  "projects": [
    "campaign desk",
    "notifier extension"
  ]
}
```

`watchdog` now owns only the shared GitHub-status classification table. `simpleWatchdog` is the sole timer/retry/refresh configuration.

Simple fields:

- `timerMinutes` — countdown before each Stop/refresh/send sequence. Valid range: 0.1–1440 minutes.
- `attempts` — maximum number of Continue attempts for one run. Valid range: 0–20; `0` prevents the watchdog from starting.
- `stopToRefreshSeconds` — delay after the Stop click before reloading. Valid range: 0–3600 seconds.
- `refreshToContinueSeconds` — delay after the refreshed page is fully loaded before sending Continue. Valid range: 0–3600 seconds.
- `respectStopStatusCodes` — whether Simple acts on statuses classified `true` in `watchdog.stopOnStatus`.
- `respectContinueStatusCodes` — whether Simple acts on statuses classified `false` in `watchdog.stopOnStatus`.

Older saved configurations are normalized automatically. Legacy `watchdog.timerMinutes` / `watchdog.attempts` can seed Simple when Simple values are absent, and old `watchdog.respect*StatusCodes` values migrate into `simpleWatchdog`. The serialized current form removes those retired fields from `watchdog`.

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

The automatic watchdog is the explicit exception to normal draft preservation at its scheduled or status-triggered send phase. This exception is limited to its enabled run.

Config and per-chat state stay in Chrome local extension storage. Quick Continue does not poll ChatGPT APIs or send ChatGPT network requests outside the same page submission/reload actions the user requested.

## Install

Run the included installer from PowerShell with a temporary execution-policy bypass:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1
```

It copies the extension and bundled config to `%LOCALAPPDATA%\ChatGPTQuickContinue\Extension` and prints the one-time **Load unpacked** steps for `chrome://extensions`.

Once the managed extension is loaded, later releases require no PowerShell command, manual extension reload, or ChatGPT page refresh. The existing notifier helper installs the update and Quick Continue hot-reloads/reinjects itself.
