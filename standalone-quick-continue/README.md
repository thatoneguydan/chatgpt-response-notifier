# ChatGPT Quick Continue

A small, separately installable Chrome extension for timestamped continuation prompts on `chatgpt.com`.

Quick Continue remains separate from ChatGPT Response Notifier for its actual send controls and per-chat timestamp/config state. When the notifier helper is installed, Quick Continue also uses that already-running local helper as a narrowly scoped update transport: the helper downloads a pinned, hashed Quick Continue release into `%LOCALAPPDATA%\ChatGPTQuickContinue\Extension`, then Quick Continue reloads itself and reinjects the current runtime into already-open ChatGPT tabs. If the helper is unavailable, Quick Continue keeps working normally; only managed updates pause.

When ChatGPT Response Notifier is also enabled, the notifier may add its own small monitoring-state light immediately before **Continue** plus a compact active-chat auto-continue countdown above the controls. Quick Continue does not read or write notifier automation state itself; disabling the notifier removes that integration without changing Quick Continue's send controls.

## Controls

- **Continue** immediately sends the configured Continue template.
- **Project** opens a compact non-modal project picker.
- Click the **time at the right side of the toolbar** to toggle timestamps for ordinary manually typed ChatGPT messages. When enabled, the time gets an outline. The configured `manualTimestampText` is rendered at the moment a manual Send click or Enter-to-send action occurs, so the draft stays untouched while you type.
- Manual timestamp mode is remembered independently for each ChatGPT conversation. A chat with timestamps on stays on when you return to it, while another chat can stay off. A conversation with no saved preference starts off. A new unsaved chat keeps a provisional choice only until ChatGPT assigns that new conversation its ID, then that choice is stored for the new chat.
- The on/off state remains per conversation and is not part of the editable prompt JSON; `manualTimestampText` controls the final manual-message layout when that state is on.
- **Continue** and **Project** sends are excluded from the manual-message timestamp toggle because Quick Continue already renders their configured `{time}` placeholder itself.
- Clicking a saved project immediately sends the configured Project template with `{project}` replaced by that title.
- `{time}` is replaced by the local timestamp at send time in `continueText`, `projectText`, and `manualTimestampText`, so the JSON controls the surrounding timestamp wording.
- `{message}` is replaced by the manually typed message in `manualTimestampText`; the field always contains both `{time}` and `{message}` after normalization.
- JSON `\n` escapes are preserved as real line breaks when Continue, Project, or a timestamped manual message is inserted into the ChatGPT composer.
- **Other project…** remains available for one-off names.
- **Edit** opens the current raw JSON config directly inside the Project menu. **Save** validates and applies it immediately without reloading the extension or refreshing ChatGPT.
- The Project menu normally opens upward. If that would cross the viewport top, it flips below the toolbar; if neither side fully fits, it uses the side with more room.
- Toolbar layout syncs keep the existing toolbar visible; brief ChatGPT composer rerenders are given a 600 ms grace period before the toolbar is hidden, preventing one-frame flicker.
- Runtime 1.2.16 removes the inline pencil controls, keeps **Project > Edit** as the JSON editor entry point, adds `{message}` for manual-message templates, and preserves template newlines in the composer.

The bundled `config.json` is the readable/default configuration:

```json
{
  "continueText": "[{time}] Continue until you finish or need something from me.",
  "projectText": "[{time}] Continue {project} from canonical GitHub state until you finish or need me.",
  "manualTimestampText": "[{time}] {message}",
  "projects": [
    "campaign desk",
    "notifier extension"
  ]
}
```

Template placeholders:

- `{time}` — the local send timestamp, for example `Sep 23, 11:08 AM`.
- `{project}` — the selected or typed project name; required in `projectText`.
- `{message}` — the manually typed ChatGPT message; required in `manualTimestampText`.

You can move `{time}` anywhere in `continueText`, `projectText`, or `manualTimestampText`, and move `{message}` anywhere in `manualTimestampText`. `projectText` must contain `{project}`. If a saved Continue or Project template has no `{time}`, the config controller inserts `[{time}] ` at the front so old behavior is preserved. Existing saved manual timestamp templates that predate `{message}` are migrated by appending ` {message}` while retaining the rest of the saved config. Existing configs that predate `manualTimestampText` receive the default `[{time}] {message}` value when loaded. The **Project > Edit** UI stores the validated live copy in Chrome local extension storage. Changes propagate to other open ChatGPT tabs through `chrome.storage.onChanged`.

To put the timestamp and message on separate lines, for example:

```json
"manualTimestampText": "[{time}]\n{message}"
```

The installed default file is:

```text
%LOCALAPPDATA%\ChatGPTQuickContinue\Extension\config.json
```

Editing that physical file changes the defaults used by a fresh/reset configuration; normal ongoing edits should use **Project > Edit** so they apply immediately.

## Managed updates

- The existing ChatGPT Response Notifier Windows helper checks the published Quick Continue update feed and only accepts release ZIPs from this repository's GitHub release route with the published SHA-256 digest.
- Updates are written in place to the stable unpacked-extension directory with `manifest.json` copied last. The installed `config.json` is preserved.
- Quick Continue's small service worker polls only the loopback helper (`127.0.0.1`) every 15 minutes and on browser/extension startup. It does not download code itself.
- When the helper reports a different installed version, Quick Continue calls `chrome.runtime.reload()` on itself. The freshly loaded worker then reinjects the current extension scripts into already-open `chatgpt.com` tabs, so page refreshes are not required.
- If the notifier helper is absent or stopped, the update check quietly does nothing. Continue/Project/timestamp functionality remains local and usable.

## Safety behavior

- Existing ChatGPT drafts are never overwritten by Continue or Project.
- Manual timestamp mode only renders the configured template when the user actually invokes ChatGPT's Send control or an Enter-to-send action; it does not rewrite the draft while typing.
- Shift+Enter and IME composition are ignored so normal multiline entry is not timestamped prematurely.
- Quick Continue's own programmatic Continue/Project Send clicks are ignored by the manual timestamp hook because they are not trusted user events.
- A manually entered message that already begins with a bracketed time is not stamped again.
- Per-chat timestamp state is kept only in Chrome local extension storage; switching chats performs no ChatGPT network request.
- The Project menu and its **Edit** control remain available for config editing even when sending is unavailable.
- Actual send controls remain available while ChatGPT is generating, so Continue/Project can be queued as follow-up messages; they are disabled when the composer already has text.
- Auto-send uses ChatGPT's real enabled Send button.
- Each operator action causes at most one Send-button click. There are no automatic retries.
- If the Send button does not become ready, the generated prompt is left in the composer for inspection/manual sending.
- Config storage is local to the extension; managed update traffic is limited to the local notifier helper.

## Install

Run the included installer from PowerShell with a temporary execution-policy bypass:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1
```

It copies the extension and bundled config to the stable path `%LOCALAPPDATA%\ChatGPTQuickContinue\Extension` and prints the one-time **Load unpacked** steps for `chrome://extensions`.

Once 1.2.9 or newer has been loaded once, later managed releases require no PowerShell command, no manual extension reload, and no ChatGPT page refresh. The existing notifier helper installs the files and Quick Continue reloads/reinjects itself.

Because this is a separate extension, it can stay enabled while ChatGPT Response Notifier is disabled or under repair. Its controls continue to work in that state; only managed update delivery waits for the notifier helper to return. If the notifier is enabled too, Quick Continue suppresses the notifier's older quick-prompt toolbar so only the standalone controls are shown.
