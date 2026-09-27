'use strict';

importScripts('diagnostics-bootstrap.js');

const PLAYWRIGHT_WORKER_GENERATION = crypto.randomUUID();
const WATCHDOG_DATABASE = 'chatgpt-response-notifier-monitor';
const WATCHDOG_PROFILE_STORE = 'profile';

function fixtureTarget(conversationId) {
  return chrome.tabs.query({ url: ['https://chatgpt.com/*'] }).then((tabs) => {
    const tab = tabs.find((candidate) => {
      try { return new URL(String(candidate?.url || '')).pathname === `/c/${conversationId}`; }
      catch { return false; }
    });
    if (!Number.isInteger(tab?.id)) throw new Error('Playwright ChatGPT fixture tab not found.');
    return {
      id: String(conversationId || ''),
      url: String(tab.url || `https://chatgpt.com/c/${conversationId}`),
      tab
    };
  });
}

function openWatchdogDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WATCHDOG_DATABASE, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open notifier watchdog database.'));
  });
}

async function forceWatchdogDue(conversationId) {
  const key = `code-watchdog:${conversationId}`;
  const database = await openWatchdogDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(WATCHDOG_PROFILE_STORE, 'readwrite');
      const store = transaction.objectStore(WATCHDOG_PROFILE_STORE);
      const request = store.get(key);
      request.onsuccess = () => {
        const current = request.result || null;
        if (!current) {
          transaction.abort();
          return;
        }
        store.put({
          ...current,
          deadlineAt: Date.now() - 1000,
          retryAt: 0,
          retryReason: '',
          stopped: false,
          stopReason: '',
          watchdogRevision: Math.max(0, Number(current.watchdogRevision || 0)) + 1,
          updatedAt: Date.now()
        });
      };
      request.onerror = () => reject(request.error || new Error('Could not read notifier watchdog record.'));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not seed due notifier watchdog record.'));
      transaction.onabort = () => reject(transaction.error || new Error('Due notifier watchdog seed was aborted.'));
    });
  } finally {
    try { database.close(); } catch {}
  }
}

async function injectStatusRuntime(conversationId) {
  const target = await fixtureTarget(conversationId);
  await chrome.scripting.executeScript({
    target: { tabId: target.tab.id },
    files: ['status-code.js', 'status-policy.js', 'status-script.js']
  });
  return { ok: true, tabId: target.tab.id };
}

async function readWatchdog(conversationId) {
  const monitor = globalThis.__chatgptNotifierMonitorBackground;
  if (typeof monitor?.readCodeWatchdog !== 'function') {
    throw new Error('Notifier watchdog runtime unavailable.');
  }
  return await monitor.readCodeWatchdog(conversationId);
}

async function seedWatchdog(message) {
  const conversationId = String(message?.conversationId || '');
  const promptKey = String(message?.promptKey || '');
  const monitor = globalThis.__chatgptNotifierMonitorBackground;
  if (!conversationId || !promptKey) throw new Error('Missing notifier watchdog seed identity.');
  if (
    typeof monitor?.setEnrollment !== 'function'
    || typeof monitor?.armCodeWatchdogForTarget !== 'function'
    || typeof monitor?.readCodeWatchdog !== 'function'
  ) {
    throw new Error('Notifier monitor runtime unavailable.');
  }

  const target = await fixtureTarget(conversationId);
  await monitor.setEnrollment(target, true, 'playwright-browser-regression');
  const armed = await monitor.armCodeWatchdogForTarget({
    conversationId,
    promptKey,
    source: 'playwright-browser-regression',
    requestId: 'playwright-watchdog-seed'
  }, target);
  if (armed?.ok !== true) {
    throw new Error(`Could not arm notifier watchdog: ${String(armed?.reason || armed?.error || 'unknown')}`);
  }

  if (message?.due === true) await forceWatchdogDue(conversationId);
  return await monitor.readCodeWatchdog(conversationId);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const respond = (promise) => {
    Promise.resolve(promise)
      .then((result) => sendResponse?.({ ok: true, result }))
      .catch((error) => sendResponse?.({ ok: false, error: String(error?.message || error) }));
    return true;
  };

  if (message?.type === 'PLAYWRIGHT_TEST_WORKER_GENERATION') {
    sendResponse?.({
      ok: true,
      extensionName: String(chrome.runtime.getManifest().name || ''),
      generation: PLAYWRIGHT_WORKER_GENERATION
    });
    return false;
  }
  if (message?.type === 'PLAYWRIGHT_TEST_INJECT_STATUS_RUNTIME') {
    return respond(injectStatusRuntime(String(message?.conversationId || '')));
  }
  if (message?.type === 'PLAYWRIGHT_TEST_READ_WATCHDOG') {
    return respond(readWatchdog(String(message?.conversationId || '')));
  }
  if (message?.type === 'PLAYWRIGHT_TEST_SEED_WATCHDOG') {
    return respond(seedWatchdog(message));
  }
  return false;
});
