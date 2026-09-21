# ChatGPT Quick Continue

A tiny, separately installable Chrome extension for timestamped continuation prompts on `chatgpt.com`.

It is intentionally independent from ChatGPT Response Notifier. It has no service worker, notification system, response monitoring, recovery loop, helper connection, `webRequest`, or background network behavior. The only added Chrome permission is `storage`, used for the live local JSON config.

When ChatGPT Response Notifier is also enabled, the notifier may add its own small monitoring-state light immediately before **Continue** plus a compact active-chat auto-continue countdown above the controls. Quick Continue does not read or write notifier state itself; disabling the notifier removes that integration without changing Quick Continue's send controls.

## Controls

- **Continue** immediately sends the configured timestamped Continue text.
- **Project** opens a compact non-modal project picker.
- Clicking a saved project immediately sends the configured Project template with `{project}` replaced by that title.
- **Other project…** remains available for one-off names.
- **Edit** opens the current raw JSON config directly inside the Project menu. **Save** validates and applies it immediately without reloading the extension or refreshing ChatGPT.
- The Project menu normally opens upward. If that would cross the viewport top, it flips below the toolbar; if neither side fully fits, it uses the side with more room.
- Toolbar layout syncs keep the existing toolbar visible; brief ChatGPT composer rerenders are given a 200 ms grace period before the toolbar is hidden, preventing one-frame flicker.
- Runtime 1.2.4 can replace an older injected generation cleanly, reattaches the toolbar if ChatGPT detaches it, and ignores notifier-only countdown mutations. Clock text is changed only when the displayed minute actually changes, preventing the toolbar's own MutationObserver from becoming a self-sustaining layout loop.

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

For an existing 1.2.3 install, run the pinned 1.2.4 updater **from Dan's normal interactive Windows account**. The repository's self-hosted runner executes as `NetworkService` and is intentionally not permitted to write this user-profile extension folder. The updater replaces the changed runtime files while preserving `config.json`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Update-Installed-1.2.4.ps1
```

The updater verifies each copied file by SHA-256. Because 1.2.4 changes manifest-declared content scripts, Chrome requires **both** reloading the unpacked extension and reloading each already-open ChatGPT host page before those pages run the new code. A newly opened ChatGPT page after the extension reload already gets 1.2.4.

Because this is a separate extension, it can stay enabled while ChatGPT Response Notifier is disabled or under repair. If the notifier is later enabled too, Quick Continue suppresses the notifier's older quick-prompt toolbar so only the standalone controls are shown.
