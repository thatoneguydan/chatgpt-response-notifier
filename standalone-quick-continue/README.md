# ChatGPT Quick Continue

A tiny, separately installable Chrome extension for timestamped continuation prompts on `chatgpt.com`.

It is intentionally independent from ChatGPT Response Notifier. It has no service worker, notification system, response monitoring, recovery loop, helper connection, `webRequest`, or background network behavior.

## Controls

- **Continue** immediately sends:
  - `[Sep 18, 9:20 AM] Continue until you finish or need something from me.`
- **Project** opens a small non-modal project-name field. It does not focus-trap or block the page. Enter or **Send** immediately sends:
  - `[Sep 18, 9:20 AM] Continue campaign desk from canonical GitHub state until you finish or need me.`

The project name is inserted as plain text exactly as typed after whitespace normalization.

## Safety behavior

- Existing ChatGPT drafts are never overwritten.
- Controls are disabled while ChatGPT is generating.
- Auto-send uses ChatGPT's real enabled Send button.
- Each operator click causes at most one Send-button click. There are no automatic retries.
- If the Send button does not become ready, the generated prompt is left in the composer for inspection/manual sending.

## Install

Run the included installer from PowerShell with a temporary execution-policy bypass:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1
```

It copies the extension to the stable path `%LOCALAPPDATA%\ChatGPTQuickContinue\Extension` and prints the one-time **Load unpacked** steps for `chrome://extensions`. It does not open Chrome, change Chrome policy, write the registry, or install any background service.

Because this is a separate extension, it can stay enabled while ChatGPT Response Notifier is disabled or under repair. If the notifier is later enabled too, Quick Continue suppresses the notifier's older quick-prompt toolbar so only the standalone controls are shown.
