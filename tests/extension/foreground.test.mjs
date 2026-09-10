import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../..');
const [serviceWorker, nativeHostApplication, nativeMessage, chromeForeground, manifest] = await Promise.all([
  readFile(path.join(projectRoot, 'extension', 'service-worker.js'), 'utf8'),
  readFile(path.join(projectRoot, 'src', 'ChatGPTResponseNotifier.Host', 'NativeHostApplication.cs'), 'utf8'),
  readFile(path.join(projectRoot, 'src', 'ChatGPTResponseNotifier.Core', 'NativeMessage.cs'), 'utf8'),
  readFile(path.join(projectRoot, 'src', 'ChatGPTResponseNotifier.Host', 'ChromeWindowForeground.cs'), 'utf8'),
  readFile(path.join(projectRoot, 'extension', 'manifest.json'), 'utf8')
]);

test('0.2.14 routes a toast click through the native Windows foreground handoff', () => {
  assert.match(manifest, /"version": "0\.2\.14"/);
  assert.match(serviceWorker, /type: 'window\.foreground'/);
  assert.match(serviceWorker, /\['window\.foregroundResult'\]/);
  assert.match(serviceWorker, /windowTitle: String\(tabInfo\?\.title \|\| ''\)/);
  assert.match(serviceWorker, /windowLeft: finiteWindowCoordinate\(windowInfo\?\.left\)/);
  assert.match(serviceWorker, /windowTop: finiteWindowCoordinate\(windowInfo\?\.top\)/);
  assert.match(serviceWorker, /windowWidth: finiteWindowCoordinate\(windowInfo\?\.width\)/);
  assert.match(serviceWorker, /windowHeight: finiteWindowCoordinate\(windowInfo\?\.height\)/);
  assert.match(serviceWorker, /chrome\.tabs\.update\(existing\.id, \{ active: true \}\)/);
  assert.match(serviceWorker, /requestNativeChromeForeground\(existing\.id, existing\.windowId\)/);
});

test('local bridge accepts bounded browser-window hints and returns a foreground result', () => {
  assert.match(nativeMessage, /public string\? WindowTitle/);
  assert.match(nativeMessage, /public int\? WindowLeft/);
  assert.match(nativeMessage, /public int\? WindowTop/);
  assert.match(nativeMessage, /public int\? WindowWidth/);
  assert.match(nativeMessage, /public int\? WindowHeight/);
  assert.match(nativeHostApplication, /case "window\.foreground":/);
  assert.match(nativeHostApplication, /ChromeWindowForeground\.TryForeground/);
  assert.match(nativeHostApplication, /type = "window\.foregroundResult"/);
});

test('native foregrounding targets a real Chrome top-level window rather than arbitrary processes', () => {
  assert.match(chromeForeground, /Chrome_WidgetWin_/);
  assert.match(chromeForeground, /ProcessName, "chrome"/);
  assert.match(chromeForeground, /GetWindowRect/);
  assert.match(chromeForeground, /TitleMatches/);
  assert.match(chromeForeground, /BoundsDistance/);
  assert.match(chromeForeground, /AllowSetForegroundWindow/);
  assert.match(chromeForeground, /BringWindowToTop/);
  assert.match(chromeForeground, /SetForegroundWindow/);
  assert.match(chromeForeground, /GetForegroundWindow\(\) == target\.Handle/);
});

test('browser API focus remains a fallback if native foreground matching fails', () => {
  assert.match(serviceWorker, /const nativeFocused = await requestNativeChromeForeground\(existing\.id, existing\.windowId\)/);
  assert.match(serviceWorker, /if \(!nativeFocused\) await foregroundChromeWindow\(existing\.windowId\)/);
  assert.match(serviceWorker, /chrome\.windows\.update\(windowId, \{ focused: true \}\)/);
});
