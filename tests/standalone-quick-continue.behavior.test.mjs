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
const promptSource = fs.readFileSync(path.join(extensionRoot, 'prompt-format.js'), 'utf8');
const configSource = fs.readFileSync(path.join(extensionRoot, 'config.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(extensionRoot, 'content-script.js'), 'utf8');
const installerSource = fs.readFileSync(path.join(extensionRoot, 'Install.ps1'), 'utf8');

test('standalone extension stays background-free with only local storage permission', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background, undefined);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://chatgpt.com/*']);
  assert.deepEqual(manifest.content_scripts[0].js, ['prompt-format.js', 'config.js', 'content-script.js']);
  assert.equal(manifest.version, '1.2.4');
  assert.deepEqual(manifest.web_accessible_resources[0].resources, ['config.json']);
  assert.deepEqual(manifest.web_accessible_resources[0].matches, ['https://chatgpt.com/*']);
});

test('bundled JSON contains both prompt texts and saved projects', () => {
  assert.equal(bundledConfig.continueText, 'Continue until you finish or need something from me.');
  assert.equal(bundledConfig.projectText, 'Continue {project} from canonical GitHub state until you finish or need me.');
  assert.ok(Array.isArray(bundledConfig.projects));
  assert.ok(bundledConfig.projects.includes('campaign desk'));
  assert.ok(bundledConfig.projects.includes('notifier extension'));
  assert.equal(new Set(bundledConfig.projects.map((value) => value.toLowerCase())).size, bundledConfig.projects.length);
});

test('prompt formatter uses configurable Continue and Project text', () => {
  const context = { globalThis: {}, Intl, Date };
  context.globalThis = context;
  vm.runInNewContext(promptSource, context);

  const api = context.ChatGPTQuickContinuePrompts;
  const date = new Date('2026-09-18T09:20:00-04:00');

  const normal = api.continuePrompt('Keep going please.', date);
  const project = api.projectContinuePrompt(
    '  campaign   desk  ',
    'Resume {project} from canonical GitHub state.',
    date
  );

  assert.equal(normal, '[Sep 18, 9:20 AM] Keep going please.');
  assert.equal(project, '[Sep 18, 9:20 AM] Resume campaign desk from canonical GitHub state.');
  assert.equal(api.projectContinuePrompt('campaign desk', 'No placeholder here.', date), '');
});

test('send path still clicks the real ChatGPT Send button at most once', () => {
  assert.match(contentSource, /button\[data-testid="send-button"\]/);
  assert.match(contentSource, /sendButton\.click\(\)/);
  assert.equal((contentSource.match(/sendButton\.click\(\)/g) || []).length, 1);
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

test('prompt and config APIs are versioned so reinjection cannot retain stale globals indefinitely', () => {
  assert.match(promptSource, /const RUNTIME_VERSION = 2/);
  assert.match(promptSource, /runtimeVersion: RUNTIME_VERSION/);
  assert.match(configSource, /const RUNTIME_VERSION = 2/);
  assert.match(configSource, /previousRuntime\?\.dispose\?\.\(\)/);
  assert.match(configSource, /runtimeVersion: RUNTIME_VERSION/);
  assert.match(configSource, /chrome\.storage\.onChanged\.addListener\(handleStorageChanged\)/);
  assert.match(configSource, /chrome\.storage\.onChanged\.removeListener\(handleStorageChanged\)/);
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

test('config controller loads bundled JSON only from the extension and validates project template', async () => {
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
          addListener: (listener) => changeListeners.push(listener)
        }
      }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(configSource, context);

  const api = context.ChatGPTQuickContinueConfig;
  const initial = await api.load();
  assert.equal(initial.continueText, bundledConfig.continueText);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'chrome-extension://quick-continue/config.json');

  let observed = null;
  api.subscribe((config) => { observed = config; });
  const saved = await api.save({
    continueText: 'Continue this work.',
    projectText: 'Continue {project} now.',
    projects: ['Campaign Desk', 'campaign desk', 'Time Tracker']
  });

  assert.equal(saved.continueText, 'Continue this work.');
  assert.equal(saved.projectText, 'Continue {project} now.');
  assert.deepEqual([...saved.projects], ['Campaign Desk', 'Time Tracker']);
  assert.equal(observed.continueText, 'Continue this work.');

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

test('installer copies live config files and removes the legacy projects JSON', () => {
  assert.match(installerSource, /LOCALAPPDATA/);
  assert.match(installerSource, /ChatGPTQuickContinue\\Extension/);
  assert.match(installerSource, /'config\.js'/);
  assert.match(installerSource, /'config\.json'/);
  assert.match(installerSource, /'projects\.json'/);
  assert.match(installerSource, /Remove-Item -LiteralPath \$legacyProjects -Force/);
  assert.doesNotMatch(installerSource, /Set-ItemProperty|New-ItemProperty|reg\.exe|HKCU:|HKLM:/i);
  assert.doesNotMatch(installerSource, /Start-Process|chrome\.exe/i);
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

test('standalone runtime hot-replaces stale generations, restores a detached toolbar, and ignores notifier-only churn', () => {
  assert.match(contentSource, /const RUNTIME_VERSION = 5/);
  assert.match(contentSource, /const previousRuntime = globalThis\.__chatgptQuickContinueRuntime/);
  assert.match(contentSource, /previousRuntime\?\.dispose\?\.\(\)/);
  assert.doesNotMatch(contentSource, /__chatgptQuickContinueInstalled/);
  assert.match(contentSource, /if \(!root\.isConnected\)/);
  assert.match(contentSource, /\(document\.body \|\| document\.documentElement\)\.append\(root\)/);
  assert.match(contentSource, /const NOTIFIER_MUTATION_SELECTOR/);
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
