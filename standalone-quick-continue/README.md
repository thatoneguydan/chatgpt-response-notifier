# ChatGPT Quick Continue

A tiny, separately installable Chrome extension for timestamped continuation prompts on `chatgpt.com`.

It is intentionally independent from ChatGPT Response Notifier. It has no service worker, notification system, response monitoring, recovery loop, helper connection, `webRequest`, or background network behavior. The only added Chrome permission is `storage`, used for the live local JSON config.

## Controls

- **Continue** immediately sends the configured timestamped Continue text.
- **Project** opens a compact non-modal project picker.
- Clicking a saved project immediately sends the configured Project template with `{project}` replaced by that title.
- **Other project…** remains available for one-off names.
- **Edit** opens the current raw JSON config directly inside the Project menu. **Save** validates and applies it immediately without reloading the extension or refreshing ChatGPT.

The bundled `config.json` is the readable/default configuration:

```json
{
  "continueText": "Continue until you finish or need something from me.",
  "projectText": "Continue {project} from canonical GitHub state until you finish or need me.",
  "projects": [
    "campaign desk",
    "notifier extension"
  ]
}
```

`projectText` must contain `{project}`. The Edit UI stores the validated live copy in Chrome local extension storage. Changes propagate to other open ChatGPT tabs through `chrome.storage.onChanged`.

The installed default file is:

```text
%LOCALAPPDATA%\ChatGPTQuickContinue\Extension\config.json
```

Editing that physical file changes the defaults used by a fresh/reset configuration; normal ongoing edits should use **Project > Edit** so they apply immediately.

## Safety behavior

- Existing ChatGPT drafts are never overwritten.
- The Project menu remains available for config editing even when sending is unavailable.
- Actual send controls are disabled while ChatGPT is generating or when the composer already has text.
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

Because this is a separate extension, it can stay enabled while ChatGPT Response Notifier is disabled or under repair. If the notifier is later enabled too, Quick Continue suppresses the notifier's older quick-prompt toolbar so only the standalone controls are shown.
