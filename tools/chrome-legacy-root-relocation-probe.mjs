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
const legacyRoot = path.join(probeRoot, 'legacy-root');
const relocatedRoot = path.join(probeRoot, 'relocated-root');
const profilePath = path.join(probeRoot, 'chrome-profile');
const legacyManifestPath = path.join(legacyRoot, 'manifest.json');
const relocatedManifestPath = path.join(relocatedRoot, 'manifest.json');
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
    pointsAtLegacyRoot: rawPath ? normalizedPath(rawPath) === normalizedPath(legacyRoot) : null,
    pointsAtRelocatedRoot: rawPath ? normalizedPath(rawPath) === normalizedPath(relocatedRoot) : null,
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
  await new Promise(resolve => setTimeout(resolve, 750));
}

function launchOptions() {
  return {
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
  };
}

let browser;
try {
  assert(fs.existsSync(sourceManifestPath), 'source-extension-manifest-missing');
  assert(fs.existsSync(browserExecutablePath), 'system-chrome-executable-missing');

  const sourceHashBefore = sha256File(sourceManifestPath);
  fs.rmSync(probeRoot, { recursive: true, force: true });
  fs.mkdirSync(probeRoot, { recursive: true });
  fs.cpSync(extensionSource, legacyRoot, { recursive: true });
  fs.cpSync(extensionSource, relocatedRoot, { recursive: true });

  const keyedManifest = readJson(legacyManifestPath);
  const fixedKey = String(keyedManifest.key ?? '').trim();
  assert(fixedKey, 'canonical-manifest-key-missing');
  const stableId = extensionIdFromKey(fixedKey);
  assert(stableId === EXPECTED_STABLE_ID, `canonical-stable-id-mismatch:${stableId}`);
  assert(extensionIdFromKey(String(readJson(relocatedManifestPath).key ?? '').trim()) === stableId, 'relocated-root-key-id-mismatch');

  // Reproduce the exact stale-registration mechanism from PR #73 in a disposable
  // profile: identity changes underneath chrome.runtime.reload(), leaving the old
  // ID disabled with DISABLE_RELOAD while the fixed-key ID becomes live.
  const unkeyedManifest = { ...keyedManifest };
  delete unkeyedManifest.key;
  writeJson(legacyManifestPath, unkeyedManifest);

  browser = await puppeteer.launch(launchOptions());
  const browserVersion = await browser.version();
  const legacyId = await browser.installExtension(legacyRoot);
  assert(legacyId && legacyId !== stableId, `legacy-id-not-distinct:${legacyId}`);
  const legacyExtension = await waitForExtension(browser, legacyId);
  assert(legacyExtension, 'legacy-extension-not-listed');
  const worker = await waitForWorker(legacyExtension);
  assert(worker, 'legacy-worker-not-available');

  writeJson(legacyManifestPath, keyedManifest);
  await worker.evaluate(() => chrome.runtime.reload());
  const stableAtLegacyRoot = await waitForExtension(browser, stableId);
  assert(stableAtLegacyRoot, 'stable-extension-not-loaded-after-identity-changing-reload');

  await closeBrowser(browser);
  browser = null;

  const legacyOrphan = settingSummary(legacyId);
  assert(legacyOrphan.present, 'legacy-registration-not-persisted-after-reproduction');
  assert(legacyOrphan.disableReasonCodes.includes(DISABLE_RELOAD), 'legacy-registration-missing-disable-reload');
  assert(legacyOrphan.pointsAtLegacyRoot === true, 'legacy-registration-root-mismatch');

  // Reopen the same disposable profile. The stale pref record must not be a live
  // registry object, matching the production pref-only orphan boundary.
  browser = await puppeteer.launch(launchOptions());
  const legacyVisibleBeforeRelocation = Boolean((await browser.extensions()).get(legacyId));
  assert(!legacyVisibleBeforeRelocation, 'legacy-id-unexpectedly-visible-before-relocation');

  // This is deliberately only a path-separation proof. DevTools/Puppeteer test
  // installs are not accepted as restart-persistence evidence. We use them here
  // only to ask the same Chrome build whether the canonical fixed-key extension
  // can be live from a distinct root while the stale orphan remains non-live.
  const relocatedId = await browser.installExtension(relocatedRoot);
  assert(relocatedId === stableId, `relocated-install-id-mismatch:${relocatedId}`);
  const relocatedExtension = await waitForExtension(browser, stableId);
  assert(relocatedExtension, 'stable-extension-not-visible-after-relocation');
  const relocatedRuntimePathMatches = normalizedPath(relocatedExtension.path) === normalizedPath(relocatedRoot);
  assert(relocatedRuntimePathMatches, 'stable-runtime-path-did-not-relocate');
  const legacyVisibleAfterRelocation = Boolean((await browser.extensions()).get(legacyId));
  assert(!legacyVisibleAfterRelocation, 'legacy-orphan-became-live-during-relocation');

  await closeBrowser(browser);
  browser = null;

  // Observe but do not interpret the persisted state after this DevTools test
  // session. Chrome may prune synthetic DevTools-installed registrations when the
  // session closes. Production's stale orphan came from normal unpacked loading,
  // so post-close retention here is not evidence for or against the real repair.
  const legacyAfterRelocation = settingSummary(legacyId);

  const sourceHashAfter = sha256File(sourceManifestPath);
  const relocationAcceptanceProven = legacyOrphan.present
    && legacyOrphan.pointsAtLegacyRoot === true
    && !legacyVisibleBeforeRelocation
    && relocatedRuntimePathMatches
    && !legacyVisibleAfterRelocation
    && sourceHashBefore === sourceHashAfter;

  const evidence = {
    schemaVersion: 1,
    capability: 'chrome-legacy-root-relocation-disposable-v1',
    observedAtUtc: new Date().toISOString(),
    disposableProfile: true,
    liveChromeProfileAccessed: false,
    liveChromeRegistrationMutated: false,
    chatGptNavigationPerformed: false,
    cleanupAttempted: false,
    browserVersion,
    stableId,
    legacyId,
    disableReloadCode: DISABLE_RELOAD,
    legacyVisibleBeforeRelocation,
    legacyVisibleAfterRelocation,
    relocatedRuntimePathMatches,
    legacyOrphan,
    legacyAfterRelocation,
    legacyPreferenceRetentionAfterDevToolsSession: legacyAfterRelocation.present,
    postClosePreferenceResultInterpretable: false,
    devToolsTeardownMayPruneSyntheticRegistrations: true,
    sourceManifestHashPreserved: sourceHashBefore === sourceHashAfter,
    relocationAcceptanceProven,
    testInstallProvenance: 'devtools-test-only',
    restartDurabilityProven: false,
    realAcceptanceRequiresManualLoadUnpacked: true,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  writeJson(outputPath, evidence);
  console.log(`LEGACY_ROOT_RELOCATION browser=${browserVersion}; legacy=${legacyId}; stable=${stableId}; legacyLiveBefore=${legacyVisibleBeforeRelocation}; stableRelocatedPath=${relocatedRuntimePathMatches}; legacyLiveAfter=${legacyVisibleAfterRelocation}; postCloseLegacyPresent=${legacyAfterRelocation.present}; postCloseInterpretable=false; accepted=${relocationAcceptanceProven}`);
  assert(relocationAcceptanceProven, 'root-relocation-acceptance-postcondition-failed');
} catch (error) {
  console.error(`LEGACY_ROOT_RELOCATION_FAILURE ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closeBrowser(browser);
}
