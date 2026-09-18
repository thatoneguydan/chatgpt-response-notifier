import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

process.env.TZ = 'America/New_York';

const repoRoot = path.resolve(import.meta.dirname, '..');
const extensionRoot = path.join(repoRoot, 'standalone-quick-continue');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
const promptSource = fs.readFileSync(path.join(extensionRoot, 'prompt-format.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(extensionRoot, 'content-script.js'), 'utf8');
const installerSource = fs.readFileSync(path.join(extensionRoot, 'Install.ps1'), 'utf8');

test('standalone extension has no background or network permissions', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.permissions, undefined);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://chatgpt.com/*']);
});

test('prompt text uses the requested timestamp and exact wording without markdown', () => {
  const context = {
    globalThis: {},
    Intl,
    Date
  };
  context.globalThis = context;
  vm.runInNewContext(promptSource, context);

  const api = context.ChatGPTQuickContinuePrompts;
  const date = new Date('2026-09-18T09:20:00-04:00');

  const normal = api.continuePrompt(date);
  const project = api.projectContinuePrompt('  campaign   desk  ', date);

  assert.match(normal, /^\[Sep 18, 9:20 AM\] Continue until you finish or need something from me\.$/);
  assert.match(project, /^\[Sep 18, 9:20 AM\] Continue campaign desk from canonical GitHub state until you finish or need me\.$/);
  assert.equal(project.includes('**'), false);
});

test('send path targets the real ChatGPT send button and has no retry click loop', () => {
  assert.match(contentSource, /button\[data-testid="send-button"\]/);
  assert.match(contentSource, /sendButton\.click\(\)/);
  assert.equal((contentSource.match(/sendButton\.click\(\)/g) || []).length, 1);
  assert.doesNotMatch(contentSource, /chrome\.runtime/);
  assert.doesNotMatch(contentSource, /fetch\(/);
  assert.doesNotMatch(contentSource, /XMLHttpRequest/);
  assert.doesNotMatch(contentSource, /WebSocket/);
  assert.match(contentSource, /chatgpt-notifier-quick-prompts/);
});

test('project field is non-modal and does not auto-focus or trap focus', () => {
  assert.match(contentSource, /placeholder = 'Project name…'/);
  assert.doesNotMatch(contentSource, /\.focus\(/);
  assert.match(contentSource, /event\.key === 'Escape'/);
  assert.match(contentSource, /event\.key === 'Enter'/);
  assert.doesNotMatch(contentSource, /\.title\s*=/);
});

test('installer uses a stable local path without policy, registry, or process side effects', () => {
  assert.match(installerSource, /LOCALAPPDATA/);
  assert.match(installerSource, /ChatGPTQuickContinue\\Extension/);
  assert.doesNotMatch(installerSource, /Set-ItemProperty|New-ItemProperty|reg\.exe|HKCU:|HKLM:/i);
  assert.doesNotMatch(installerSource, /Start-Process|chrome\.exe/i);
});
