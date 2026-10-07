import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const backgroundSource = fs.readFileSync(
  path.join(repoRoot, 'standalone-quick-continue', 'background.js'),
  'utf8'
);

function loadManagedUpdatePolicy(runningVersion = '1.2.26') {
  const context = {
    globalThis: null,
    Number,
    String,
    Object,
    Promise,
    Math,
    Date,
    URL,
    decodeURIComponent,
    structuredClone,
    setTimeout: () => 1,
    clearTimeout: () => {},
    fetch: async () => ({ ok: false }),
    importScripts: () => {},
    chrome: {
      alarms: {
        create: () => {},
        clear: async () => true,
        onAlarm: { addListener: () => {} }
      },
      runtime: {
        getManifest: () => ({ version: runningVersion }),
        reload: () => {},
        onMessage: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        onInstalled: { addListener: () => {} }
      },
      storage: {
        local: {
          get: async () => ({}),
          set: async () => {}
        }
      },
      tabs: {
        query: async () => [],
        get: async () => null,
        reload: async () => {},
        sendMessage: async () => ({ ok: true }),
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} }
      },
      scripting: { executeScript: async () => {} }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(backgroundSource, context);
  return context.managedUpdateShouldReload;
}

test('managed updater never reloads a newer candidate down to the helper version', () => {
  const shouldReload = loadManagedUpdatePolicy();
  expect(typeof shouldReload).toBe('function');
  expect(shouldReload('1.2.25', '1.2.26')).toBe(false);
  expect(shouldReload('1.2.26', '1.2.26')).toBe(false);
  expect(shouldReload('1.2.27', '1.2.26')).toBe(true);
  expect(shouldReload('invalid', '1.2.26')).toBe(false);
});

test('managed update check delegates mismatch direction to the one-way policy', () => {
  expect(backgroundSource).toContain(
    'if (!managedUpdateShouldReload(installedVersion, runningVersion)) return false;'
  );
  expect(backgroundSource).not.toContain('comparison === null || comparison === 0');
});
