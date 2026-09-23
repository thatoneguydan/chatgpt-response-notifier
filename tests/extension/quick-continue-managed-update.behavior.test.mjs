import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const feed = read('src/ChatGPTResponseNotifier.Core/QuickContinueUpdateFeed.cs');
const installer = read('src/ChatGPTResponseNotifier.Core/QuickContinueBundleInstaller.cs');
const service = read('src/ChatGPTResponseNotifier.Host/QuickContinueUpdateService.cs');
const bridge = read('src/ChatGPTResponseNotifier.Host/LocalBridgeServer.cs');
const app = read('src/ChatGPTResponseNotifier.Host/NativeHostApplication.cs');
const workflow = read('.github/workflows/quick-continue-release.yml');

test('Quick Continue feed is pinned to the canonical release route and digest', () => {
  assert.match(feed, /standalone-quick-continue\/update\/manifest\.json/);
  assert.match(feed, /github\.com/);
  assert.match(feed, /ChatGPT-Quick-Continue-/);
  assert.match(feed, /sha256/i);
  assert.match(feed, /SourceCommit/);
});

test('helper updates only the fixed Quick Continue user-profile root and preserves config', () => {
  assert.match(installer, /ChatGPTQuickContinue/);
  assert.match(installer, /Extension/);
  assert.match(installer, /CHATGPT_QUICK_CONTINUE_INSTALL_ROOT/);
  assert.match(installer, /config\.json/);
  assert.match(installer, /manifest\.json/);
  assert.match(installer, /File\.Copy\(Path\.Combine\(source, "manifest\.json"\)/);
  assert.match(installer, /rollback/);
  assert.doesNotMatch(installer, /Process\.Start|Registry|chrome\.exe/i);
});

test('loopback Quick Continue endpoint is narrow and does not relax privileged bridge origin checks', () => {
  assert.match(bridge, /"\/quick-continue\/update"/);
  assert.match(bridge, /HttpMethods\.IsGet/);
  assert.match(bridge, /QuickContinueBundleInstaller\.ReadInstalledVersion/);
  assert.match(bridge, /LocalBridgeConstants\.ExtensionOrigin/);
  assert.match(bridge, /StatusCodes\.Status403Forbidden/);
  assert.doesNotMatch(bridge, /ListenAnyIP|IPAddress\.Any/);
});

test('notifier helper checks Quick Continue independently before its own replacement update', () => {
  assert.match(service, /QuickContinueUpdateFeed\.ManifestUrl/);
  assert.match(service, /QuickContinueBundleInstaller\.InstallArchive/);
  assert.match(app, /new QuickContinueUpdateService\(\)/);
  assert.match(app, /CheckForQuickContinueUpdateEndpointAsync/);
  assert.match(app, /await CheckForQuickContinueUpdateEndpointAsync\(_shutdown\.Token\)/);
  assert.match(app, /await CheckForPublicUpdateAsync\(null\)/);
});

test('release workflow publishes a hashed standalone runtime package and update manifest', () => {
  assert.match(workflow, /ChatGPT-Quick-Continue-\$version\.zip/);
  assert.match(workflow, /Get-FileHash -LiteralPath \$zip -Algorithm SHA256/);
  assert.match(workflow, /quick-continue-v\$version/);
  assert.match(workflow, /standalone-quick-continue\\update/);
  assert.match(workflow, /sourceCommit = \$sourceCommit/);
});
