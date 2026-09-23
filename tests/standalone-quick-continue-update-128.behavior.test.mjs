import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const extensionRoot = path.join(repoRoot, 'standalone-quick-continue');
const updaterSource = fs.readFileSync(path.join(extensionRoot, 'Update-Installed-1.2.8.ps1'), 'utf8');

test('1.2.8 updater pins the per-chat timestamp runtime without overwriting live config defaults', () => {
  assert.match(updaterSource, /\$commit = '23b1b4b86c326e03673eb6660d5ddbf418bdb9f6'/);
  assert.match(updaterSource, /expected 1\.2\.8/);
  for (const file of ['manifest.json', 'prompt-format.js', 'config.js', 'content-script.js', 'hover-edit-script.js', 'conversation-state.js', 'README.md']) {
    assert.match(updaterSource, new RegExp(file.replace('.', '\\.') ));
  }
  assert.doesNotMatch(updaterSource, /\$files\s*=\s*@\([^\r\n]*config\.json/);
  assert.match(updaterSource, /requiresChromeExtensionReload\s*=\s*\$true/);
  assert.match(updaterSource, /requiresChatGptPageReload\s*=\s*\$true/);
  assert.match(updaterSource, /Get-FileHash -Algorithm SHA256/);
});
