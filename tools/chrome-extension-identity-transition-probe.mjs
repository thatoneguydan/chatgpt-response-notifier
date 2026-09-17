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

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizedPath(value) {
  try { return path.resolve(String(value ?? '')).replace(/[\\/]+$/, '').toLowerCase(); }
  catch { return ''; }
}

function settingsFiles() {
  return [
    ['secure-preferences', path.join(profilePath, 'Default', 'Secure Preferences')],
    ['preferences', path.join(profilePath, 'Default', 'Preferences')],
  ];
}

function settingFor(extensionId) {
  for (const [source, filePath] of settingsFiles()) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const root = readJson(filePath);
      const setting = root?.extensions?.settings?.[extensionId];
      if (setting && typeof setting === 'object') return { source, setting };
    } catch {}
  }
  return null;
}

function sanitizeSetting(extensionId) {
  const record = settingFor(extensionId);
  if (!record) return {
    present: false,
    source: '',
    stateValue: null,
    locationValue: null,
    creationFlagsValue: null,
    fromWebStore: null,
    disableReasonCodes: [],
    pathMatchesDisposableExtensionRoot: null,
  };
  const disableReasonCodes = Array.isArray(record.setting.disable_reasons)
    ? record.setting.disable_reasons.filter(value => Number.isInteger(value)).slice(0, 16)
    : [];
  const storedPath = typeof record.setting.path === 'string' ? record.setting.path : '';
  return {
    present: true,
    source: record.source,
    stateValue: Number.isInteger(record.setting.state) ? record.setting.state : null,
    locationValue: Number.isInteger(record.setting.location) ? record.setting.location : null,
    creationFlagsValue: Number.isInteger(record.setting.creation_flags) ? record.setting.creation_flags : null,
    fromWebStore: typeof record.setting.from_webstore === 'boolean' ? record.setting.from_webstore : null,
    disableReasonCodes,
    pathMatchesDisposableExtensionRoot: storedPath
      ? normalizedPath(storedPath) === normalizedPath(extensionPath)
      : null,
  };
}

function summarizeExtensions(extensionMap) {
  return [...extensionMap.values()].map(extension => ({
    id: extension.id,
    version: extension.version,
    enabled: extension.enabled,
  }));
}

async function launch() {
  return await puppeteer.launch({
    executablePath: browserExecutablePath,
    headless: true,
    userDataDir: profilePath,
    enableExtensions: true,
    dumpio: false,
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

async function closeBrowser(browser) {
  if (!browser) return;
  await browser.close().catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 500));
}

let phaseOneBrowser;
let phaseTwoBrowser;
try {
  assert(extensionSource && fs.existsSync(sourceManifestPath), 'source-extension-manifest-missing');
  assert(browserExecutablePath && fs.existsSync(browserExecutablePath), 'system-chrome-executable-missing');
  assert(outputPath, 'output-path-missing');

  const sourceManifestHashBefore = sha256File(sourceManifestPath);
  fs.rmSync(probeRoot, { recursive: true, force: true });
  fs.mkdirSync(probeRoot, { recursive: true });
  fs.cpSync(extensionSource, extensionPath, { recursive: true });

  const keyedManifest = readJson(manifestPath);
  const fixedKey = String(keyedManifest.key ?? '').trim();
  assert(fixedKey, 'canonical-manifest-key-missing');
  const calculatedStableId = extensionIdFromKey(fixedKey);
  assert(calculatedStableId === EXPECTED_STABLE_ID, `canonical-stable-id-mismatch:${calculatedStableId}`);

  const unkeyedManifest = { ...keyedManifest };
  delete unkeyedManifest.key;
  writeJson(manifestPath, unkeyedManifest);

  phaseOneBrowser = await launch();
  const browserVersion = await phaseOneBrowser.version();
  const legacyId = await phaseOneBrowser.installExtension(extensionPath);
  const phaseOneExtensions = summarizeExtensions(await phaseOneBrowser.extensions());
  assert(legacyId && legacyId !== calculatedStableId, `unkeyed-load-did-not-produce-distinct-id:${legacyId}`);
  await closeBrowser(phaseOneBrowser);
  phaseOneBrowser = null;

  const phaseOneLegacyRegistration = sanitizeSetting(legacyId);
  const phaseOneStableRegistration = sanitizeSetting(calculatedStableId);

  writeJson(manifestPath, keyedManifest);

  phaseTwoBrowser = await launch();
  const phaseTwoBeforeInstall = summarizeExtensions(await phaseTwoBrowser.extensions());
  const stableInstallId = await phaseTwoBrowser.installExtension(extensionPath);
  const phaseTwoAfterInstall = summarizeExtensions(await phaseTwoBrowser.extensions());
  await closeBrowser(phaseTwoBrowser);
  phaseTwoBrowser = null;

  const legacyRegistration = sanitizeSetting(legacyId);
  const stableRegistration = sanitizeSetting(calculatedStableId);
  const sourceManifestHashAfter = sha256File(sourceManifestPath);

  const legacyHasDisableReload = legacyRegistration.disableReasonCodes.includes(DISABLE_RELOAD);
  const sameRootResidue = legacyRegistration.present
    && stableRegistration.present
    && legacyRegistration.pathMatchesDisposableExtensionRoot === true
    && stableRegistration.pathMatchesDisposableExtensionRoot === true;
  const reproducedObservedLegacyShape = stableInstallId === calculatedStableId
    && sameRootResidue
    && legacyHasDisableReload;

  const evidence = {
    schemaVersion: 1,
    capability: 'chrome-extension-identity-transition-disposable-v1',
    observedAtUtc: new Date().toISOString(),
    disposableProfile: true,
    liveChromeProfileAccessed: false,
    liveChromeRegistrationMutated: false,
    sourceExtensionMutated: sourceManifestHashBefore !== sourceManifestHashAfter,
    sourceManifestHashPreserved: sourceManifestHashBefore === sourceManifestHashAfter,
    chatGptNavigationPerformed: false,
    browserVersion,
    transition: 'same-root-unkeyed-load-then-fixed-key-load',
    disableReloadCode: DISABLE_RELOAD,
    stableId: calculatedStableId,
    legacyId,
    legacyIdDifferentFromStable: legacyId !== calculatedStableId,
    phaseOne: {
      installId: legacyId,
      extensions: phaseOneExtensions,
      legacyRegistration: phaseOneLegacyRegistration,
      stableRegistration: phaseOneStableRegistration,
    },
    phaseTwo: {
      extensionsBeforeInstall: phaseTwoBeforeInstall,
      installId: stableInstallId,
      extensionsAfterInstall: phaseTwoAfterInstall,
      legacyRegistration,
      stableRegistration,
    },
    legacyHasDisableReload,
    sameRootResidue,
    reproducedObservedLegacyShape,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  writeJson(outputPath, evidence);
  console.log(`IDENTITY_TRANSITION stable=${calculatedStableId}; legacy=${legacyId}; stableInstall=${stableInstallId}; legacyPresent=${legacyRegistration.present}; legacyDisableReload=${legacyHasDisableReload}; sameRoot=${sameRootResidue}; reproduced=${reproducedObservedLegacyShape}`);
} catch (error) {
  console.error(`IDENTITY_TRANSITION_FAILURE ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closeBrowser(phaseOneBrowser);
  await closeBrowser(phaseTwoBrowser);
}
