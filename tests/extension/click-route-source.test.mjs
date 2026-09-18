import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import './current-request-error.behavior.test.mjs';
import './v0914-safety-regression.test.mjs';
import './version-sync.test.mjs';

const readText = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

test('retired generic native foreground route stays absent while explicit desktop presentation is narrow', () => {
  const worker = readText('extension/service-worker.js');
  const background = readText('extension/background.js');
  const safety = readText('extension/v0914-safety-background.js');
  const app = readText('src/ChatGPTResponseNotifier.Host/NativeHostApplication.cs');
  const switcher = readText('src/ChatGPTResponseNotifier.Host/WindowsVirtualDesktopSwitcher.cs');

  assert.doesNotMatch(worker, /type\s*:\s*['"]window\.foreground['"]/);
  assert.doesNotMatch(worker, /function\s+requestNativeChromeForeground\s*\(/);
  assert.match(worker, /type:\s*'window\.presentExisting'/);
  assert.match(worker, /__chatgptNotifierPresentExistingWindow/);
  assert.match(worker, /queueIfDisconnected:\s*false/);
  assert.match(worker, /chrome\.tabs\.update\(/);
  assert.match(worker, /chrome\.windows\.update\(/);

  assert.match(background, /Retired native foreground path is present in production runtime/);
  assert.match(safety, /typeof globalThis\.requestNativeChromeForeground !== ['"]function['"]/);

  assert.match(app, /case "window\.presentExisting"/);
  assert.match(app, /WindowsVirtualDesktopSwitcher\.PresentExistingChromeWindow/);
  assert.match(app, /case "window\.foreground"/);
  assert.match(app, /native-foreground-retired/);

  assert.match(switcher, /Windows11_24H2Build = 26100/);
  assert.match(switcher, /Minimum26100Ubr = 2605/);
  assert.match(switcher, /Chrome_WidgetWin_1/);
  assert.match(switcher, /GetWindowDesktopId/);
  assert.match(switcher, /SwitchDesktopWithAnimation/);
  assert.match(switcher, /chrome-window-ambiguous/);
  assert.match(switcher, /SetForegroundWindow\(resolution\.Hwnd\)/);
  assert.doesNotMatch(switcher, /\.MoveWindowToDesktop\(/);
  assert.doesNotMatch(switcher, /SendKeys|keybd_event|SendInput/);
});
test('toast click routing switches desktops without moving or duplicating an existing chat', () => {
  const worker = readText('extension/service-worker.js');
  const click = readText('extension/cross-desktop-click-fallback-background.js');
  const manager = readText('src/ChatGPTResponseNotifier.Host/ToastManager.cs');
  const window = readText('src/ChatGPTResponseNotifier.Host/ToastWindow.cs');
  const app = readText('src/ChatGPTResponseNotifier.Host/NativeHostApplication.cs');
  const record = readText('src/ChatGPTResponseNotifier.Core/NotificationRecord.cs');

  assert.match(worker, /targetTabId: Number\.isInteger\(record\.ownerTabId\)/);
  assert.match(worker, /resolveClickTarget\(conversationId, preferredTabId/);
  assert.match(worker, /ambiguous-conversation-target/);
  assert.match(worker, /activeToastClicks/);
  assert.match(worker, /click-duplicate-suppressed/);
  assert.match(worker, /type: 'toast\.clickResult'/);
  assert.doesNotMatch(worker, /message\.type === 'toast\.moveHere'/);
  assert.match(worker, /requestNativeExistingWindowPresentation/);
  assert.match(worker, /windowTitle/);
  assert.match(worker, /windowLeft/);
  assert.match(worker, /windowTop/);
  assert.match(worker, /windowWidth/);
  assert.match(worker, /windowHeight/);

  assert.match(click, /PROBE_TIMEOUT_MS = 300/);
  assert.match(click, /CLICK_DEADLINE_MS = 8000/);
  assert.match(click, /Promise\.resolve\(promise\)/);
  assert.match(click, /state: 'other-desktop'/);
  assert.match(click, /presentExistingWindow\(primary\.targetTabId, primary\.targetWindowId/);
  assert.match(click, /chrome\.tabs\.update\(primary\.targetTabId, \{ active: true \}\)/);
  assert.match(click, /chrome\.windows\.update\(primary\.targetWindowId, \{ focused: true \}\)/);
  assert.doesNotMatch(click, /chrome\.windows\.create/);
  assert.doesNotMatch(click, /moveTabHere/);

  const clicked = manager.slice(manager.indexOf('window.ToastClicked'), manager.indexOf('window.ToastDismissed'));
  assert.doesNotMatch(clicked, /RemoveWindow/);
  assert.match(clicked, /targetTabId = window\.TargetTabId/);
  assert.match(manager, /ReportClickResult/);
  assert.match(manager, /window\.SetClickState\("pending", window\.TargetTabId\)/);
  assert.doesNotMatch(manager, /ToastMoveHereRequested/);
  assert.doesNotMatch(manager, /toast\.moveHere/);
  assert.doesNotMatch(window, /Move this tab here/);
  assert.doesNotMatch(window, /ToastMoveHereRequested/);
  assert.match(window, /desktop-switch-failed/);
  assert.match(record, /TargetTabId/);

  assert.match(app, /case "toast\.clickResult"/);
  assert.match(app, /case "window\.presentExisting"/);
  assert.doesNotMatch(app, /click-shell-fallback/);
  assert.doesNotMatch(app, /Process\.Start\(new ProcessStartInfo\(uri\.AbsoluteUri/);
});
test('status verification preserves prompt revision identity across monitor fallback', () => {
  const statusScript = readText('extension/status-script.js');
  const worker = readText('extension/service-worker.js');

  assert.match(statusScript, /const userText = turnText\(nodes\[userIndex\], ['"]user['"]\);/);
  assert.match(statusScript, /promptRevision:\s*revisionOf\(userText\)/);
  assert.match(statusScript, /promptRevision:\s*snapshot\?\.promptRevision \|\| ['"]['"]/);
  assert.match(worker, /promptRevision:\s*status\.promptRevision/);
});

test('all coded continuation routes use the shared continuation predicate', () => {
  const worker = readText('extension/service-worker.js');
  const observer = readText('extension/normal-continuation-budget-hook.js');

  assert.match(worker, /ChatGPTNotifierContinuationPolicy\?\.isAutoContinueStatusCode\?\.\(statusCode\) === true/);
  assert.match(observer, /ChatGPTNotifierContinuationPolicy\?\.isAutoContinueStatusCode\?\.\(String\(status\.statusCode \|\| ['"]['"]\)\) === true/);
  assert.doesNotMatch(worker, /statusCode\s*!==\s*['"]INCOMPLETE_LIMIT['"]/);
  assert.doesNotMatch(observer, /String\(status\.statusCode \|\| ['"]['"]\)\s*!==\s*['"]INCOMPLETE_LIMIT['"]/);
});
