'use strict';

importScripts('background.js');

const PLAYWRIGHT_WORKER_GENERATION = crypto.randomUUID();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'PLAYWRIGHT_TEST_WORKER_GENERATION') return false;
  sendResponse?.({
    ok: true,
    extensionName: String(chrome.runtime.getManifest().name || ''),
    generation: PLAYWRIGHT_WORKER_GENERATION
  });
  return false;
});
