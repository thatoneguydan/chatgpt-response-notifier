import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

process.env.TZ = 'America/New_York';

const repoRoot = path.resolve(import.meta.dirname, '..');
const extensionRoot = path.join(repoRoot, 'standalone-quick-continue');
const read = (name) => fs.readFileSync(path.join(extensionRoot, name), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const bundledConfig = JSON.parse(read('config.json'));
const domCompatSource = read('dom-compat.js');
const backgroundSource = read('background.js');
const promptSource = read('prompt-format.js');
const composerSource = read('composer-text.js');
const sendTransactionSource = read('send-transaction.js');
const configSource = read('config.js');
const runtimeResetSource = read('runtime-reset.js');
const contentSource = read('content-script.js');
const hoverEditSource = read('hover-edit-script.js');
const conversationStateSource = read('conversation-state.js');
const installerSource = read('Install.ps1');
const updater124Source = read('Update-Installed-1.2.4.ps1');

test('standalone extension permissions and runtime order remain bounded', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.background, { service_worker: 'background.js' });
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'scripting', 'storage', 'tabs'].sort());
  assert.deepEqual([...manifest.host_permissions].sort(), ['https://chatgpt.com/*', 'http://127.0.0.1/*'].sort());
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://chatgpt.com/*']);
  assert.deepEqual(manifest.content_scripts[0].js, [
    'dom-compat.js', 'prompt-format.js', 'config.js', 'composer-text.js', 'send-transaction.js',
    'runtime-reset.js', 'config-editor-style.js', 'content-script.js', 'hover-edit-script.js', 'conversation-state.js'
  ]);
  assert.equal(manifest.version, '1.2.29');
  assert.deepEqual(manifest.web_accessible_resources[0].resources, ['config.json']);
});

test('managed updater stays loopback-only and reinjects the shipped runtime set', () => {
  assert.doesNotThrow(() => new vm.Script(backgroundSource));
  assert.match(backgroundSource, /UPDATE_URL = 'http:\/\/127\.0\.0\.1:38473\/quick-continue\/update'/);
  assert.match(backgroundSource, /periodInMinutes: 15/);
  assert.match(backgroundSource, /managedUpdateShouldReload/);
  assert.match(backgroundSource, /chrome\.runtime\.reload\(\)/);
  assert.match(backgroundSource, /chrome\.tabs\.query\(\{ url: \['https:\/\/chatgpt\.com\/\*'\] \}\)/);
  assert.match(backgroundSource, /chrome\.scripting\.executeScript/);
  for (const file of ['dom-compat.js', 'runtime-reset.js', 'config-editor-style.js', 'composer-text.js', 'send-transaction.js', 'conversation-state.js']) {
    assert.match(backgroundSource, new RegExp(file.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(backgroundSource, /github\.com|raw\.githubusercontent\.com|backend-api|XMLHttpRequest|WebSocket/);
});

test('current ChatGPT UI compatibility loads first and remains page-local', () => {
  assert.doesNotThrow(() => new vm.Script(domCompatSource));
  assert.equal(manifest.content_scripts[0].js[0], 'dom-compat.js');
  for (const marker of ['data-message-author-role', 'data-lexical-editor', 'role="textbox"', 'data-placeholder', 'textarea[placeholder]']) {
    assert.ok(domCompatSource.includes(marker));
  }
  assert.match(domCompatSource, /function fallbackComposer\(root\)/);
  assert.match(domCompatSource, /function fallbackSend\(root\)/);
  assert.doesNotMatch(domCompatSource, /\bfetch\s*\(|XMLHttpRequest|WebSocket|backend-api|\/conversation\b/);
});

test('runtime reset disposes all page runtimes exactly once', () => {
  assert.doesNotThrow(() => new vm.Script(runtimeResetSource));
  const disposed = [];
  const context = {
    globalThis: null,
    __chatgptQuickContinueRuntime: { dispose: () => disposed.push('content') },
    __chatgptQuickContinueHoverEditRuntime: { dispose: () => disposed.push('hover') },
    __chatgptQuickContinueConversationStateRuntime: { dispose: () => disposed.push('conversation') }
  };
  context.globalThis = context;
  vm.runInNewContext(runtimeResetSource, context);
  assert.deepEqual(disposed.sort(), ['content', 'conversation', 'hover']);
  assert.equal('__chatgptQuickContinueRuntime' in context, false);
  assert.equal('__chatgptQuickContinueHoverEditRuntime' in context, false);
  assert.equal('__chatgptQuickContinueConversationStateRuntime' in context, false);
});

test('bundled JSON exposes smart and simple watchdog timing independently', () => {
  assert.equal(bundledConfig.continueText, '[{time}] Continue until you finish or need something from me.');
  assert.equal(bundledConfig.projectText, '[{time}] Continue {project} from canonical GitHub state until you finish or need me.');
  assert.equal(bundledConfig.manualTimestampText, '[{time}] {message}');
  assert.deepEqual(bundledConfig.simpleWatchdog, {
    timerMinutes: 30,
    attempts: 3,
    stopToRefreshSeconds: 30,
    refreshToContinueSeconds: 30
  });
  assert.ok(bundledConfig.projects.includes('campaign desk'));
  assert.ok(bundledConfig.projects.includes('notifier extension'));
});

test('prompt formatter preserves configurable timestamps and line breaks', () => {
  const context = { globalThis: null, Intl, Date };
  context.globalThis = context;
  vm.runInNewContext(promptSource, context);
  const api = context.ChatGPTQuickContinuePrompts;
  const date = new Date('2026-09-18T09:20:00-04:00');
  assert.equal(api.continuePrompt('[{time}] Keep going please.', date), '[Sep 18, 9:20 AM] Keep going please.');
  assert.equal(api.continuePrompt('Keep going. Sent at {time}.', date), 'Keep going. Sent at Sep 18, 9:20 AM.');
  assert.equal(api.projectContinuePrompt(' campaign   desk ', 'At {time}, resume {project}.', date), 'At Sep 18, 9:20 AM, resume campaign desk.');
  assert.equal(api.continuePrompt('[{time}] First line.\nSecond line.', date), '[Sep 18, 9:20 AM] First line.\nSecond line.');
  assert.equal(api.renderManualMessage('[{time}]\n{message}', 'First line.\nSecond line.', date), '[Sep 18, 9:20 AM]\nFirst line.\nSecond line.');
  assert.equal(api.projectContinuePrompt('campaign desk', 'No placeholder here.', date), '');
});

test('shared send transaction remains the only programmatic submission path', () => {
  assert.doesNotThrow(() => new vm.Script(sendTransactionSource));
  assert.match(sendTransactionSource, /const VERSION = 3/);
  assert.match(sendTransactionSource, /form\.requestSubmit\(sendButton\)/);
  assert.match(sendTransactionSource, /waitForSendAccepted/);
  assert.match(sendTransactionSource, /reason: 'send-not-confirmed'/);
  assert.doesNotMatch(contentSource, /sendButton\.click\(\)/);
  assert.doesNotMatch(hoverEditSource, /sendButton\.click\(\)/);
  assert.match(contentSource, /sendApi\.submit\(composer, text/);
  assert.match(hoverEditSource, /sendApi\.submit\(composer, expected/);
});

test('project picker is non-modal, editable, and never auto-focuses', () => {
  assert.match(contentSource, /textContent = 'Edit'/);
  assert.match(contentSource, /aria-label', 'Edit Quick Continue JSON'/);
  assert.match(contentSource, /placeholder = 'Other project…'/);
  assert.match(contentSource, /aria-label', 'Quick Continue JSON'/);
  assert.doesNotMatch(contentSource, /\.focus\(/);
  assert.doesNotMatch(contentSource, /\.title\s*=/);
});

test('inline pencil controls remain retired', () => {
  assert.doesNotMatch(hoverEditSource, /data-quick-continue-pencil|createPencilButton|enhanceToolbarButtons|restoreToolbarButtons/);
  assert.doesNotMatch(contentSource, /data-quick-continue-pencil|createPencilButton/);
  assert.match(contentSource, /editButton\.textContent = 'Edit'/);
  assert.match(contentSource, /openConfigEditor\(\)/);
});

test('manual timestamping remains trusted-user-only and atomic', () => {
  assert.match(hoverEditSource, /const CLOCK_SELECTOR = '\[aria-label="Current local time"\]'/);
  assert.match(hoverEditSource, /event\?\.isTrusted !== true/);
  assert.match(hoverEditSource, /event\.isComposing \|\| event\.keyCode === 229/);
  assert.match(hoverEditSource, /let manualSendInFlight = false/);
  assert.match(hoverEditSource, /replace: !alreadyStamped/);
  assert.doesNotMatch(hoverEditSource, /document\.createElement\('br'\)|node\.replaceChildren\(fragment\)/);
});

test('composer replacement preserves exact line-break structure', () => {
  assert.doesNotThrow(() => new vm.Script(composerSource));
  assert.match(composerSource, /replace\(/);
  assert.match(composerSource, /normalize/);
  assert.match(composerSource, /dispatchEvent/);
  assert.doesNotMatch(composerSource, /innerHTML\s*=/);
});

test('conversation state remains per-chat and now owns the Simple toggle', () => {
  assert.doesNotThrow(() => new vm.Script(conversationStateSource));
  assert.match(conversationStateSource, /const RUNTIME_VERSION = 4/);
  assert.match(conversationStateSource, /STORAGE_PREFIX = 'quick-continue:manual-timestamp:'/);
  assert.match(conversationStateSource, /function conversationIdFromUrl/);
  assert.match(conversationStateSource, /chrome\.storage\.local\.get\(key\)/);
  assert.match(conversationStateSource, /navigatesuccess/);
  assert.match(conversationStateSource, /SIMPLE_BUTTON_ID = 'chatgpt-quick-continue-simple-watchdog'/);
  assert.match(conversationStateSource, /textContent = 'Simple'/);
  assert.match(conversationStateSource, /aria-label', 'Toggle simple fallback watchdog'/);
  assert.match(conversationStateSource, /renderSimpleState\(response\?\.enabled === true\)/);
  assert.doesNotMatch(conversationStateSource, /COMPLETE_APPLIED|BLOCKED_HUMAN|INCOMPLETE_LIMIT|PLANNING_ACTIVE/);
});

test('prompt and config APIs advance their runtime generations', () => {
  assert.match(promptSource, /const RUNTIME_VERSION = 5/);
  assert.match(configSource, /const RUNTIME_VERSION = 8/);
  assert.match(configSource, /normalizeSimpleWatchdog/);
  assert.match(contentSource, /const RUNTIME_VERSION = 9/);
  assert.match(hoverEditSource, /const RUNTIME_VERSION = 9/);
  assert.match(conversationStateSource, /const RUNTIME_VERSION = 4/);
});

test('inline JSON Save applies without reload or refresh', () => {
  assert.match(contentSource, /configApi\.save\(parsed\)/);
  assert.match(contentSource, /configApi\.serialize\(currentConfig\)/);
  assert.doesNotMatch(contentSource, /chrome\.runtime\.reload|location\.reload|window\.location\.reload/);
});

test('config controller validates and normalizes simple watchdog settings', async () => {
  const storage = {};
  const changeListeners = [];
  const context = {
    globalThis: null,
    Object, JSON, Set, String, Error, Promise,
    fetch: async () => ({ ok: true, status: 200, json: async () => structuredClone(bundledConfig) }),
    chrome: {
      runtime: { getURL: (name) => `chrome-extension://quick-continue/${name}` },
      storage: {
        local: {
          get: async (key) => ({ [key]: storage[key] }),
          set: async (value) => {
            for (const [key, newValue] of Object.entries(value)) {
              const oldValue = storage[key];
              storage[key] = structuredClone(newValue);
              for (const listener of changeListeners) listener({ [key]: { oldValue, newValue: structuredClone(newValue) } }, 'local');
            }
          },
          remove: async (key) => { delete storage[key]; }
        },
        onChanged: {
          addListener: (listener) => changeListeners.push(listener),
          removeListener: (listener) => {
            const index = changeListeners.indexOf(listener);
            if (index >= 0) changeListeners.splice(index, 1);
          }
        }
      }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(configSource, context);
  const api = context.ChatGPTQuickContinueConfig;
  const initial = await api.load();
  assert.equal(JSON.stringify(initial.simpleWatchdog), JSON.stringify(bundledConfig.simpleWatchdog));

  const saved = await api.save({
    continueText: 'Continue this work.',
    projectText: 'Continue {project} now.',
    manualTimestampText: '[{time}] {message}',
    watchdog: bundledConfig.watchdog,
    simpleWatchdog: {
      timerMinutes: 12.5,
      attempts: 5,
      stopToRefreshSeconds: 18,
      refreshToContinueSeconds: 27
    },
    projects: ['Campaign Desk']
  });
  assert.equal(JSON.stringify(saved.simpleWatchdog), JSON.stringify({
    timerMinutes: 12.5,
    attempts: 5,
    stopToRefreshSeconds: 18,
    refreshToContinueSeconds: 27
  }));
  await assert.rejects(() => api.save({
    continueText: 'Continue.', projectText: 'Continue {project}.', manualTimestampText: '[{time}] {message}',
    watchdog: bundledConfig.watchdog,
    simpleWatchdog: { timerMinutes: 30, attempts: 3, stopToRefreshSeconds: -1, refreshToContinueSeconds: 30 },
    projects: []
  }), /simpleWatchdog\.stopToRefreshSeconds/);
});

test('config storage remains extension-local', () => {
  assert.match(configSource, /chrome\.runtime\.getURL\('config\.json'\)/);
  assert.match(configSource, /chrome\.storage\.local\.set/);
  assert.doesNotMatch(configSource, /https?:\/\//);
  assert.doesNotMatch(configSource, /XMLHttpRequest|WebSocket|setInterval/);
});

test('installer still copies the managed runtime without touching Chrome registration', () => {
  for (const file of ['dom-compat.js', 'background.js', 'config.js', 'config.json', 'composer-text.js', 'send-transaction.js', 'runtime-reset.js', 'conversation-state.js']) {
    assert.match(installerSource, new RegExp(file.replaceAll('.', '\\.')));
  }
  assert.match(installerSource, /ChatGPTQuickContinue\\Extension/);
  assert.match(installerSource, /Remove-Item -LiteralPath \$legacyProjects -Force/);
  assert.doesNotMatch(installerSource, /Set-ItemProperty|New-ItemProperty|reg\.exe|HKCU:|HKLM:/i);
  assert.doesNotMatch(installerSource, /Start-Process|chrome\.exe/i);
});

test('1.2.4 updater remains pinned historical recovery code', () => {
  assert.match(updater124Source, /\$commit = '25add9fcb113c80eea3bfbefc0e28db490bac52c'/);
  assert.match(updater124Source, /expected 1\.2\.4/);
  assert.match(updater124Source, /Get-FileHash -Algorithm SHA256/);
});

test('Project menu remains available even when sending is unavailable', () => {
  assert.match(contentSource, /const sendButtons = \[\]/);
  assert.match(contentSource, /sendButtons\.push\(continueButton\)/);
  assert.doesNotMatch(contentSource, /sendButtons\.push\(projectButton\)/);
  assert.match(contentSource, /function canSendProject\(\)/);
});

test('toolbar sync avoids clock self-churn and transient-rerender flicker', () => {
  assert.match(contentSource, /clock && clock\.textContent !== clockText/);
  assert.match(contentSource, /const TOOLBAR_HIDE_GRACE_MS = 600/);
  assert.match(contentSource, /function toolbarStructureIntact\(root\)/);
  assert.match(contentSource, /function discardToolbar\(\)/);
});

test('standalone runtime hot-replaces stale generations without notifier churn', () => {
  assert.match(contentSource, /const RUNTIME_VERSION = 9/);
  assert.match(contentSource, /previousRuntime\?\.dispose\?\.\(\)/);
  assert.match(contentSource, /const NOTIFIER_MUTATION_SELECTOR/);
  assert.match(contentSource, /function notifierOnlyMutation\(records\)/);
  assert.match(contentSource, /new MutationObserver\(handleDocumentMutations\)/);
});

test('project popover still chooses the available side of the viewport', () => {
  assert.match(contentSource, /function preferredPopoverDirection\(toolbarRect, popoverHeight, viewportHeight\)/);
  assert.match(contentSource, /if \(upwardTop >= margin\) return 'above'/);
  assert.match(contentSource, /if \(downwardBottom <= viewport - margin\) return 'below'/);
  assert.match(contentSource, /spaceBelow > spaceAbove \? 'below' : 'above'/);
});

test('Simple fallback is a dumb persisted countdown-stop-refresh-send loop', () => {
  assert.match(backgroundSource, /SIMPLE_STATE_KEY = 'quickContinueSimpleWatchdogStates'/);
  assert.match(backgroundSource, /SIMPLE_ALARM_PREFIX = 'quick-continue-simple-watchdog:'/);
  assert.match(backgroundSource, /phase: 'countdown'/);
  assert.match(backgroundSource, /state\.phase = 'stop-wait'/);
  assert.match(backgroundSource, /state\.settings\.stopToRefreshSeconds \* 1000/);
  assert.match(backgroundSource, /chrome\.tabs\.reload\(tabId\)/);
  assert.match(backgroundSource, /state\.phase = 'refresh-wait'/);
  assert.match(backgroundSource, /state\.settings\.refreshToContinueSeconds \* 1000/);
  assert.match(backgroundSource, /action: 'send-continue'/);
  assert.match(backgroundSource, /state\.attemptsUsed = Number\(state\.attemptsUsed \|\| 0\) \+ 1/);
  assert.match(backgroundSource, /state\.nextAt = Date\.now\(\) \+ \(state\.settings\.timerMinutes \* 60 \* 1000\)/);
  assert.match(backgroundSource, /queueSimpleWork\(restoreSimpleAlarms\)/);
  assert.match(conversationStateSource, /button\[data-testid="stop-button"\]/);
  assert.match(conversationStateSource, /button\[aria-label="Stop generating"\]/);
  assert.match(conversationStateSource, /sendApi\.submit\(composer, text, \{ replace: true, timeoutMs: 5000 \}\)/);
  assert.doesNotMatch(backgroundSource, /COMPLETE_APPLIED|COMPLETE_NO_CHANGES|BLOCKED_HUMAN|INCOMPLETE_LIMIT|INCOMPLETE_TOOL_FAILURE|PLANNING_ACTIVE/);
  assert.doesNotMatch(conversationStateSource, /COMPLETE_APPLIED|COMPLETE_NO_CHANGES|BLOCKED_HUMAN|INCOMPLETE_LIMIT|INCOMPLETE_TOOL_FAILURE|PLANNING_ACTIVE/);
});
