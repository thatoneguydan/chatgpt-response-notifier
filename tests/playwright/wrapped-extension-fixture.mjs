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
const wrapperFilename = 'playwright-worker-wrapper.js';

async function prepareWrappedExtension(sourcePath, destinationPath, wrapperName) {
  await fs.rm(destinationPath, { recursive: true, force: true });
  await fs.cp(sourcePath, destinationPath, { recursive: true });
  await fs.copyFile(
    path.join(wrapperRoot, wrapperName),
    path.join(destinationPath, wrapperFilename)
  );

  const manifestPath = path.join(destinationPath, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.background = {
    ...(manifest.background || {}),
    service_worker: wrapperFilename
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
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
