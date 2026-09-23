import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const extensionRoot = path.join(repoRoot, 'standalone-quick-continue');
const updaterSource = fs.readFileSync(path.join(extensionRoot, 'Update-Installed-1.2.7.ps1'), 'utf8');

test('1.2.7 updater pins the manual timestamp runtime without overwriting live config defaults', () => {
  assert.match(updaterSource, /\$commit = '1b5e9c7c5fb9a37103c75ed1c1559378b64f0d62'/);
  assert.match(updaterSource, /expected 1\.2\.7/);
  for (const file of ['manifest.json', 'prompt-format.js', 'config.js', 'content-script.js', 'hover-edit-script.js', 'README.md']) {
    assert.match(updaterSource, new RegExp(file.replace('.', '\\.') ));
  }
  assert.doesNotMatch(updaterSource, /\$files\s*=\s*@\([^\r\n]*config\.json/);
  assert.match(updaterSource, /requiresChromeExtensionReload\s*=\s*\$true/);
  assert.match(updaterSource, /requiresChatGptPageReload\s*=\s*\$true/);
  assert.match(updaterSource, /Get-FileHash -Algorithm SHA256/);
});
