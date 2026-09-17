import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const EXPECTED_STABLE_ID = 'lciedmoiiapbgemklkpoadimhffaaaah';
const PROFILE_IN_USE_EXIT_CODE = 21;

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
  await new Promise(resolve => setTimeout(resolve, 750));
}

function runChromeUninstall(legacyId) {
  return spawnSync(
    browserExecutablePath,
    [
      `--user-data-dir=${profilePath}`,
      '--profile-directory=Default',
      `--uninstall-extension=${legacyId}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
    { encoding: 'utf8', timeout: 15000, windowsHide: true },
  );
}

function launchDisposableProfile() {
  return puppeteer.launch({
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

  browser = await launchDisposableProfile();
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

  // Chrome 153 must fail closed while this profile is still in use. This is
  // evidence that a live-profile CLI repair is not a safe production route.
  const openProfileCommand = runChromeUninstall(legacyId);
  assert(!openProfileCommand.error, `open-profile-cli-launch-failed:${openProfileCommand.error?.message ?? 'unknown'}`);
  assert(openProfileCommand.status === PROFILE_IN_USE_EXIT_CODE,
    `open-profile-cli-unexpected-exit:${openProfileCommand.status ?? 'null'}`);
  assert(Boolean((await browser.extensions()).get(stableId)), 'stable-runtime-lost-after-open-profile-refusal');

  // The one-shot candidate is intentionally limited to a cleanly closed
  // profile. Chrome itself owns the uninstall; no preference JSON is edited.
  await closeBrowser(browser);
  browser = null;

  const legacyBeforeClosedCleanup = settingSummary(legacyId);
  const stableBeforeClosedCleanup = settingSummary(stableId);
  assert(legacyBeforeClosedCleanup.present, 'legacy-registration-missing-before-closed-profile-cleanup');
  assert(stableBeforeClosedCleanup.present, 'stable-registration-missing-before-closed-profile-cleanup');

  const closedProfileCommand = runChromeUninstall(legacyId);
  assert(!closedProfileCommand.error, `closed-profile-cli-launch-failed:${closedProfileCommand.error?.message ?? 'unknown'}`);
  assert(closedProfileCommand.status === 0,
    `closed-profile-cli-exit:${closedProfileCommand.status ?? 'null'}`);

  const legacyAfterClosedCleanup = settingSummary(legacyId);
  const stableAfterClosedCleanup = settingSummary(stableId);
  assert(!legacyAfterClosedCleanup.present, 'legacy-registration-remained-after-closed-profile-cli-uninstall');
  assert(stableAfterClosedCleanup.present, 'stable-registration-lost-after-closed-profile-cli-uninstall');
  assert(stableAfterClosedCleanup.sameDisposableRoot === true, 'stable-registration-root-changed-after-closed-profile-cli-uninstall');

  // Reopen the same profile without installing or re-registering the extension.
  // A pass proves the repaired persisted state can survive normal startup.
  browser = await launchDisposableProfile();
  const stableAfterReopen = await waitForExtension(browser, stableId);
  const legacyAfterReopen = (await browser.extensions()).get(legacyId);
  const stableRuntimeAfterReopen = Boolean(stableAfterReopen);
  const legacyRuntimeAfterReopen = Boolean(legacyAfterReopen);
  assert(stableRuntimeAfterReopen, 'stable-runtime-not-loaded-after-reopen');
  assert(!legacyRuntimeAfterReopen, 'legacy-runtime-returned-after-reopen');

  await closeBrowser(browser);
  browser = null;

  const legacyFinal = settingSummary(legacyId);
  const stableFinal = settingSummary(stableId);
  const sourceHashAfter = sha256File(sourceManifestPath);
  const selectiveCleanupSucceeded = !legacyFinal.present
    && stableFinal.present
    && stableFinal.sameDisposableRoot === true
    && stableRuntimeAfterReopen
    && !legacyRuntimeAfterReopen
    && sourceHashBefore === sourceHashAfter;

  const evidence = {
    schemaVersion: 2,
    capability: 'chrome-legacy-registration-cli-cleanup-disposable-v2',
    observedAtUtc: new Date().toISOString(),
    disposableProfile: true,
    liveChromeProfileAccessed: false,
    liveChromeRegistrationMutated: false,
    chatGptNavigationPerformed: false,
    cleanupMethod: 'chrome-command-line-uninstall-closed-disposable-profile',
    browserVersion,
    stableId,
    legacyId,
    openProfileCommandExitStatus: openProfileCommand.status,
    openProfileRefusedAsProfileInUse: openProfileCommand.status === PROFILE_IN_USE_EXIT_CODE,
    legacyBeforeClosedCleanup,
    stableBeforeClosedCleanup,
    closedProfileCommandExitStatus: closedProfileCommand.status,
    legacyAfterClosedCleanup,
    stableAfterClosedCleanup,
    stableRuntimeAfterReopen,
    legacyRuntimeAfterReopen,
    legacyFinal,
    stableFinal,
    sourceManifestHashPreserved: sourceHashBefore === sourceHashAfter,
    selectiveCleanupSucceeded,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  writeJson(outputPath, evidence);
  console.log(`LEGACY_CLI_CLEANUP browser=${browserVersion}; legacy=${legacyId}; stable=${stableId}; openExit=${openProfileCommand.status}; closedExit=${closedProfileCommand.status}; legacyFinal=${legacyFinal.present}; stableFinal=${stableFinal.present}; stableRoot=${stableFinal.sameDisposableRoot}; stableRuntimeAfterReopen=${stableRuntimeAfterReopen}; legacyRuntimeAfterReopen=${legacyRuntimeAfterReopen}; selective=${selectiveCleanupSucceeded}`);
  assert(selectiveCleanupSucceeded, 'selective-cli-cleanup-postcondition-failed');
} catch (error) {
  console.error(`LEGACY_CLI_CLEANUP_FAILURE ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closeBrowser(browser);
}
