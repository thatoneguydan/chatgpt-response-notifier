import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readText = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

test('new notifier payload uses a permanent distinct root while preserving the legacy collision root', () => {
  const installer = readText('src/ChatGPTResponseNotifier.Core/NativeHostInstaller.cs');
  const bundle = readText('src/ChatGPTResponseNotifier.Core/BundleInstaller.cs');
  const bundleBuilder = readText('Build-TestBundle.ps1');
  const validate = readText('.github/workflows/validate.yml');

  assert.match(installer, /LegacyExtensionRoot\s*=>\s*Path\.Combine\(InstallRoot,\s*"Extension"\)/);
  assert.match(installer, /ExtensionRoot\s*=>\s*Path\.Combine\(InstallRoot,\s*"Extension-v2"\)/);
  assert.doesNotMatch(installer, /ExtensionRoot\s*=>\s*Path\.Combine\(InstallRoot,\s*"Extension",\s*[^)]/);

  assert.match(bundle, /UpdateDirectoryPreservingRoot\(bundledExtension, NativeHostInstaller\.ExtensionRoot\)/);
  assert.doesNotMatch(bundle, /UpdateDirectoryPreservingRoot\(bundledExtension, NativeHostInstaller\.LegacyExtensionRoot\)/);
  assert.doesNotMatch(bundle, /Directory\.Delete\(NativeHostInstaller\.LegacyExtensionRoot/);
  assert.doesNotMatch(bundle, /Directory\.Move\(NativeHostInstaller\.LegacyExtensionRoot/);

  assert.match(bundleBuilder, /extensionRootName\s*=\s*'Extension-v2'/);

  assert.match(validate, /legacy-root-must-remain-untouched/);
  assert.match(validate, /Extension-v2/);
  assert.match(validate, /wrote the notifier payload into the legacy extension root/);
  assert.match(validate, /install-state extension path did not move to the new stable root/);
});