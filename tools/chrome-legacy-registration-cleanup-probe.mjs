import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const EXPECTED_STABLE_ID = 'lciedmoiiapbgemklkpoadimhffaaaah';
const DISABLE_RELOAD = 4;

const extensionSource = path.resolve(process.argv[2] ?? '');
const probeRoot = path.resolve(process.argv[3] ?? '');
const browserExecutablePath = path.resolve(process.argv[4] ?? '');
const outputPath = path.resolve(process.argv[5] ?? '');
const extensionPath = path.join(probeRoot, 'extension-root');
const profilePath = path.join(probeRoot, 'chrome-profile');
const manifestPath = path.join(extensionPath, 'manifest.json');
const sourceManifestPath = path.join(extensionSource, 'manifest.json');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function extensionIdFromKey(key) {
  const digest = crypto.createHash('sha256').update(Buffer.from(String(key), 'base64')).digest();
  const alphabet = 'abcdefghijklmnop';
  let id = '';
  for (let index = 0; index < 16; index += 1) {
    id += alphabet[digest[index] >> 4];
    id += alphabet[digest[index] & 0x0f];
  }
  return id;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function normalizedPath(value) {
  try { return path.resolve(String(value ?? '')).replace(/[\\/]+$/, '').toLowerCase(); }
  catch { return ''; }
}

function findSetting(extensionId) {
  for (const fileName of ['Secure Preferences', 'Preferences']) {
    const filePath = path.join(profilePath, 'Default', fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const setting = readJson(filePath)?.extensions?.settings?.[extensionId];
      if (setting && typeof setting === 'object') return setting;
    } catch {}
  }
  return null;
}

function settingSummary(extensionId) {
  const setting = findSetting(extensionId);
  const rawPath = typeof setting?.path === 'string' ? setting.path : '';
  return {
    present: Boolean(setting),
    disableReasonCodes: Array.isArray(setting?.disable_reasons)
      ? setting.disable_reasons.filter(Number.isInteger).slice(0, 16)
      : [],
    sameDisposableRoot: rawPath ? normalizedPath(rawPath) === normalizedPath(extensionPath) : null,
  };
}

async function waitForExtension(browser, extensionId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const extension = (await browser.extensions()).get(extensionId);
    if (extension) return extension;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

async function waitForWorker(extension, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const workers = await extension.workers();
    if (workers.length > 0) return workers[0];
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

async function closeBrowser(browser) {
  if (!browser) return;
  await browser.close().catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 500));
}

let browser;
try {
  assert(fs.existsSync(sourceManifestPath), 'source-extension-manifest-missing');
  assert(fs.existsSync(browserExecutablePath), 'system-chrome-executable-missing');

  const sourceHashBefore = sha256File(sourceManifestPath);
  fs.rmSync(probeRoot, { recursive: true, force: true });
  fs.mkdirSync(probeRoot, { recursive: true });
  fs.cpSync(extensionSource, extensionPath, { recursive: true });

  const keyedManifest = readJson(manifestPath);
  const fixedKey = String(keyedManifest.key ?? '').trim();
  assert(fixedKey, 'canonical-manifest-key-missing');
  const stableId = extensionIdFromKey(fixedKey);
  assert(stableId === EXPECTED_STABLE_ID, `canonical-stable-id-mismatch:${stableId}`);

  const unkeyedManifest = { ...keyedManifest };
  delete unkeyedManifest.key;
  writeJson(manifestPath, unkeyedManifest);

  browser = await puppeteer.launch({
    executablePath: browserExecutablePath,
    headless: true,
    userDataDir: profilePath,
    enableExtensions: true,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-default-apps',
      '--metrics-recording-only',
      '--no-pings',
      'about:blank',
    ],
  });

  const browserVersion = await browser.version();
  const legacyId = await browser.installExtension(extensionPath);
  assert(legacyId && legacyId !== stableId, `legacy-id-not-distinct:${legacyId}`);
  const legacyExtension = await waitForExtension(browser, legacyId);
  assert(legacyExtension, 'legacy-extension-not-listed');
  const worker = await waitForWorker(legacyExtension);
  assert(worker, 'legacy-worker-not-available');

  writeJson(manifestPath, keyedManifest);
  await worker.evaluate(() => chrome.runtime.reload());
  const stableExtension = await waitForExtension(browser, stableId);
  assert(stableExtension, 'stable-extension-not-loaded-after-identity-changing-reload');

  // Chrome's own extension manager knows the old ID even if the protected
  // preference store has not flushed the DISABLE_RELOAD record to disk yet.
  // Remove exactly that old ID through Chrome, never by editing preference JSON.
  await browser.uninstallExtension(legacyId);
  await new Promise(resolve => setTimeout(resolve, 1000));
  const stableRuntimeAfterCleanup = Boolean((await browser.extensions()).get(stableId));
  assert(stableRuntimeAfterCleanup, 'stable-runtime-lost-during-legacy-uninstall');

  await closeBrowser(browser);
  browser = null;

  const legacyAfter = settingSummary(legacyId);
  const stableAfter = settingSummary(stableId);
  const sourceHashAfter = sha256File(sourceManifestPath);
  const selectiveCleanupSucceeded = !legacyAfter.present
    && stableAfter.present
    && stableAfter.sameDisposableRoot === true
    && stableRuntimeAfterCleanup
    && sourceHashBefore === sourceHashAfter;

  const evidence = {
    schemaVersion: 1,
    capability: 'chrome-legacy-registration-cleanup-disposable-v1',
    observedAtUtc: new Date().toISOString(),
    disposableProfile: true,
    liveChromeProfileAccessed: false,
    liveChromeRegistrationMutated: false,
    chatGptNavigationPerformed: false,
    cleanupMethod: 'chrome-extensions-uninstall',
    browserVersion,
    stableId,
    legacyId,
    disableReloadCode: DISABLE_RELOAD,
    stableRuntimeAfterCleanup,
    legacyAfter,
    stableAfter,
    sourceManifestHashPreserved: sourceHashBefore === sourceHashAfter,
    selectiveCleanupSucceeded,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  writeJson(outputPath, evidence);
  console.log(`LEGACY_CLEANUP browser=${browserVersion}; legacy=${legacyId}; stable=${stableId}; legacyPresentAfter=${legacyAfter.present}; stablePresentAfter=${stableAfter.present}; stableRootAfter=${stableAfter.sameDisposableRoot}; stableRuntimeAfter=${stableRuntimeAfterCleanup}; selective=${selectiveCleanupSucceeded}`);
  assert(selectiveCleanupSucceeded, 'selective-cleanup-postcondition-failed');
} catch (error) {
  console.error(`LEGACY_CLEANUP_FAILURE ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closeBrowser(browser);
}
