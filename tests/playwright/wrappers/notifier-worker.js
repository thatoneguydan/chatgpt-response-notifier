'use strict';

importScripts('diagnostics-bootstrap.js');

const PLAYWRIGHT_COMMAND_KEY = 'playwright-test:worker-command';
const PLAYWRIGHT_RESPONSE_PREFIX = 'playwright-test:worker-response:';
const PLAYWRIGHT_WORKER_GENERATION = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const WATCHDOG_DATABASE = 'chatgpt-response-notifier-monitor';
const WATCHDOG_PROFILE_STORE = 'profile';

function responseKey(requestId) {
  return `${PLAYWRIGHT_RESPONSE_PREFIX}${String(requestId || '')}`;
}

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
          reject(new Error('Notifier watchdog record missing before due seed.'));
          try { transaction.abort(); } catch {}
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
  return { tabId: target.tab.id };
}

async function readWatchdog(conversationId) {
  const monitor = globalThis.__chatgptNotifierMonitorBackground;
  if (typeof monitor?.readCodeWatchdog !== 'function') {
    throw new Error('Notifier watchdog runtime unavailable.');
  }
  return await monitor.readCodeWatchdog(conversationId);
}

async function seedWatchdog(command) {
  const conversationId = String(command?.conversationId || '');
  const promptKey = String(command?.promptKey || '');
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

  if (command?.due === true) await forceWatchdogDue(conversationId);
  return await monitor.readCodeWatchdog(conversationId);
}

async function forceTerminalStop(command) {
  const conversationId = String(command?.conversationId || '');
  const authority = globalThis.__chatgptNotifierWatchdogAuthorityV3;
  if (typeof authority?.forceTerminalStop !== 'function') {
    throw new Error('Notifier terminal-stop authority unavailable.');
  }
  const target = await fixtureTarget(conversationId);
  return await authority.forceTerminalStop({
    conversationId,
    promptKey: String(command?.promptKey || ''),
    statusCode: String(command?.statusCode || ''),
    requestStartedAt: Math.max(0, Number(command?.requestStartedAt || 0))
  }, { tab: target.tab });
}

async function runDueWatchdog(command) {
  const conversationId = String(command?.conversationId || '');
  const authority = globalThis.__chatgptNotifierWatchdogAuthorityV3;
  if (typeof authority?.runDueWatchdogNow !== 'function') {
    throw new Error('Notifier watchdog-run authority unavailable.');
  }
  const target = await fixtureTarget(conversationId);
  return await authority.runDueWatchdogNow({ conversationId }, { tab: target.tab });
}

async function handlePlaywrightCommand(command) {
  switch (String(command?.type || '')) {
    case 'PLAYWRIGHT_TEST_WORKER_GENERATION':
      return {
        extensionName: String(chrome.runtime.getManifest().name || ''),
        generation: PLAYWRIGHT_WORKER_GENERATION
      };
    case 'PLAYWRIGHT_TEST_INJECT_STATUS_RUNTIME':
      return await injectStatusRuntime(String(command?.conversationId || ''));
    case 'PLAYWRIGHT_TEST_READ_WATCHDOG':
      return await readWatchdog(String(command?.conversationId || ''));
    case 'PLAYWRIGHT_TEST_SEED_WATCHDOG':
      return await seedWatchdog(command);
    case 'PLAYWRIGHT_TEST_FORCE_TERMINAL_STOP':
      return await forceTerminalStop(command);
    case 'PLAYWRIGHT_TEST_RUN_DUE_WATCHDOG':
      return await runDueWatchdog(command);
    default:
      throw new Error(`Unsupported notifier Playwright command: ${String(command?.type || '')}`);
  }
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
        error: String(error?.message || error || 'Playwright notifier command failed.'),
        completedAt: Date.now()
      }
    }));
});
