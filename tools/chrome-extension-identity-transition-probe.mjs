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

function settingsFiles(profilePath) {
  return [
    ['secure-preferences', path.join(profilePath, 'Default', 'Secure Preferences')],
    ['preferences', path.join(profilePath, 'Default', 'Preferences')],
  ];
}

function settingFor(profilePath, extensionId) {
  for (const [source, filePath] of settingsFiles(profilePath)) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const root = readJson(filePath);
      const setting = root?.extensions?.settings?.[extensionId];
      if (setting && typeof setting === 'object') return { source, setting };
    } catch {}
  }
  return null;
}

function sanitizeSetting(profilePath, extensionPath, extensionId) {
  const record = settingFor(profilePath, extensionId);
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

async function launch(profilePath) {
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

function prepareExperiment(name, keyedManifest) {
  const root = path.join(probeRoot, name);
  const extensionPath = path.join(root, 'extension-root');
  const profilePath = path.join(root, 'chrome-profile');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(extensionSource, extensionPath, { recursive: true });
  const manifestPath = path.join(extensionPath, 'manifest.json');
  const unkeyedManifest = { ...keyedManifest };
  delete unkeyedManifest.key;
  writeJson(manifestPath, unkeyedManifest);
  return { root, extensionPath, profilePath, manifestPath, unkeyedManifest };
}

async function runCleanRestartControl(keyedManifest, stableId) {
  const experiment = prepareExperiment('clean-reinstall-control', keyedManifest);
  let firstBrowser;
  let secondBrowser;
  try {
    firstBrowser = await launch(experiment.profilePath);
    const browserVersion = await firstBrowser.version();
    const legacyId = await firstBrowser.installExtension(experiment.extensionPath);
    const phaseOneExtensions = summarizeExtensions(await firstBrowser.extensions());
    assert(legacyId && legacyId !== stableId, `control-unkeyed-load-did-not-produce-distinct-id:${legacyId}`);
    await closeBrowser(firstBrowser);
    firstBrowser = null;

    const phaseOneLegacyRegistration = sanitizeSetting(experiment.profilePath, experiment.extensionPath, legacyId);
    const phaseOneStableRegistration = sanitizeSetting(experiment.profilePath, experiment.extensionPath, stableId);

    writeJson(experiment.manifestPath, keyedManifest);
    secondBrowser = await launch(experiment.profilePath);
    const extensionsBeforeInstall = summarizeExtensions(await secondBrowser.extensions());
    const stableInstallId = await secondBrowser.installExtension(experiment.extensionPath);
    const extensionsAfterInstall = summarizeExtensions(await secondBrowser.extensions());
    await closeBrowser(secondBrowser);
    secondBrowser = null;

    const legacyRegistration = sanitizeSetting(experiment.profilePath, experiment.extensionPath, legacyId);
    const stableRegistration = sanitizeSetting(experiment.profilePath, experiment.extensionPath, stableId);
    const legacyHasDisableReload = legacyRegistration.disableReasonCodes.includes(DISABLE_RELOAD);
    const sameRootResidue = legacyRegistration.present
      && stableRegistration.present
      && legacyRegistration.pathMatchesDisposableExtensionRoot === true
      && stableRegistration.pathMatchesDisposableExtensionRoot === true;

    return {
      transition: 'clean-close-then-same-root-fixed-key-install',
      browserVersion,
      legacyId,
      stableInstallId,
      legacyIdDifferentFromStable: legacyId !== stableId,
      phaseOne: {
        installId: legacyId,
        extensions: phaseOneExtensions,
        legacyRegistration: phaseOneLegacyRegistration,
        stableRegistration: phaseOneStableRegistration,
      },
      phaseTwo: {
        extensionsBeforeInstall,
        installId: stableInstallId,
        extensionsAfterInstall,
        legacyRegistration,
        stableRegistration,
      },
      legacyHasDisableReload,
      sameRootResidue,
      reproducedObservedLegacyShape: stableInstallId === stableId && sameRootResidue && legacyHasDisableReload,
    };
  } finally {
    await closeBrowser(firstBrowser);
    await closeBrowser(secondBrowser);
  }
}

async function runLiveRuntimeReload(keyedManifest, stableId) {
  const experiment = prepareExperiment('live-runtime-reload', keyedManifest);
  let browser;
  try {
    browser = await launch(experiment.profilePath);
    const browserVersion = await browser.version();
    const legacyId = await browser.installExtension(experiment.extensionPath);
    assert(legacyId && legacyId !== stableId, `reload-unkeyed-load-did-not-produce-distinct-id:${legacyId}`);

    const legacyExtension = await waitForExtension(browser, legacyId);
    assert(legacyExtension, 'reload-legacy-extension-not-listed');
    const worker = await waitForWorker(legacyExtension);
    assert(worker, 'reload-legacy-service-worker-not-available');
    const beforeReloadExtensions = summarizeExtensions(await browser.extensions());

    writeJson(experiment.manifestPath, keyedManifest);
    let reloadInvocation = 'returned';
    try {
      await worker.evaluate(() => chrome.runtime.reload());
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      reloadInvocation = /context|target|session|worker|closed|destroy/i.test(text)
        ? 'context-destroyed-after-invocation'
        : `unexpected-error:${text.slice(0, 160)}`;
      if (reloadInvocation.startsWith('unexpected-error:')) throw error;
    }

    const stableExtension = await waitForExtension(browser, stableId);
    const afterReloadExtensions = summarizeExtensions(await browser.extensions());
    await new Promise(resolve => setTimeout(resolve, 1200));
    await closeBrowser(browser);
    browser = null;

    const legacyRegistration = sanitizeSetting(experiment.profilePath, experiment.extensionPath, legacyId);
    const stableRegistration = sanitizeSetting(experiment.profilePath, experiment.extensionPath, stableId);
    const legacyHasDisableReload = legacyRegistration.disableReasonCodes.includes(DISABLE_RELOAD);
    const sameRootResidue = legacyRegistration.present
      && stableRegistration.present
      && legacyRegistration.pathMatchesDisposableExtensionRoot === true
      && stableRegistration.pathMatchesDisposableExtensionRoot === true;
    const reproducedObservedLegacyShape = Boolean(stableExtension)
      && sameRootResidue
      && legacyHasDisableReload;

    return {
      transition: 'same-process-runtime-reload-after-fixed-key-appears',
      browserVersion,
      legacyId,
      stableIdObservedInRuntime: Boolean(stableExtension),
      reloadInvocation,
      extensionsBeforeReload: beforeReloadExtensions,
      extensionsAfterReload: afterReloadExtensions,
      legacyRegistration,
      stableRegistration,
      legacyHasDisableReload,
      sameRootResidue,
      reproducedObservedLegacyShape,
    };
  } finally {
    await closeBrowser(browser);
  }
}

try {
  assert(extensionSource && fs.existsSync(sourceManifestPath), 'source-extension-manifest-missing');
  assert(browserExecutablePath && fs.existsSync(browserExecutablePath), 'system-chrome-executable-missing');
  assert(outputPath, 'output-path-missing');

  const sourceManifestHashBefore = sha256File(sourceManifestPath);
  fs.rmSync(probeRoot, { recursive: true, force: true });
  fs.mkdirSync(probeRoot, { recursive: true });

  const keyedManifest = readJson(sourceManifestPath);
  const fixedKey = String(keyedManifest.key ?? '').trim();
  assert(fixedKey, 'canonical-manifest-key-missing');
  const stableId = extensionIdFromKey(fixedKey);
  assert(stableId === EXPECTED_STABLE_ID, `canonical-stable-id-mismatch:${stableId}`);

  const cleanRestartControl = await runCleanRestartControl(keyedManifest, stableId);
  const liveRuntimeReload = await runLiveRuntimeReload(keyedManifest, stableId);
  const sourceManifestHashAfter = sha256File(sourceManifestPath);

  const evidence = {
    schemaVersion: 2,
    capability: 'chrome-extension-identity-transition-disposable-v2',
    observedAtUtc: new Date().toISOString(),
    disposableProfile: true,
    liveChromeProfileAccessed: false,
    liveChromeRegistrationMutated: false,
    sourceExtensionMutated: sourceManifestHashBefore !== sourceManifestHashAfter,
    sourceManifestHashPreserved: sourceManifestHashBefore === sourceManifestHashAfter,
    chatGptNavigationPerformed: false,
    disableReloadCode: DISABLE_RELOAD,
    stableId,
    cleanRestartControl,
    liveRuntimeReload,
    cleanControlReproducedObservedLegacyShape: cleanRestartControl.reproducedObservedLegacyShape,
    runtimeReloadReproducedObservedLegacyShape: liveRuntimeReload.reproducedObservedLegacyShape,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  writeJson(outputPath, evidence);
  console.log(`IDENTITY_TRANSITION_CONTROL browser=${cleanRestartControl.browserVersion}; legacy=${cleanRestartControl.legacyId}; stableInstall=${cleanRestartControl.stableInstallId}; legacyPresent=${cleanRestartControl.phaseTwo.legacyRegistration.present}; legacyDisableReload=${cleanRestartControl.legacyHasDisableReload}; sameRoot=${cleanRestartControl.sameRootResidue}; reproduced=${cleanRestartControl.reproducedObservedLegacyShape}`);
  console.log(`IDENTITY_TRANSITION_RELOAD browser=${liveRuntimeReload.browserVersion}; legacy=${liveRuntimeReload.legacyId}; stableRuntime=${liveRuntimeReload.stableIdObservedInRuntime}; reloadInvocation=${liveRuntimeReload.reloadInvocation}; legacyPresent=${liveRuntimeReload.legacyRegistration.present}; legacyDisableReasons=${liveRuntimeReload.legacyRegistration.disableReasonCodes.join(',')}; stablePresent=${liveRuntimeReload.stableRegistration.present}; sameRoot=${liveRuntimeReload.sameRootResidue}; reproduced=${liveRuntimeReload.reproducedObservedLegacyShape}`);
} catch (error) {
  console.error(`IDENTITY_TRANSITION_FAILURE ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
