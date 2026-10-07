import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const feed = read('src/ChatGPTResponseNotifier.Core/QuickContinueUpdateFeed.cs');
const publicFeed = read('src/ChatGPTResponseNotifier.Core/PublicUpdateFeed.cs');
const installer = read('src/ChatGPTResponseNotifier.Core/QuickContinueBundleInstaller.cs');
const service = read('src/ChatGPTResponseNotifier.Host/QuickContinueUpdateService.cs');
const publicUpdateService = read('src/ChatGPTResponseNotifier.Host/PublicUpdateService.cs');
const manifestClient = read('src/ChatGPTResponseNotifier.Host/FreshGitHubManifestClient.cs');
const bridge = read('src/ChatGPTResponseNotifier.Host/LocalBridgeServer.cs');
const app = read('src/ChatGPTResponseNotifier.Host/NativeHostApplication.cs');
const quickWorkflow = read('.github/workflows/quick-continue-release.yml');
const notifierWorkflow = read('.github/workflows/release.yml');

test('Quick Continue feed is pinned to the canonical GitHub contents API and release route', () => {
  assert.match(feed, /api\.github\.com\/repos\/thatoneguydan\/chatgpt-response-notifier\/contents\/standalone-quick-continue\/update\/manifest\.json/);
  assert.match(feed, /ChatGPT-Quick-Continue-/);
  assert.match(feed, /sha256/i);
  assert.match(feed, /SourceCommit/);
});

test('notifier feed uses the same canonical GitHub contents API authority', () => {
  assert.match(publicFeed, /api\.github\.com\/repos\/thatoneguydan\/chatgpt-response-notifier\/contents\/update\/manifest\.json/);
  assert.doesNotMatch(publicFeed, /raw\.githubusercontent\.com/);
});

test('managed feed checks use isolated connections and GitHub raw-content media type', () => {
  assert.match(manifestClient, /new SocketsHttpHandler/);
  assert.match(manifestClient, /PooledConnectionLifetime = TimeSpan\.Zero/);
  assert.match(manifestClient, /PooledConnectionIdleTimeout = TimeSpan\.Zero/);
  assert.match(manifestClient, /cacheBust=\{DateTimeOffset\.UtcNow\.ToUnixTimeMilliseconds\(\)\}/);
  assert.match(manifestClient, /application\/vnd\.github\.raw\+json/);
  assert.match(manifestClient, /X-GitHub-Api-Version/);
  assert.match(manifestClient, /2022-11-28/);
  assert.match(manifestClient, /NoCache = true/);
  assert.match(manifestClient, /NoStore = true/);
  assert.match(manifestClient, /ConnectionClose = true/);
  assert.match(manifestClient, /HttpCompletionOption\.ResponseContentRead/);
});

test('Quick Continue and notifier updates both use the isolated manifest authority', () => {
  assert.match(service, /FreshGitHubManifestClient\.GetRawAsync/);
  assert.match(service, /QuickContinueUpdateFeed\.ManifestUrl/);
  assert.match(publicUpdateService, /FreshGitHubManifestClient\.GetRawAsync/);
  assert.match(publicUpdateService, /PublicUpdateFeed\.ManifestUrl/);
  assert.doesNotMatch(service, /_http\.GetAsync\(QuickContinueUpdateFeed\.ManifestUrl/);
  assert.doesNotMatch(publicUpdateService, /_http\.GetAsync\(PublicUpdateFeed\.ManifestUrl/);
});

test('explicit Quick Continue update requests wait for an active check then perform a fresh check', () => {
  assert.match(service, /await _gate\.WaitAsync\(cancellationToken\)\.ConfigureAwait\(false\)/);
  assert.doesNotMatch(service, /WaitAsync\(0, cancellationToken\)/);
  assert.match(service, /every waiting caller performs its own authoritative/);
  const gateIndex = service.indexOf('await _gate.WaitAsync(cancellationToken)');
  const fetchIndex = service.indexOf('FreshGitHubManifestClient.GetRawAsync', gateIndex);
  assert.ok(gateIndex >= 0 && fetchIndex > gateIndex);
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

test('release workflow publishes a hashed standalone runtime package with both independent watchdog engines', () => {
  assert.match(quickWorkflow, /ChatGPT-Quick-Continue-\$version\.zip/);
  assert.match(quickWorkflow, /Get-FileHash -LiteralPath \$zip -Algorithm SHA256/);
  assert.match(quickWorkflow, /quick-continue-v\$version/);
  assert.match(quickWorkflow, /standalone-quick-continue\\update/);
  assert.match(quickWorkflow, /sourceCommit = \$sourceCommit/);
  assert.match(quickWorkflow, /'monitor-watchdog-background\.js'/);
  assert.match(quickWorkflow, /'monitor-watchdog\.js'/);
  assert.match(quickWorkflow, /'conversation-state\.js'/);
});

test('release feeds use independent serialized queues and rebase feed-only commits onto current main', () => {
  assert.match(notifierWorkflow, /group: chatgpt-extension-release-publish/);
  assert.match(quickWorkflow, /group: quick-continue-release-publish/);
  assert.doesNotMatch(quickWorkflow, /group: chatgpt-extension-release-publish/);

  for (const workflow of [quickWorkflow, notifierWorkflow]) {
    assert.match(workflow, /cancel-in-progress: false/);
    assert.match(workflow, /git fetch origin main/);
    assert.match(workflow, /origin\/main/);
    assert.match(workflow, /git push origin HEAD:main/);
  }
  assert.match(quickWorkflow, /gh release download \$tag --pattern \$assetName/);
  assert.doesNotMatch(quickWorkflow, /already exists for a different source commit/);
});
