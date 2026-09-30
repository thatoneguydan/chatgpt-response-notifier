import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');

const guard = readText('extension/composer-typing-performance-guard.js');
const manifest = JSON.parse(readText('extension/manifest.json'));
const hotUpdate = readText('extension/terminal-stop-post-update-recovery-background.js');
const compatBackground = readText('extension/page-runtime-compat-background.js');
const rebind = readText('extension/page-runtime-rebind.js');

test('composer typing guard is syntactically valid and loaded once before all live readers', () => {
  assert.doesNotThrow(() => new vm.Script(guard));
  assert.equal(manifest.version, '0.9.100');
  const scripts = manifest.content_scripts[0]?.js || [];
  const compatIndex = scripts.indexOf('page-dom-compat.js');
  const guardIndex = scripts.indexOf('composer-typing-performance-guard.js');
  const monitorIndex = scripts.indexOf('monitor-script.js');
  const terminalIndex = scripts.indexOf('terminal-status-live-observer.js');
  const watchdogIndex = scripts.indexOf('watchdog-page-authority-v3.js');
  assert.ok(compatIndex >= 0 && guardIndex === compatIndex + 1);
  assert.ok(monitorIndex > guardIndex);
  assert.ok(terminalIndex > guardIndex);
  assert.ok(watchdogIndex > guardIndex);
  const allStartupScripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
  assert.equal(allStartupScripts.filter((file) => file === 'composer-typing-performance-guard.js').length, 1);
  assert.equal(allStartupScripts.filter((file) => file === 'page-dom-compat.js').length, 1);
});

test('composer mutations are suppressed for terminal readers and transition-limited for the monitor', () => {
  assert.match(guard, /const PreviousMutationObserver = globalThis\.MutationObserver/);
  assert.match(guard, /function isMonitorObservation\(options\)/);
  assert.match(guard, /MONITOR_ATTRIBUTE_FILTER\.every\(\(name\) => filter\.has\(name\)\)/);
  assert.match(guard, /state\?\.monitorObservation !== true \|\| deliveredDraftTransition/);
  assert.match(guard, /if \(state\.lastDraftPresent === present\) continue;/);
  assert.match(guard, /state\.lastDraftPresent = present/);
  assert.match(guard, /if \(filtered\.length\) callback\(filtered, facade\)/);
  assert.match(guard, /takeRecords\(\) \{ return filterComposerMutations\(this\.inner\.takeRecords\(\), this\.state\); \}/);
  assert.match(guard, /globalThis\.MutationObserver = ComposerQuietMutationObserver/);
});

test('draft transition routing uses text only and creates no DOM signal or layout work', () => {
  assert.match(guard, /composer\.textContent/);
  assert.doesNotMatch(guard, /document\.addEventListener\('input'/);
  assert.doesNotMatch(guard, /createElement|append\(|setAttribute|dispatchEvent|CustomEvent/);
  assert.doesNotMatch(guard, /innerText|getBoundingClientRect|offsetWidth|offsetHeight/);
});

test('hot updates and ad-hoc runtime injections preserve compat then guard ordering', () => {
  const hotCompat = hotUpdate.indexOf("'page-dom-compat.js'");
  const hotGuard = hotUpdate.indexOf("'composer-typing-performance-guard.js'");
  const hotMonitor = hotUpdate.indexOf("'monitor-script.js'");
  assert.ok(hotCompat >= 0 && hotGuard > hotCompat && hotMonitor > hotGuard);

  assert.match(compatBackground, /PAGE_COMPAT_FILES = Object\.freeze\(\[\s*'page-dom-compat\.js',\s*'composer-typing-performance-guard\.js'/);
  assert.match(compatBackground, /const withoutCompat = files\.filter\(\(file\) => !PAGE_COMPAT_FILES\.includes\(file\)\)/);
  assert.match(compatBackground, /const orderedFiles = \[\.\.\.PAGE_COMPAT_FILES, \.\.\.withoutCompat\]/);

  assert.match(rebind, /RUNTIME_GENERATION = 4/);
  assert.match(rebind, /'__chatgptNotifierTypingPerformanceGuard'/);
});
