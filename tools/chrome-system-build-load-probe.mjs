import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const EXPECTED_ID = 'lciedmoiiapbgemklkpoadimhffaaaah';

const extensionPath = path.resolve(process.argv[2] ?? '');
const profilePath = path.resolve(process.argv[3] ?? '');
const browserExecutablePath = path.resolve(process.argv[4] ?? '');
const expectedVersion = (() => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
    return String(manifest.version || '').trim();
  } catch {
    return '';
  }
})();

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

if (!extensionPath || !fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
  fail('extension-manifest-missing');
} else if (!expectedVersion) {
  fail('extension-version-missing');
} else if (!profilePath) {
  fail('profile-path-missing');
} else if (!browserExecutablePath || !fs.existsSync(browserExecutablePath)) {
  fail('system-chrome-executable-missing');
} else {
  fs.mkdirSync(profilePath, { recursive: true });

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: browserExecutablePath,
      headless: true,
      userDataDir: profilePath,
      enableExtensions: true,
      dumpio: true,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    const browserVersion = await browser.version();
    console.log(`SYSTEM_CHROME_VERSION ${browserVersion}`);

    const installedId = await browser.installExtension(extensionPath);
    console.log(`INSTALL_ID ${installedId}`);

    const extensions = await browser.extensions();
    console.log(`EXTENSIONS ${JSON.stringify(summarizeExtensions(extensions))}`);
    const installed = extensions.get(installedId);

    if (installedId !== EXPECTED_ID) {
      throw new Error(`id-mismatch:${installedId}`);
    }
    if (!installed) {
      throw new Error('extension-not-listed');
    }
    if (!installed.enabled) {
      throw new Error('extension-disabled');
    }
    if (installed.version !== expectedVersion) {
      throw new Error(`version-mismatch:${installed.version}`);
    }

    const workers = await installed.workers();
    console.log(`WORKERS ${workers.length}`);
    console.log('PROBE_SUCCESS system-chrome-fresh-load');
  } catch (error) {
    fail(`system-chrome-fresh-load:${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
