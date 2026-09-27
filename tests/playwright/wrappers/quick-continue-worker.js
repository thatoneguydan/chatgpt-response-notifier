'use strict';

importScripts('background.js');

const PLAYWRIGHT_COMMAND_KEY = 'playwright-test:worker-command';
const PLAYWRIGHT_RESPONSE_PREFIX = 'playwright-test:worker-response:';
const PLAYWRIGHT_WORKER_GENERATION = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function responseKey(requestId) {
  return `${PLAYWRIGHT_RESPONSE_PREFIX}${String(requestId || '')}`;
}

async function handlePlaywrightCommand(command) {
  if (command?.type !== 'PLAYWRIGHT_TEST_WORKER_GENERATION') {
    throw new Error(`Unsupported Quick Continue Playwright command: ${String(command?.type || '')}`);
  }
  return {
    extensionName: String(chrome.runtime.getManifest().name || ''),
    generation: PLAYWRIGHT_WORKER_GENERATION
  };
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const command = changes?.[PLAYWRIGHT_COMMAND_KEY]?.newValue;
  const requestId = String(command?.requestId || '');
  if (!requestId) return;

  Promise.resolve()
    .then(() => handlePlaywrightCommand(command))
    .then((result) => chrome.storage.local.set({
      [responseKey(requestId)]: { ok: true, result, completedAt: Date.now() }
    }))
    .catch((error) => chrome.storage.local.set({
      [responseKey(requestId)]: {
        ok: false,
        error: String(error?.message || error || 'Playwright worker command failed.'),
        completedAt: Date.now()
      }
    }));
});
