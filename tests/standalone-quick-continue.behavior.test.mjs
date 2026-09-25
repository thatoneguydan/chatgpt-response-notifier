import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

process.env.TZ = 'America/New_York';

const repoRoot = path.resolve(import.meta.dirname, '..');
const extensionRoot = path.join(repoRoot, 'standalone-quick-continue');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
const bundledConfig = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'config.json'), 'utf8'));
const domCompatSource = fs.readFileSync(path.join(extensionRoot, 'dom-compat.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(extensionRoot, 'background.js'), 'utf8');
const promptSource = fs.readFileSync(path.join(extensionRoot, 'prompt-format.js'), 'utf8');
const composerSource = fs.readFileSync(path.join(extensionRoot, 'composer-text.js'), 'utf8');
const configSource = fs.readFileSync(path.join(extensionRoot, 'config.js'), 'utf8');
const runtimeResetSource = fs.readFileSync(path.join(extensionRoot, 'runtime-reset.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(extensionRoot, 'content-script.js'), 'utf8');
const hoverEditSource = fs.readFileSync(path.join(extensionRoot, 'hover-edit-script.js'), 'utf8');
const conversationStateSource = fs.readFileSync(path.join(extensionRoot, 'conversation-state.js'), 'utf8');
const installerSource = fs.readFileSync(path.join(extensionRoot, 'Install.ps1'), 'utf8');
const updater124Source = fs.readFileSync(path.join(extensionRoot, 'Update-Installed-1.2.4.ps1'), 'utf8');

test('standalone extension adds only the local managed-update worker permissions', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.background, { service_worker: 'background.js' });
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'scripting', 'storage', 'tabs'].sort());
  assert.deepEqual([...manifest.host_permissions].sort(), ['https://chatgpt.com/*', 'http://127.0.0.1/*'].sort());
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://chatgpt.com/*']);
  assert.deepEqual(manifest.content_scripts[0].js, ['dom-compat.js', 'prompt-format.js', 'config.js', 'composer-text.js', 'runtime-reset.js', 'content-script.js', 'hover-edit-script.js', 'conversation-state.js']);
  assert.equal(manifest.version, '1.2.19');
  assert.deepEqual(manifest.web_accessible_resources[0].resources, ['config.json']);
  assert.deepEqual(manifest.web_accessible_resources[0].matches, ['https://chatgpt.com/*']);
});

test('managed updater talks only to loopback, reloads itself, and reinjects current scripts into open ChatGPT tabs', () => {
  assert.doesNotThrow(() => new vm.Script(backgroundSource));
  assert.match(backgroundSource, /UPDATE_URL = 'http:\/\/127\.0\.0\.1:38473\/quick-continue\/update'/);
  assert.match(backgroundSource, /periodInMinutes: 15/);
  assert.match(backgroundSource, /chrome\.runtime\.reload\(\)/);
  assert.match(backgroundSource, /chrome\.tabs\.query\(\{ url: \['https:\/\/chatgpt\.com\/\*'\] \}\)/);
  assert.match(backgroundSource, /chrome\.scripting\.executeScript/);
  assert.match(backgroundSource, /'dom-compat\.js'/);
  assert.match(backgroundSource, /'runtime-reset\.js'/);
  assert.match(backgroundSource, /'composer-text\.js'/);
  assert.match(backgroundSource, /'conversation-state\.js'/);
  assert.doesNotMatch(backgroundSource, /github\.com|raw\.githubusercontent\.com|backend-api|XMLHttpRequest|WebSocket/);
});

test('current ChatGPT UI compatibility loads first and covers semantic composer and send controls', () => {
  assert.doesNotThrow(() => new vm.Script(domCompatSource));
  assert.equal(manifest.content_scripts[0].js[0], 'dom-compat.js');
  assert.match(domCompatSource, /data-message-author-role/);
  assert.match(domCompatSource, /data-lexical-editor/);
  assert.match(domCompatSource, /role="textbox"/);
  assert.match(domCompatSource, /data-placeholder/);
  assert.match(domCompatSource, /textarea\[placeholder\]/);
  assert.match(domCompatSource, /function fallbackComposer\(root\)/);
  assert.match(domCompatSource, /function fallbackSend\(root\)/);
  assert.match(domCompatSource, /composer\[-_ \]\?send/);
  assert.match(domCompatSource, /nativeClosest\.call\(this, 'button'\)/);
  assert.doesNotMatch(domCompatSource, /\bfetch\s*\(|XMLHttpRequest|WebSocket|backend-api|\/conversation\b/);
});

test('runtime reset disposes stale page runtimes before current scripts rebind to the config API', () => {
  assert.doesNotThrow(() => new vm.Script(runtimeResetSource));
  const disposed = [];
  const context = {
    globalThis: {},
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

test('bundled JSON contains editable prompt templates and saved projects', () => {
  assert.equal(bundledConfig.continueText, '[{time}] Continue until you finish or need something from me.');
  assert.equal(bundledConfig.projectText, '[{time}] Continue {project} from canonical GitHub state until you finish or need me.');
  assert.equal(bundledConfig.manualTimestampText, '[{time}] {message}');
  assert.ok(Array.isArray(bundledConfig.projects));
  assert.ok(bundledConfig.projects.includes('campaign desk'));
  assert.ok(bundledConfig.projects.includes('notifier extension'));
  assert.equal(new Set(bundledConfig.projects.map((value) => value.toLowerCase())).size, bundledConfig.projects.length);
});

test('prompt formatter places configurable time, project, and message placeholders and preserves newlines', () => {
  const context = { globalThis: {}, Intl, Date };
  context.globalThis = context;
  vm.runInNewContext(promptSource, context);

  const api = context.ChatGPTQuickContinuePrompts;
  const date = new Date('2026-09-18T09:20:00-04:00');

  const normal = api.continuePrompt('[{time}] Keep going please.', date);
  const movedTime = api.continuePrompt('Keep going please. Sent at {time}.', date);
  const project = api.projectContinuePrompt(
    '  campaign   desk  ',
    'At {time}, resume {project} from canonical GitHub state.',
    date
  );
  const legacy = api.continuePrompt('Legacy continue text.', date);
  const multiline = api.continuePrompt('[{time}] First line.\nSecond line.', date);
  const multilineProject = api.projectContinuePrompt(
    'campaign desk',
    '[{time}] Continue {project}.\nUse GitHub status codes policy.',
    date
  );
  const manual = api.renderManualMessage('[{time}]\n{message}', 'First line.\nSecond line.', date);
  const movedMessage = api.renderManualMessage('{message}\nSent at {time}.', 'Custom body.', date);

  assert.equal(normal, '[Sep 18, 9:20 AM] Keep going please.');
  assert.equal(movedTime, 'Keep going please. Sent at Sep 18, 9:20 AM.');
  assert.equal(project, 'At Sep 18, 9:20 AM, resume campaign desk from canonical GitHub state.');
  assert.equal(legacy, '[Sep 18, 9:20 AM] Legacy continue text.');
  assert.equal(multiline, '[Sep 18, 9:20 AM] First line.\nSecond line.');
  assert.equal(multilineProject, '[Sep 18, 9:20 AM] Continue campaign desk.\nUse GitHub status codes policy.');
  assert.equal(manual, '[Sep 18, 9:20 AM]\nFirst line.\nSecond line.');
  assert.equal(movedMessage, 'Custom body.\nSent at Sep 18, 9:20 AM.');
  assert.equal(api.projectContinuePrompt('campaign desk', 'No placeholder here.', date), '');
});

test('send path clicks the real ChatGPT Send button at most once and verifies exact multiline content', () => {
  assert.match(contentSource, /button\[data-testid="send-button"\]/);
  assert.match(contentSource, /sendButton\.click\(\)/);
  assert.equal((contentSource.match(/sendButton\.click\(\)/g) || []).length, 1);
  assert.match(contentSource, /composerApi\.replace\(node, text\)/);
  assert.doesNotMatch(contentSource, /document\.createElement\('br'\)/);
  assert.doesNotMatch(contentSource, /XMLHttpRequest/);
  assert.doesNotMatch(contentSource, /WebSocket/);
  assert.match(contentSource, /chatgpt-notifier-quick-prompts/);
});

test('project picker is non-modal, exposes Edit, and never auto-focuses', () => {
  assert.match(contentSource, /textContent = 'Edit'/);
  assert.match(contentSource, /aria-label', 'Edit Quick Continue JSON'/);
  assert.match(contentSource, /placeholder = 'Other project…'/);
  assert.match(contentSource, /aria-label', 'Quick Continue JSON'/);
  assert.doesNotMatch(contentSource, /\.focus\(/);
  assert.match(contentSource, /event\.key === 'Escape'/);
  assert.match(contentSource, /event\.key === 'Enter'/);
  assert.doesNotMatch(contentSource, /\.title\s*=/);
});

test('inline pencil controls are removed while Project Edit remains the JSON editor entry point', () => {
  assert.doesNotMatch(hoverEditSource, /data-quick-continue-pencil|pencil\.textContent|createPencilButton|enhanceToolbarButtons|restoreToolbarButtons/);
  assert.doesNotMatch(hoverEditSource, /Edit Project text|Edit Continue text/);
  assert.doesNotMatch(contentSource, /data-quick-continue-pencil|pencil\.textContent|createPencilButton/);
  assert.match(contentSource, /editButton\.textContent = 'Edit'/);
  assert.match(contentSource, /editButton\.setAttribute\('aria-label', 'Edit Quick Continue JSON'\)/);
  assert.match(contentSource, /openConfigEditor\(\)/);
  assert.match(hoverEditSource, /new MutationObserver\(scheduleToolbarSync\)/);
  assert.match(hoverEditSource, /requestAnimationFrame/);
  assert.doesNotMatch(hoverEditSource, /XMLHttpRequest|WebSocket|fetch\(/);
});

test('clock toggle renders the configured manual-message template only for trusted manual sends', () => {
  assert.match(hoverEditSource, /const CLOCK_SELECTOR = '\[aria-label="Current local time"\]'/);
  assert.match(hoverEditSource, /setAttribute\('aria-pressed', String\(manualTimestampEnabled\)\)/);
  assert.match(hoverEditSource, /outline: manualTimestampEnabled \? '1px solid currentColor' : '1px solid transparent'/);
  assert.match(hoverEditSource, /prompts\?\.formatTimestamp/);
  assert.match(hoverEditSource, /prompts\?\.renderManualMessage/);
  assert.match(hoverEditSource, /manualTimestampText/);
  assert.match(hoverEditSource, /configApi\?\.subscribe/);
  assert.match(hoverEditSource, /function hasLeadingTimestamp\(text\)/);
  assert.match(hoverEditSource, /event\?\.isTrusted !== true/);
  assert.match(hoverEditSource, /event\.key !== 'Enter' \|\| event\.shiftKey \|\| event\.altKey/);
  assert.match(hoverEditSource, /event\.isComposing \|\| event\.keyCode === 229/);
  assert.match(hoverEditSource, /composerApi\?\.replace\(node, text\)/);
  assert.doesNotMatch(hoverEditSource, /document\.createElement\('br'\)|node\.replaceChildren\(fragment\)/);
  assert.match(hoverEditSource, /document\.addEventListener\('click', handleManualSendClick, true\)/);
  assert.match(hoverEditSource, /document\.addEventListener\('keydown', handleManualSendKeydown, true\)/);
  assert.match(hoverEditSource, /document\.removeEventListener\('click', handleManualSendClick, true\)/);
  assert.match(hoverEditSource, /document\.removeEventListener\('keydown', handleManualSendKeydown, true\)/);
});

test('composer replacement uses an editor transaction and refuses altered line breaks', () => {
  class Textarea { constructor() { this.value = ''; this.events = []; } dispatchEvent(event) { this.events.push(event.type); } }
  class Input extends Textarea {}
  class Editable { constructor() { this.isContentEditable = true; this.innerText = ''; this.focused = false; } focus() { this.focused = true; } }
  const element = new Editable();
  let changed = '';
  let distort = false;
  let syntheticInputCount = 0;
  const context = {
    globalThis: null,
    HTMLTextAreaElement: Textarea,
    HTMLInputElement: Input,
    Event: class { constructor(type) { this.type = type; } },
    InputEvent: class { constructor(type) { this.type = type; } },
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    document: {
      createRange: () => ({ selectNodeContents() {} }),
      execCommand(command, ui, text) {
        assert.equal(command, 'insertText');
        assert.equal(ui, false);
        changed = text;
        element.innerText = distort ? text.replaceAll('\n', '\n\n') : text;
        return true;
      }
    }
  };
  context.globalThis = context;
  element.dispatchEvent = () => { syntheticInputCount += 1; };
  vm.runInNewContext(composerSource, context);
  const api = context.ChatGPTQuickContinueComposer;
  for (const expected of ['one\ntwo', 'one\n\ntwo', 'one\n\n\ntwo', 'one\n', '\none']) {
    distort = false;
    assert.equal(api.replace(element, expected), true, `exact editor write: ${JSON.stringify(expected)}`);
    assert.equal(changed, expected);
    assert.equal(api.read(element), expected);
  }
  distort = true;
  assert.equal(api.replace(element, 'one\ntwo'), false, 'mismatched editor paragraph count must block send');
  assert.equal(syntheticInputCount, 0, 'do not send a synthetic contenteditable input event');
  const textarea = new Textarea();
  assert.equal(api.replace(textarea, 'one\n\ntwo'), true);
  assert.equal(textarea.value, 'one\n\ntwo');
  assert.deepEqual(textarea.events, ['input']);
});

test('manual timestamp preference is isolated by ChatGPT conversation and follows SPA navigation', () => {
  assert.doesNotThrow(() => new vm.Script(conversationStateSource));
  assert.match(conversationStateSource, /STORAGE_PREFIX = 'quick-continue:manual-timestamp:'/);
  assert.match(conversationStateSource, /function conversationIdFromUrl/);
  assert.match(conversationStateSource, /chrome\.storage\.local\.get\(key\)/);
  assert.match(conversationStateSource, /chrome\.storage\.local\.set\(\{ \[storageKey\(conversationId\)\]: enabled === true \}\)/);
  assert.match(conversationStateSource, /if \(!previousConversationId && provisionalTouched\)/);
  assert.match(conversationStateSource, /chrome\.storage\.onChanged\.addListener\(handleStorageChanged\)/);
  assert.match(conversationStateSource, /navigatesuccess/);
  assert.match(conversationStateSource, /event\?\.isTrusted !== true/);
  assert.doesNotMatch(conversationStateSource, /XMLHttpRequest|WebSocket|fetch\(/);
});

test('prompt and config APIs are versioned so reinjection cannot retain stale globals indefinitely', () => {
  assert.match(promptSource, /const RUNTIME_VERSION = 5/);
  assert.match(promptSource, /runtimeVersion: RUNTIME_VERSION/);
  assert.match(configSource, /const RUNTIME_VERSION = 6/);
  assert.match(configSource, /previousRuntime\?\.dispose\?\.\(\)/);
  assert.match(configSource, /runtimeVersion: RUNTIME_VERSION/);
  assert.match(configSource, /chrome\.storage\.onChanged\.addListener\(handleStorageChanged\)/);
  assert.match(configSource, /chrome\.storage\.onChanged\.removeListener\(handleStorageChanged\)/);
  assert.match(hoverEditSource, /const RUNTIME_VERSION = 8/);
  assert.match(hoverEditSource, /previousRuntime\?\.dispose\?\.\(\)/);
  assert.match(hoverEditSource, /__chatgptQuickContinueHoverEditRuntime/);
  assert.match(conversationStateSource, /const RUNTIME_VERSION = 1/);
  assert.match(conversationStateSource, /__chatgptQuickContinueConversationStateRuntime/);
});

test('inline JSON Save applies through config storage without reload or refresh calls', () => {
  assert.match(contentSource, /configApi\.save\(parsed\)/);
  assert.match(contentSource, /configApi\.serialize\(currentConfig\)/);
  assert.doesNotMatch(contentSource, /chrome\.runtime\.reload/);
  assert.doesNotMatch(contentSource, /location\.reload/);
  assert.doesNotMatch(contentSource, /window\.location\.reload/);
  assert.match(configSource, /chrome\.storage\.onChanged\.addListener/);
  assert.match(configSource, /chrome\.storage\.local\.set/);
});

test('config controller loads bundled JSON only from the extension, preserves multiline templates, and migrates manual templates', async () => {
  const storage = {};
  const changeListeners = [];
  const fetchCalls = [];
  const context = {
    globalThis: {},
    console,
    Object,
    JSON,
    Set,
    String,
    Error,
    Promise,
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => structuredClone(bundledConfig)
      };
    },
    chrome: {
      runtime: {
        getURL: (pathName) => `chrome-extension://quick-continue/${pathName}`
      },
      storage: {
        local: {
          get: async (key) => ({ [key]: storage[key] }),
          set: async (value) => {
            const entries = Object.entries(value);
            for (const [key, newValue] of entries) {
              const oldValue = storage[key];
              storage[key] = structuredClone(newValue);
              for (const listener of changeListeners) {
                listener({ [key]: { oldValue, newValue: structuredClone(newValue) } }, 'local');
              }
            }
          },
          remove: async (key) => {
            const oldValue = storage[key];
            delete storage[key];
            for (const listener of changeListeners) {
              listener({ [key]: { oldValue, newValue: undefined } }, 'local');
            }
          }
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
  assert.equal(initial.continueText, bundledConfig.continueText);
  assert.equal(initial.manualTimestampText, '[{time}] {message}');
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'chrome-extension://quick-continue/config.json');

  let observed = null;
  api.subscribe((config) => { observed = config; });
  const saved = await api.save({
    continueText: 'Continue this work.',
    projectText: 'Continue {project} now.',
    projects: ['Campaign Desk', 'campaign desk', 'Time Tracker']
  });

  assert.equal(saved.continueText, '[{time}] Continue this work.');
  assert.equal(saved.projectText, '[{time}] Continue {project} now.');
  assert.equal(saved.manualTimestampText, '[{time}] {message}');
  assert.deepEqual([...saved.projects], ['Campaign Desk', 'Time Tracker']);
  assert.equal(observed.continueText, '[{time}] Continue this work.');
  assert.equal(observed.manualTimestampText, '[{time}] {message}');

  const moved = await api.save({
    continueText: 'At {time}, continue this work.',
    projectText: 'Resume {project} at {time}.',
    manualTimestampText: 'Sent at {time}:',
    projects: ['Campaign Desk']
  });
  assert.equal(moved.continueText, 'At {time}, continue this work.');
  assert.equal(moved.projectText, 'Resume {project} at {time}.');
  assert.equal(moved.manualTimestampText, 'Sent at {time}: {message}');

  const multiline = await api.save({
    continueText: '[{time}] Continue until you finish.\nUse GitHub status codes policy.',
    projectText: '[{time}] Continue {project}.\nUse GitHub status codes policy.',
    manualTimestampText: '[{time}]\n{message}',
    projects: ['Campaign Desk']
  });
  assert.equal(multiline.continueText, '[{time}] Continue until you finish.\nUse GitHub status codes policy.');
  assert.equal(multiline.projectText, '[{time}] Continue {project}.\nUse GitHub status codes policy.');
  assert.equal(multiline.manualTimestampText, '[{time}]\n{message}');
  assert.equal(storage.quickContinueConfig.continueText, multiline.continueText);
  assert.equal(JSON.parse(api.serialize(multiline)).continueText, multiline.continueText);
  assert.equal(JSON.parse(api.serialize(multiline)).manualTimestampText, multiline.manualTimestampText);
  assert.match(api.serialize(multiline), /Continue until you finish\.\\nUse GitHub status codes policy\./);
  assert.match(api.serialize(multiline), /\[\{time\}\]\\n\{message\}/);

  await assert.rejects(
    () => api.save({
      continueText: 'Continue.',
      projectText: 'This template forgot the placeholder.',
      projects: []
    }),
    /must include \{project\}/
  );
});

test('config storage contains no external network endpoint or background transport', () => {
  assert.match(configSource, /chrome\.runtime\.getURL\('config\.json'\)/);
  assert.match(configSource, /fetch\(chrome\.runtime\.getURL\('config\.json'\)/);
  assert.doesNotMatch(configSource, /https?:\/\//);
  assert.doesNotMatch(configSource, /XMLHttpRequest/);
  assert.doesNotMatch(configSource, /WebSocket/);
  assert.doesNotMatch(configSource, /setInterval/);
});

test('installer copies managed worker/config files and removes the legacy projects JSON', () => {
  assert.match(installerSource, /LOCALAPPDATA/);
  assert.match(installerSource, /ChatGPTQuickContinue\\Extension/);
  assert.match(installerSource, /'dom-compat\.js'/);
  assert.match(installerSource, /'background\.js'/);
  assert.match(installerSource, /'config\.js'/);
  assert.match(installerSource, /'config\.json'/);
  assert.match(installerSource, /'composer-text\.js'/);
  assert.match(installerSource, /'runtime-reset\.js'/);
  assert.match(installerSource, /'conversation-state\.js'/);
  assert.match(installerSource, /'projects\.json'/);
  assert.match(installerSource, /Remove-Item -LiteralPath \$legacyProjects -Force/);
  assert.doesNotMatch(installerSource, /Set-ItemProperty|New-ItemProperty|reg\.exe|HKCU:|HKLM:/i);
  assert.doesNotMatch(installerSource, /Start-Process|chrome\.exe/i);
});

test('1.2.4 updater pins the repaired runtime set without overwriting live config defaults', () => {
  assert.match(updater124Source, /\$commit = '25add9fcb113c80eea3bfbefc0e28db490bac52c'/);
  assert.match(updater124Source, /expected 1\.2\.4/);
  for (const file of ['manifest.json', 'prompt-format.js', 'config.js', 'content-script.js', 'README.md']) {
    assert.match(updater124Source, new RegExp(file.replace('.', '\\.') ));
  }
  assert.doesNotMatch(updater124Source, /\$files\s*=\s*@\([^\r\n]*config\.json/);
  assert.match(updater124Source, /requiresChromeExtensionReload\s*=\s*\$true/);
  assert.match(updater124Source, /requiresChatGptPageReload\s*=\s*\$true/);
  assert.match(updater124Source, /Get-FileHash -Algorithm SHA256/);
});

test('Project menu stays available for config editing when send controls are unavailable', () => {
  assert.match(contentSource, /const sendButtons = \[\]/);
  assert.match(contentSource, /sendButtons\.push\(continueButton\)/);
  assert.doesNotMatch(contentSource, /sendButtons\.push\(projectButton\)/);
  assert.match(contentSource, /function canSendProject\(\)/);
});

test('toolbar sync does not continuously retrigger itself through unchanged clock text', () => {
  assert.match(contentSource, /const clockText = formatClock\(now\)/);
  assert.match(contentSource, /clock && clock\.textContent !== clockText/);
  assert.match(contentSource, /clock\.textContent = clockText/);
  assert.doesNotMatch(contentSource, /if \(clock\) clock\.textContent = formatClock\(now\)/);
});

test('toolbar self-heals missing core controls and recovers from transient composer rerenders', () => {
  assert.match(contentSource, /const TOOLBAR_HIDE_GRACE_MS = 600/);
  assert.match(contentSource, /function toolbarStructureIntact\(root\)/);
  assert.match(contentSource, /button\[aria-label="Send timestamped Continue"\]/);
  assert.match(contentSource, /button\[aria-label="Project Continue"\]/);
  assert.match(contentSource, /function discardToolbar\(\)/);
  assert.match(contentSource, /if \(root && !toolbarStructureIntact\(root\)\)/);
  assert.match(contentSource, /discardToolbar\(\);/);
  assert.match(contentSource, /if \(composer && anchor && visible\(anchor\)\) \{\s+scheduleSync\(\);\s+return;/);
  assert.match(contentSource, /\}, TOOLBAR_HIDE_GRACE_MS\);/);
});

test('standalone runtime hot-replaces stale generations, restores a detached toolbar, and ignores notifier-only churn', () => {
  assert.match(contentSource, /const RUNTIME_VERSION = 7/);
  assert.match(contentSource, /const previousRuntime = globalThis\.__chatgptQuickContinueRuntime/);
  assert.match(contentSource, /previousRuntime\?\.dispose\?\.\(\)/);
  assert.doesNotMatch(contentSource, /__chatgptQuickContinueInstalled/);
  assert.match(contentSource, /if \(!root\.isConnected\)/);
  assert.match(contentSource, /\(document\.body \|\| document\.documentElement\)\.append\(root\)/);
  assert.match(contentSource, /const NOTIFIER_MUTATION_SELECTOR/);
  assert.match(contentSource, /chatgpt-notifier-countdown-fallback-v/);
  assert.match(contentSource, /function notifierOnlyMutation\(records\)/);
  assert.match(contentSource, /new MutationObserver\(handleDocumentMutations\)/);
  assert.match(contentSource, /document\.addEventListener\('pointerdown', handleDocumentPointerDown, true\)/);
  assert.match(contentSource, /document\.removeEventListener\('pointerdown', handleDocumentPointerDown, true\)/);
  assert.match(contentSource, /document\.removeEventListener\('input', scheduleSync, true\)/);
  assert.match(contentSource, /document\.removeEventListener\('scroll', scheduleSync, true\)/);
  assert.match(contentSource, /document\.removeEventListener\('visibilitychange', scheduleSync, true\)/);
  assert.match(contentSource, /window\.removeEventListener\('resize', scheduleSync\)/);
});

test('project popover opens above when it fits, flips below near the top, and chooses the roomier side if neither fits', () => {
  assert.match(contentSource, /function preferredPopoverDirection\(toolbarRect, popoverHeight, viewportHeight\)/);
  assert.match(contentSource, /if \(upwardTop >= margin\) return 'above'/);
  assert.match(contentSource, /if \(downwardBottom <= viewport - margin\) return 'below'/);
  assert.match(contentSource, /spaceBelow > spaceAbove \? 'below' : 'above'/);
  assert.match(contentSource, /projectPopover\.style\.top = 'calc\(100% \+ 6px\)'/);
  assert.match(contentSource, /projectPopover\.style\.bottom = 'auto'/);
  assert.match(contentSource, /projectPopover\.style\.top = 'auto'/);
  assert.match(contentSource, /projectPopover\.style\.bottom = 'calc\(100% \+ 6px\)'/);
  assert.match(contentSource, /root\.style\.visibility = 'visible';\s+positionProjectPopover\(\);/);
  assert.match(contentSource, /setEditorMode\(true\);\s+positionProjectPopover\(\);/);
});
