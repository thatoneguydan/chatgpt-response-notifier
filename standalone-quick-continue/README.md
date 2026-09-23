# ChatGPT Quick Continue

A tiny, separately installable Chrome extension for timestamped continuation prompts on `chatgpt.com`.

It is intentionally independent from ChatGPT Response Notifier. It has no service worker, notification system, response monitoring, recovery loop, helper connection, `webRequest`, or background network behavior. The only added Chrome permission is `storage`, used for the live local JSON config and the per-conversation manual timestamp preference.

When ChatGPT Response Notifier is also enabled, the notifier may add its own small monitoring-state light immediately before **Continue** plus a compact active-chat auto-continue countdown above the controls. Quick Continue does not read or write notifier state itself; disabling the notifier removes that integration without changing Quick Continue's send controls.

## Controls

- **Continue** immediately sends the configured Continue template.
- **Project** opens a compact non-modal project picker.
- Click the **time at the right side of the toolbar** to toggle timestamps for ordinary manually typed ChatGPT messages. When enabled, the time gets an outline. A timestamp is prepended at the moment a manual Send click or Enter-to-send action occurs, so the draft stays untouched while you type.
- Manual timestamp mode is remembered independently for each ChatGPT conversation. A chat with timestamps on stays on when you return to it, while another chat can stay off. A conversation with no saved preference starts off. A new unsaved chat keeps a provisional choice only until ChatGPT assigns that new conversation its ID, then that choice is stored for the new chat.
- **Continue** and **Project** sends are excluded from the manual-message timestamp toggle because Quick Continue already renders their configured `{time}` placeholder itself.
- Hovering **Continue** or **Project** for about 700 ms reveals a small **Edit** button beside that control. Clicking it opens the same in-page JSON editor directly, so normal prompt editing does not require locating `config.json` on disk.
- Clicking a saved project immediately sends the configured Project template with `{project}` replaced by that title.
- `{time}` is replaced by the local timestamp at send time in either template, so the JSON controls exactly where the timestamp appears.
- **Other project…** remains available for one-off names.
- **Edit** opens the current raw JSON config directly inside the Project menu. **Save** validates and applies it immediately without reloading the extension or refreshing ChatGPT.
- The Project menu normally opens upward. If that would cross the viewport top, it flips below the toolbar; if neither side fully fits, it uses the side with more room.
- Toolbar layout syncs keep the existing toolbar visible; brief ChatGPT composer rerenders are given a 200 ms grace period before the toolbar is hidden, preventing one-frame flicker.
- Runtime 1.2.8 adds per-conversation persistence for the manual-message timestamp toggle while preserving 1.2.7 timestamping, 1.2.6 delayed hover editing, template-controlled timestamp placement, and existing hot-replacement/reattachment behavior. Existing saved templates that predate `{time}` are automatically normalized to the equivalent `[{time}] ...` form, preserving their current output while making the placeholder visible in the editor.

The bundled `config.json` is the readable/default configuration:

```json
{
  "continueText": "[{time}] Continue until you finish or need something from me.",
  "projectText": "[{time}] Continue {project} from canonical GitHub state until you finish or need me.",
  "projects": [
    "campaign desk",
    "notifier extension"
  ]
}
```

Template placeholders:

- `{time}` — the local send timestamp, for example `Sep 23, 11:08 AM`.
- `{project}` — the selected or typed project name; required in `projectText`.

You can move `{time}` anywhere in either template. `projectText` must contain `{project}`. If a legacy saved template has no `{time}`, the config controller inserts `[{time}] ` at the front so old behavior is preserved. The Edit UI stores the validated live copy in Chrome local extension storage. Changes propagate to other open ChatGPT tabs through `chrome.storage.onChanged`.

The installed default file is:

```text
%LOCALAPPDATA%\ChatGPTQuickContinue\Extension\config.json
```

Editing that physical file changes the defaults used by a fresh/reset configuration; normal ongoing edits should use the hover **Edit** control or **Project > Edit** so they apply immediately.

## Safety behavior

- Existing ChatGPT drafts are never overwritten by Continue or Project.
- Manual timestamp mode only prepends text when the user actually invokes ChatGPT's Send control or an Enter-to-send action; it does not rewrite the draft while typing.
- Shift+Enter and IME composition are ignored so normal multiline entry is not timestamped prematurely.
- Quick Continue's own programmatic Continue/Project Send clicks are ignored by the manual timestamp hook because they are not trusted user events.
- A manually entered message that already begins with a bracketed time is not stamped again.
- Per-chat timestamp state is kept only in Chrome local extension storage; switching chats performs no ChatGPT network request.
- The Project menu and hover Edit affordance remain available for config editing even when sending is unavailable.
- Actual send controls remain available while ChatGPT is generating, so Continue/Project can be queued as follow-up messages; they are disabled when the composer already has text.
- Auto-send uses ChatGPT's real enabled Send button.
- Each operator action causes at most one Send-button click. There are no automatic retries.
- If the Send button does not become ready, the generated prompt is left in the composer for inspection/manual sending.
- Config storage is local to the extension; there is no external config sync or network request.

## Install

Run the included installer from PowerShell with a temporary execution-policy bypass:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1
```

It copies the extension and bundled config to the stable path `%LOCALAPPDATA%\ChatGPTQuickContinue\Extension` and prints the one-time **Load unpacked** steps for `chrome://extensions`. It does not open Chrome, change Chrome policy, write the registry, or install any background service.

For an existing installation, use the version-specific updater included with the release from Dan's normal interactive Windows account. The repository's self-hosted runner executes as `NetworkService` and is intentionally not permitted to write this user-profile extension folder. The updater replaces the changed runtime files while preserving the installed `config.json`; the live JSON saved through the in-page editor and per-conversation timestamp preferences remain in Chrome local extension storage.

After updating to 1.2.8, reload the unpacked extension in `chrome://extensions` and reload each already-open ChatGPT host page before those pages run the new per-chat timestamp behavior. A newly opened ChatGPT page after the extension reload already gets the current runtime.

Because this is a separate extension, it can stay enabled while ChatGPT Response Notifier is disabled or under repair. If the notifier is later enabled too, Quick Continue suppresses the notifier's older quick-prompt toolbar so only the standalone controls are shown.
