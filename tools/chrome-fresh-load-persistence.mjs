import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const EXPECTED_ID = 'lciedmoiiapbgemklkpoadimhffaaaah';
const EXPECTED_VERSION = '0.9.28';

const extensionPath = path.resolve(process.argv[2] ?? '');
const profilePath = path.resolve(process.argv[3] ?? '');
const browserExecutablePath = path.resolve(process.argv[4] ?? '');

function fail(message) {
  console.error(`PROBE_FAILURE ${message}`);
  process.exitCode = 1;
}

function summarizeExtensions(extensionMap) {
  return [...extensionMap.values()].map(extension => ({
    id: extension.id,
    name: extension.name,
    version: extension.version,
    enabled: extension.enabled,
  }));
}

async function launch(profile) {
  return puppeteer.launch({
    executablePath: browserExecutablePath,
    headless: true,
    userDataDir: profile,
    enableExtensions: true,
    dumpio: true,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
}

if (!extensionPath || !fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
  fail('extension-manifest-missing');
} else if (!profilePath) {
  fail('profile-path-missing');
} else if (!browserExecutablePath || !fs.existsSync(browserExecutablePath)) {
  fail('chrome-for-testing-executable-missing');
} else {
  fs.mkdirSync(profilePath, { recursive: true });

  let browser;
  try {
    browser = await launch(profilePath);
    const installedId = await browser.installExtension(extensionPath);
    console.log(`PHASE1_INSTALL_ID ${installedId}`);

    const extensions = await browser.extensions();
    console.log(`PHASE1_EXTENSIONS ${JSON.stringify(summarizeExtensions(extensions))}`);
    const installed = extensions.get(installedId);

    if (installedId !== EXPECTED_ID) {
      throw new Error(`phase1-id-mismatch:${installedId}`);
    }
    if (!installed) {
      throw new Error('phase1-extension-not-listed');
    }
    if (!installed.enabled) {
      throw new Error('phase1-extension-disabled');
    }
    if (installed.version !== EXPECTED_VERSION) {
      throw new Error(`phase1-version-mismatch:${installed.version}`);
    }

    const workers = await installed.workers();
    console.log(`PHASE1_WORKERS ${workers.length}`);
  } catch (error) {
    fail(`phase1-fresh-install:${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  if (!process.exitCode) {
    browser = undefined;
    try {
      browser = await launch(profilePath);
      const extensions = await browser.extensions();
      console.log(`PHASE2_EXTENSIONS ${JSON.stringify(summarizeExtensions(extensions))}`);
      const restored = extensions.get(EXPECTED_ID);

      if (!restored) {
        throw new Error('phase2-extension-not-restored');
      }
      if (!restored.enabled) {
        throw new Error('phase2-extension-disabled');
      }
      if (restored.version !== EXPECTED_VERSION) {
        throw new Error(`phase2-version-mismatch:${restored.version}`);
      }

      const workers = await restored.workers();
      console.log(`PHASE2_WORKERS ${workers.length}`);
      console.log('PROBE_SUCCESS fresh-install-and-profile-restart');
    } catch (error) {
      fail(`phase2-profile-restart:${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }
}
