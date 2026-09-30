# ChatGPT Quick Continue

A small, separately installable Chrome extension for timestamped continuation prompts on `chatgpt.com`.

Quick Continue remains separate from ChatGPT Response Notifier for its send controls, editable config, per-chat timestamp state, and the Simple fallback watchdog. When the notifier helper is installed, Quick Continue also uses that already-running local helper as a narrowly scoped managed-update transport. If the helper is unavailable, the installed Quick Continue runtime keeps working normally; only managed updates pause.

When ChatGPT Response Notifier is enabled, it can add its own smart monitoring-state indicator and countdown around the Quick Continue controls. Quick Continue's **Simple** watchdog is deliberately independent of that smart monitor.

## Controls

- **Continue** immediately sends the configured Continue template.
- **Project** opens the non-modal project picker and **Project > Edit** opens the live JSON config editor.
- **Simple** toggles the fallback watchdog for the current saved ChatGPT conversation. Gray is off; green is on.
- Click the **time at the right side of the toolbar** to toggle timestamps for ordinary manually typed ChatGPT messages.

Continue and Project use the configured `{time}` placeholder. Project also replaces `{project}`. Manual timestamping uses both `{time}` and `{message}`. JSON `\n` escapes remain real line breaks.

Manual timestamp mode is remembered independently for each ChatGPT conversation. The Simple watchdog also stays bound to the exact conversation/tab where it was enabled; changing chats or closing that tab disables that Simple run rather than allowing it to act in another conversation.

## Simple fallback watchdog

Simple mode is intentionally dumb. It does **not** inspect GitHub status codes, assistant completion state, notifier monitoring state, smart watchdog eligibility, or whether a response appears finished. Its purpose is to remain useful when the smarter notifier/watchdog path is broken.

Turning **Simple** on starts a fresh timer and resets its attempt count. Every attempt follows the same fixed sequence:

1. Wait `simpleWatchdog.timerMinutes`.
2. Click ChatGPT's native **Stop** button if one is present. A missing Stop button does not cancel the sequence.
3. Wait `simpleWatchdog.stopToRefreshSeconds`.
4. Reload the same ChatGPT tab.
5. Wait `simpleWatchdog.refreshToContinueSeconds`.
6. Replace the composer contents with the configured `continueText` and submit it through Quick Continue's normal send transaction.
7. Count one attempt. If attempts remain, start a new `timerMinutes` countdown and repeat.

The phase, deadline, attempt count, conversation identity, and settings snapshot are persisted in Chrome local extension storage. Chrome's extension alarm system owns the phase deadlines, so a page refresh or ordinary MV3 service-worker sleep does not erase the loop.

This mode is intentionally less cautious than normal Continue/Project actions: at the send phase it can replace an existing composer draft because the fallback contract is "send when due" rather than "decide whether sending is safe." It still remains mechanically scoped to the same saved conversation so it cannot continue a different chat after navigation.

If smart monitoring is also enabled, both systems remain independent and can act on their own schedules. Use Simple by itself when you want the deterministic fallback behavior and do not want the smart watchdog competing with it.

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
    "refreshToContinueSeconds": 30
  },
  "projects": [
    "campaign desk",
    "notifier extension"
  ]
}
```

`watchdog` belongs to the smart notifier integration. `simpleWatchdog` belongs only to the independent Simple fallback.

Simple fields:

- `timerMinutes` — countdown before each Stop/refresh/send sequence. Valid range: 0.1–1440 minutes.
- `attempts` — maximum number of Continue sends for one Simple run. Valid range: 0–20; `0` prevents Simple from starting.
- `stopToRefreshSeconds` — delay after the Stop click before reloading. Valid range: 0–3600 seconds.
- `refreshToContinueSeconds` — delay after reload before sending Continue. Valid range: 0–3600 seconds.

The current values are snapshotted when **Simple** is enabled. To restart the timer/attempt count with newly edited values, toggle Simple off and back on.

Template placeholders:

- `{time}` — local send timestamp, for example `Sep 30, 2:46 PM`.
- `{project}` — selected or typed project name; required in `projectText`.
- `{message}` — manually typed message; required in `manualTimestampText`.

If a Continue or Project template omits `{time}`, config normalization inserts `[{time}] ` at the front. Existing saved configurations that predate newer fields receive their defaults during normalization, so adding Simple does not require manually rebuilding an older saved config.

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

Simple mode is the explicit exception to the normal draft-preservation rule at its scheduled send phase, as described above. This exception is limited to Simple's own enabled run.

Config and per-chat state stay in Chrome local extension storage. Quick Continue does not poll ChatGPT APIs or send ChatGPT network requests outside the same page submission/reload actions a user requested.

## Install

Run the included installer from PowerShell with a temporary execution-policy bypass:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1
```

It copies the extension and bundled config to `%LOCALAPPDATA%\ChatGPTQuickContinue\Extension` and prints the one-time **Load unpacked** steps for `chrome://extensions`.

Once the managed extension is loaded, later releases require no PowerShell command, manual extension reload, or ChatGPT page refresh. The existing notifier helper installs the update and Quick Continue hot-reloads/reinjects itself.
