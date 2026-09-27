import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  test as base,
  expect,
  evaluateInExtensionWorld,
  notifierExtensionPath,
  quickContinueExtensionPath
} from './extension-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const wrapperRoot = path.join(here, 'wrappers');

async function prepareWrappedExtension(sourcePath, destinationPath, wrapperName) {
  await fs.rm(destinationPath, { recursive: true, force: true });
  await fs.cp(sourcePath, destinationPath, { recursive: true });

  const manifestPath = path.join(destinationPath, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const serviceWorker = String(manifest?.background?.service_worker || '').trim();
  if (!serviceWorker) throw new Error(`Missing production MV3 service worker in ${manifestPath}.`);

  // Storage is added only to the disposable test copy as the harness mailbox.
  // The checked-in production manifests and runtime permissions remain unchanged.
  manifest.permissions = Array.from(new Set([...(manifest.permissions || []), 'storage']));
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const workerPath = path.join(destinationPath, serviceWorker);
  const productionWorker = await fs.readFile(workerPath, 'utf8');
  const rawHook = await fs.readFile(path.join(wrapperRoot, wrapperName), 'utf8');
  const hook = rawHook
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('importScripts('))
    .join('\n')
    .trim();
  if (!hook) throw new Error(`Empty Playwright worker hook: ${wrapperName}`);

  // Preserve the production worker entrypoint. Only the temporary copy receives
  // the test transport hook; neither production extension contains these hooks.
  await fs.writeFile(
    workerPath,
    `${productionWorker.trimEnd()}\n\n// Playwright test-only hook; never packaged with the extension.\n${hook}\n`,
    'utf8'
  );
}

export const test = base.extend({
  extensionContext: async ({}, use, testInfo) => {
    const profile = testInfo.outputPath('chromium-profile');
    const copies = testInfo.outputPath('wrapped-extensions');
    const notifierRuntimePath = path.join(copies, 'notifier');
    const quickContinueRuntimePath = path.join(copies, 'quick-continue');

    await fs.rm(profile, { recursive: true, force: true });
    await fs.rm(copies, { recursive: true, force: true });
    await fs.mkdir(copies, { recursive: true });
    await Promise.all([
      prepareWrappedExtension(notifierExtensionPath, notifierRuntimePath, 'notifier-worker.js'),
      prepareWrappedExtension(quickContinueExtensionPath, quickContinueRuntimePath, 'quick-continue-worker.js')
    ]);

    const extensions = [notifierRuntimePath, quickContinueRuntimePath].join(',');
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 900 },
      args: [
        `--disable-extensions-except=${extensions}`,
        `--load-extension=${extensions}`
      ]
    });

    try {
      // Keep the fixture closed until fresh-install onInstalled work has settled,
      // matching the production-payload fixture's lifecycle boundary.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await use(context);
    } finally {
      await context.close();
    }
  }
});

export { expect, evaluateInExtensionWorld };
