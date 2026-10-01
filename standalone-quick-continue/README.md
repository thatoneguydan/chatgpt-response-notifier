# ChatGPT Quick Continue

A small, separately installable Chrome extension for timestamped continuation prompts on `chatgpt.com`.

Quick Continue remains separate from ChatGPT Response Notifier for its send controls, editable config, per-chat timestamp state, and the Simple fallback watchdog. When the notifier helper is installed, Quick Continue also uses that already-running local helper as a narrowly scoped managed-update transport. If the helper is unavailable, the installed Quick Continue runtime keeps working normally; only managed updates pause.

When ChatGPT Response Notifier is enabled, it can add its own smart monitoring-state indicator and countdown around the Quick Continue controls. Quick Continue's **Simple** watchdog remains independently enabled, timed, and attempt-bounded.

## Controls

- **Continue** immediately sends the configured Continue template.
- **Project** opens the non-modal project picker and **Project > Edit** opens the live JSON config editor.
- **Simple**, between Continue and Project, starts or stops the fallback watchdog. Gray is off; green is on. Its own countdown appears immediately, independently of smart monitoring or response state.
- Click the **time at the right side of the toolbar** to toggle timestamps for ordinary manually typed ChatGPT messages.

Continue and Project use the configured `{time}` placeholder. Project also replaces `{project}`. Manual timestamping uses both `{time}` and `{message}`. JSON `\n` escapes remain real line breaks.

Manual timestamp mode is remembered independently for each ChatGPT conversation. Simple can start before a new chat is saved and binds to that tab's first conversation ID without restarting its timer. After binding, changing chats or closing the tab disables the run.

## Simple fallback watchdog

Simple remains the deterministic fallback path. Its timer does not depend on assistant completion state, notifier monitoring state, smart-watchdog eligibility, or any ChatGPT API. If no respected terminal GitHub status appears, the fixed timer sequence proceeds exactly as configured.

Simple can optionally react to an exact terminal `[GITHUB_STATUS: ...]` footer from the current assistant turn. `watchdog.stopOnStatus` remains the shared table that classifies each status as a **stop class** (`true`) or **continue class** (`false`). The two Simple settings decide whether each class is respected:

- `simpleWatchdog.respectStopStatusCodes: true` — a stop-class footer turns Simple off immediately. `false` ignores that class and leaves the Simple timer running.
- `simpleWatchdog.respectContinueStatusCodes: true` — a continue-class footer sends one immediate Continue through the Simple send path, consumes one Simple attempt, and starts the next Simple countdown. `false` ignores that class and leaves the timer running.

Ignoring a class never converts it into the opposite action. A status-triggered Continue is deduplicated by the exact conversation/assistant-turn/status footer and shares the same finite attempt cap as timer-triggered sends. If that send consumes the final attempt, Simple remains green/on in `Auto-continues exhausted` state until explicitly turned off.

Turning **Simple** on starts a fresh timer and resets its attempt count. Every timer-driven attempt follows the same fixed sequence:

1. Wait `simpleWatchdog.timerMinutes`.
2. Click ChatGPT's native **Stop** button if one is present. A missing Stop button does not cancel the sequence.
3. Wait `simpleWatchdog.stopToRefreshSeconds`.
4. Reload the same ChatGPT tab.
5. Wait `simpleWatchdog.refreshToContinueSeconds`.
6. Replace the composer contents with the configured `continueText` and submit it through Quick Continue's normal send transaction.
7. Count one attempt. If attempts remain, start a new `timerMinutes` countdown and repeat.

The phase, deadline, attempt count, conversation identity, settings snapshot, status classification, and last handled status fingerprint are persisted in Chrome local extension storage. Chrome's extension alarm system owns the phase deadlines, so a page refresh or ordinary MV3 service-worker sleep does not erase the loop. A footer already present when Simple is enabled is baselined rather than treated as a new status event.

At the send phase Simple can replace an existing composer draft under its "send when due" contract. It remains scoped to the same tab and, once created, the same conversation.

If smart monitoring is also enabled, both systems remain separately timed. The normal watchdog always follows its `stopOnStatus` classification; the two `respect*StatusCodes` switches now belong only to Simple.

## Editable JSON

The bundled `config.json` is the readable default. **Project > Edit** edits the validated live copy stored in Chrome local extension storage and applies changes immediately.

```json
{
  "continueText": "[{time}] Continue until you finish or need something from me.",
  "projectText": "[{time}] Continue {project} from canonical GitHub state until you finish or need me.",
  "manualTimestampText": "[{time}] {message}",
  "watchdog": {
    "timerMinutes": 30,
    "attempts": 3,
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

`watchdog` owns the smart-watchdog timing/attempt settings and the shared status classification table. `simpleWatchdog` owns the independent Simple fallback timing plus whether Simple respects either status class.

Simple fields:

- `timerMinutes` — countdown before each Stop/refresh/send sequence. Valid range: 0.1–1440 minutes.
- `attempts` — maximum number of Continue sends for one Simple run. Valid range: 0–20; `0` prevents Simple from starting.
- `stopToRefreshSeconds` — delay after the Stop click before reloading. Valid range: 0–3600 seconds.
- `refreshToContinueSeconds` — delay after reload before sending Continue. Valid range: 0–3600 seconds.
- `respectStopStatusCodes` — whether Simple acts on statuses classified `true` in `watchdog.stopOnStatus`.
- `respectContinueStatusCodes` — whether Simple acts on statuses classified `false` in `watchdog.stopOnStatus`.

Existing saved configurations from 1.2.33/1.2.34 that still contain the two `respect*StatusCodes` values under `watchdog` are migrated automatically: their values are carried into `simpleWatchdog`, and the normalized saved/serialized form removes them from `watchdog`.

Template placeholders:

- `{time}` — local send timestamp, for example `Sep 30, 2:46 PM`.
- `{project}` — selected or typed project name; required in `projectText`.
- `{message}` — manually typed message; required in `manualTimestampText`.

If a Continue or Project template omits `{time}`, config normalization inserts `[{time}] ` at the front. Existing saved configurations that predate newer fields receive their defaults during normalization.

To put the timestamp and manual message on separate lines:

```json
"manualTimestampText": "[{time}]\n{message}"
```

The installed default file is `%LOCALAPPDATA%\ChatGPTQuickContinue\Extension\config.json`. Normal ongoing changes should use **Project > Edit** so they apply immediately.

## Managed updates

- The ChatGPT Response Notifier Windows helper checks the published Quick Continue feed and accepts only the expected GitHub release route plus published SHA-256 digest.
- Updates are written in place to the stable unpacked-extension directory with `manifest.json` copied last; the installed `config.json` is preserved.
- Quick Continue's service worker polls only the loopback helper (`127.0.0.1`) every 15 minutes and at browser/extension startup. It does not download code itself.
- After a newer version is installed, Quick Continue reloads itself and reinjects the current runtime into already-open ChatGPT tabs. A manual ChatGPT refresh is not required for managed extension updates.

## Other safety behavior

Normal **Continue** and **Project** actions do not overwrite an existing draft. Manual timestamping only runs on trusted user Send/Enter actions, ignores Shift+Enter and IME composition, and does not stamp an already timestamped message again. Quick Continue's own programmatic sends are excluded from the manual timestamp hook.

Simple mode is the explicit exception to the normal draft-preservation rule at its scheduled or status-triggered send phase. This exception is limited to Simple's own enabled run.

Config and per-chat state stay in Chrome local extension storage. Quick Continue does not poll ChatGPT APIs or send ChatGPT network requests outside the same page submission/reload actions a user requested.

## Install

Run the included installer from PowerShell with a temporary execution-policy bypass:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1
```

It copies the extension and bundled config to `%LOCALAPPDATA%\ChatGPTQuickContinue\Extension` and prints the one-time **Load unpacked** steps for `chrome://extensions`.

Once the managed extension is loaded, later releases require no PowerShell command, manual extension reload, or ChatGPT page refresh. The existing notifier helper installs the update and Quick Continue hot-reloads/reinjects itself.