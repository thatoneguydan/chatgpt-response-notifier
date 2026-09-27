import {
  test,
  expect,
  evaluateInExtensionWorld
} from './extension-fixture.mjs';

const toolbarSelector = '#chatgpt-quick-continue-toolbar';
const fixtureConversationId = 'playwright-browser-regression';
const watchdogDelayMs = 30 * 60_000;
const extensionWorkerPaths = Object.freeze({
  'ChatGPT Quick Continue': 'background.js',
  'ChatGPT Response Notifier': 'diagnostics-bootstrap.js'
});

async function expectTrafficInert(traffic) {
  const blocked = traffic.filter((entry) => entry.kind === 'blocked');
  expect(blocked, `Unexpected ChatGPT network attempts: ${JSON.stringify(blocked)}`).toEqual([]);
}

async function extensionDescriptor(page, extensionName) {
  const workerPath = extensionWorkerPaths[extensionName];
  if (!workerPath) throw new Error(`Unknown extension worker path: ${extensionName}`);
  const extensionId = await evaluateInExtensionWorld(
    page,
    extensionName,
    `String(globalThis.chrome?.runtime?.id || '')`
  );
  if (!extensionId) throw new Error(`Could not resolve extension ID: ${extensionName}`);
  return {
    extensionName,
    extensionId,
    workerPath,
    scriptUrl: `chrome-extension://${extensionId}/${workerPath}`
  };
}

async function extensionServiceWorker(page, extensionName) {
  const descriptor = await extensionDescriptor(page, extensionName);
  const context = page.context();
  let worker = context.serviceWorkers().find((candidate) => candidate.url() === descriptor.scriptUrl) || null;
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', {
      timeout: 10_000,
      predicate: (candidate) => candidate.url() === descriptor.scriptUrl
    });
  }
  if (!worker) throw new Error(`Could not resolve extension service worker: ${extensionName}`);
  return { worker, descriptor };
}

async function notifierWorker(page) {
  return (await extensionServiceWorker(page, 'ChatGPT Response Notifier')).worker;
}

async function notifierMessage(page, message) {
  const payload = JSON.stringify(message);
  return evaluateInExtensionWorld(page, 'ChatGPT Response Notifier', `(async () => {
    return await chrome.runtime.sendMessage(${payload});
  })()`);
}

async function notifierWatchdog(page, conversationId = fixtureConversationId) {
  const worker = await notifierWorker(page);
  return worker.evaluate(async (id) => {
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    if (typeof monitor?.readCodeWatchdog !== 'function') {
      throw new Error('Notifier watchdog runtime unavailable in service worker.');
    }
    return await monitor.readCodeWatchdog(id);
  }, conversationId);
}

async function fixtureTargetFromWorker(worker, conversationId) {
  return worker.evaluate(async (id) => {
    const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    const target = tabs.find((tab) => {
      try { return new URL(String(tab.url || '')).pathname === `/c/${id}`; }
      catch { return false; }
    });
    if (!Number.isInteger(target?.id)) throw new Error('Playwright ChatGPT fixture tab not found.');
    return {
      id: target.id,
      url: String(target.url || `https://chatgpt.com/c/${id}`),
      title: String(target.title || 'ChatGPT extension Playwright fixture')
    };
  }, conversationId);
}

async function prepareNonTerminalNotifier(page) {
  await page.evaluate(() => {
    const wrapper = document.querySelector('[data-testid="conversation-turn-1"]');
    wrapper?.querySelector('.rendered-footer')?.remove();
    const markdown = wrapper?.querySelector('.markdown');
    if (markdown) markdown.textContent = 'Browser-level work is still in progress.';
  });

  const worker = await notifierWorker(page);
  const target = await fixtureTargetFromWorker(worker, fixtureConversationId);
  await worker.evaluate(async ({ tabId }) => {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['status-code.js', 'status-policy.js', 'status-script.js']
    });
  }, { tabId: target.id });

  let promptKey = '';
  await expect.poll(async () => {
    const snapshot = await evaluateInExtensionWorld(page, 'ChatGPT Response Notifier', `(() => {
      const value = globalThis.__chatgptNotifierStatusDom?.latestAssistantSnapshot?.() || {};
      return {
        statusCode: String(value.statusCode || ''),
        promptKey: String(value.promptKey || '')
      };
    })()`);
    promptKey = String(snapshot?.promptKey || '');
    return {
      statusCode: String(snapshot?.statusCode || ''),
      hasPromptKey: Boolean(promptKey)
    };
  }, { timeout: 10_000 }).toEqual({ statusCode: '', hasPromptKey: true });
  return promptKey;
}

async function seedEnabledWatchdog(page, promptKey, { due = false } = {}) {
  const worker = await notifierWorker(page);
  return worker.evaluate(async ({ conversationId, promptKeyValue, makeDue, delayMs }) => {
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    if (
      typeof monitor?.setEnrollment !== 'function'
      || typeof monitor?.armCodeWatchdogForTarget !== 'function'
      || typeof monitor?.readCodeWatchdog !== 'function'
    ) {
      throw new Error('Notifier monitor runtime unavailable in service worker.');
    }

    const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    const tab = tabs.find((candidate) => {
      try { return new URL(String(candidate.url || '')).pathname === `/c/${conversationId}`; }
      catch { return false; }
    });
    if (!Number.isInteger(tab?.id)) throw new Error('Playwright ChatGPT fixture tab not found for watchdog seed.');

    const target = {
      id: conversationId,
      url: String(tab.url || `https://chatgpt.com/c/${conversationId}`),
      tab
    };
    await monitor.setEnrollment(target, true, 'playwright-browser-regression');
    const armed = await monitor.armCodeWatchdogForTarget({
      conversationId,
      promptKey: String(promptKeyValue || ''),
      source: 'playwright-browser-regression',
      requestId: 'playwright-watchdog-seed'
    }, target);
    if (armed?.ok !== true) {
      throw new Error(`Could not arm notifier watchdog: ${String(armed?.reason || armed?.error || 'unknown')}`);
    }

    if (makeDue) {
      const key = `code-watchdog:${conversationId}`;
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('chatgpt-response-notifier-monitor', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Could not open notifier watchdog database in worker.'));
      });
      try {
        await new Promise((resolve, reject) => {
          const transaction = database.transaction('profile', 'readwrite');
          const store = transaction.objectStore('profile');
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

    const record = await monitor.readCodeWatchdog(conversationId);
    if (!record) throw new Error('Notifier watchdog record missing after seed.');
    if (!makeDue && Number(record.deadlineAt || 0) < Date.now() + Math.max(1, Number(delayMs || 0)) - 5_000) {
      throw new Error('Notifier watchdog seed did not retain the expected future cadence.');
    }
    return record;
  }, {
    conversationId: fixtureConversationId,
    promptKeyValue: promptKey,
    makeDue: due,
    delayMs: watchdogDelayMs
  });
}

test('recovers the same Quick Continue toolbar owner after external host detachment', async ({ fixturePage, chatgptTraffic }) => {
  const toolbar = fixturePage.locator(toolbarSelector);
  await expect(toolbar).toBeVisible();
  const original = await fixturePage.evaluateHandle(() => document.getElementById('chatgpt-quick-continue-toolbar'));

  await fixturePage.evaluate(() => document.getElementById('chatgpt-quick-continue-toolbar')?.remove());
  await expect(toolbar).toHaveCount(1);
  await expect(toolbar).toBeVisible();
  await fixturePage.waitForTimeout(400);
  expect(await fixturePage.evaluate(
    (node) => node === document.getElementById('chatgpt-quick-continue-toolbar') && node?.isConnected === true,
    original
  )).toBe(true);
  await expectTrafficInert(chatgptTraffic);
});

test('send transaction survives composer replacement during edit commit and same-conversation navigation', async ({ fixturePage, chatgptTraffic }) => {
  await fixturePage.evaluate(() => {
    const composer = document.querySelector('#prompt-textarea');
    composer?.addEventListener('input', () => {
      window.__fixture.remountComposer();
      history.pushState({}, '', '/c/playwright-browser-regression?during-send=1');
    }, { once: true });
  });

  const result = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Quick Continue', `(async () => {
    const composer = document.querySelector('#prompt-textarea');
    return await globalThis.ChatGPTQuickContinueSend.submit(
      composer,
      'Playwright remount-safe transaction',
      { replace: true, timeoutMs: 4000 }
    );
  })()`);

  const submissions = await fixturePage.evaluate(() => window.__fixture.submits);
  expect(result).toMatchObject({ ok: true, reason: 'sent', activated: true });
  expect(submissions).toHaveLength(1);
  expect(submissions[0].text).toBe('Playwright remount-safe transaction');
  expect(submissions[0].generation).toBeGreaterThan(1);
  expect(new URL(fixturePage.url()).searchParams.get('during-send')).toBe('1');
  await expectTrafficInert(chatgptTraffic);
});

test('terminal detector remains same-turn bounded after assistant wrapper replacement', async ({ fixturePage, chatgptTraffic }) => {
  await fixturePage.evaluate(() => {
    const wrapper = document.querySelector('[data-testid="conversation-turn-1"]');
    wrapper.replaceChildren();
    const surface = document.createElement('div');
    surface.className = 'assistant-surface';
    const semantic = document.createElement('article');
    semantic.dataset.messageAuthorRole = 'assistant';
    const prose = document.createElement('div');
    prose.className = 'markdown prose';
    prose.textContent = 'Browser-level work completed.';
    semantic.append(prose);
    const footer = document.createElement('div');
    footer.className = 'rendered-footer';
    footer.textContent = '[GITHUB_STATUS: COMPLETE_APPLIED]';
    surface.append(semantic, footer);
    wrapper.append(surface);

    const neighboringUser = document.createElement('section');
    neighboringUser.dataset.testid = 'conversation-turn-neighbor-user';
    const role = document.createElement('div');
    role.dataset.messageAuthorRole = 'user';
    role.textContent = '[GITHUB_STATUS: BLOCKED_HUMAN]';
    neighboringUser.append(role);
    wrapper.after(neighboringUser);
  });

  const detection = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Response Notifier', `(() => {
    const api = globalThis.ChatGPTNotifierRenderedTerminalStatus;
    const wrapper = document.querySelector('[data-testid="conversation-turn-1"]');
    const semanticAssistant = wrapper?.querySelector('[data-message-author-role="assistant"]');
    return {
      wrapper: String(api?.detect?.(wrapper) || ''),
      semanticAssistant: String(api?.detect?.(semanticAssistant) || '')
    };
  })()`);

  expect(detection).toEqual({
    wrapper: 'COMPLETE_APPLIED',
    semanticAssistant: 'COMPLETE_APPLIED'
  });
  await expectTrafficInert(chatgptTraffic);
});

test('Quick Continue MV3 worker naturally suspends and wakes without rebuilding live page UI', async ({ fixturePage, chatgptTraffic }) => {
  test.setTimeout(60_000);
  const toolbar = fixturePage.locator(toolbarSelector);
  await expect(toolbar).toBeVisible();
  const original = await fixturePage.evaluateHandle(() => document.getElementById('chatgpt-quick-continue-toolbar'));
  const before = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Quick Continue', `(() => ({
    runtimeVersion: Number(globalThis.__chatgptQuickContinueRuntime?.version || 0),
    hoverVersion: Number(globalThis.__chatgptQuickContinueHoverEditRuntime?.version || 0)
  }))()`);

  const { worker, descriptor } = await extensionServiceWorker(fixturePage, 'ChatGPT Quick Continue');
  const sentinel = await worker.evaluate(() => {
    const value = crypto.randomUUID();
    globalThis.__playwrightMv3IdleSentinel = value;
    return value;
  });
  expect(sentinel).not.toBe('');

  // Chromium terminates idle MV3 extension workers after roughly 30 seconds.
  // Playwright keeps the Worker handle valid across that restart, so the next
  // evaluate wakes the worker and lets us prove that worker-global state was lost.
  await fixturePage.waitForTimeout(35_000);
  const wake = await worker.evaluate(() => ({
    sentinel: String(globalThis.__playwrightMv3IdleSentinel || ''),
    name: String(chrome.runtime.getManifest().name || ''),
    workerUrl: String(globalThis.location?.href || '')
  }));
  expect(wake.sentinel).toBe('');
  expect(wake.name).toBe('ChatGPT Quick Continue');
  expect(wake.workerUrl).toBe(descriptor.scriptUrl);

  await fixturePage.waitForTimeout(500);
  const after = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Quick Continue', `(() => ({
    runtimeVersion: Number(globalThis.__chatgptQuickContinueRuntime?.version || 0),
    hoverVersion: Number(globalThis.__chatgptQuickContinueHoverEditRuntime?.version || 0)
  }))()`);
  expect(await fixturePage.evaluate(
    (node) => node === document.getElementById('chatgpt-quick-continue-toolbar') && node?.isConnected === true,
    original
  )).toBe(true);
  expect(after).toEqual(before);
  await expect(toolbar).toHaveCount(1);
  await expect(toolbar).toBeVisible();
  await expectTrafficInert(chatgptTraffic);
});

test('terminal stop rejects a superseded prompt then persists the rendered definitive stop', async ({ fixturePage, chatgptTraffic }) => {
  const promptKey = await prepareNonTerminalNotifier(fixturePage);
  const armed = await seedEnabledWatchdog(fixturePage, promptKey);
  expect(String(armed?.lastPromptKey || '')).toBe(promptKey);

  const rejected = await notifierMessage(fixturePage, {
    type: 'FORCE_PARK_CODE_WATCHDOG_TERMINAL_V3',
    conversationId: fixtureConversationId,
    promptKey: `${promptKey}-superseded`,
    statusCode: 'COMPLETE_APPLIED'
  });
  expect(rejected).toMatchObject({ ok: false, reason: 'terminal-prompt-superseded' });
  expect((await notifierWatchdog(fixturePage))?.stopped === true).toBe(false);

  await fixturePage.evaluate(() => {
    const wrapper = document.querySelector('[data-testid="conversation-turn-1"]');
    const footer = document.createElement('div');
    footer.className = 'rendered-footer';
    footer.textContent = '[GITHUB_STATUS: COMPLETE_APPLIED]';
    wrapper?.append(footer);
  });

  await expect.poll(async () => {
    const watchdog = await notifierWatchdog(fixturePage);
    return {
      stopped: watchdog?.stopped === true,
      stopReason: String(watchdog?.stopReason || ''),
      deadlineAt: Math.max(0, Number(watchdog?.deadlineAt || 0)),
      retryAt: Math.max(0, Number(watchdog?.retryAt || 0)),
      sendCount: Math.max(0, Number(watchdog?.sendCount || 0))
    };
  }, { timeout: 10_000 }).toEqual({
    stopped: true,
    stopReason: 'status:COMPLETE_APPLIED',
    deadlineAt: 0,
    retryAt: 0,
    sendCount: 0
  });
  await expectTrafficInert(chatgptTraffic);
});

test('due watchdog sends exactly once and reserves the next 30-minute cadence before replay', async ({ fixturePage, chatgptTraffic }) => {
  const promptKey = await prepareNonTerminalNotifier(fixturePage);
  const seeded = await seedEnabledWatchdog(fixturePage, promptKey, { due: true });
  expect(Math.max(0, Number(seeded?.deadlineAt || 0))).toBeLessThanOrEqual(Date.now());

  const first = await notifierMessage(fixturePage, {
    type: 'RUN_CODE_WATCHDOG_NOW_V3',
    conversationId: fixtureConversationId
  });
  expect(first).toMatchObject({ ok: true, ran: true });

  await expect.poll(() => fixturePage.evaluate(() => window.__fixture.submits.length), { timeout: 10_000 }).toBe(1);
  const firstSubmissions = await fixturePage.evaluate(() => window.__fixture.submits.map((entry) => entry.text));
  expect(firstSubmissions[0]).toContain('Continue until you finish or need something from me.');

  const afterFirst = await notifierWatchdog(fixturePage);
  expect(Math.max(0, Number(afterFirst?.sendCount || 0))).toBe(1);
  expect(Math.max(0, Number(afterFirst?.retryAt || 0))).toBe(0);
  expect(Math.max(0, Number(afterFirst?.deadlineAt || 0))).toBeGreaterThan(Date.now() + 20 * 60_000);

  const second = await notifierMessage(fixturePage, {
    type: 'RUN_CODE_WATCHDOG_NOW_V3',
    conversationId: fixtureConversationId
  });
  expect(second).toMatchObject({ ok: true, ran: false, reason: 'watchdog-not-due' });
  await fixturePage.waitForTimeout(1000);
  expect(await fixturePage.evaluate(() => window.__fixture.submits.length)).toBe(1);
  await expectTrafficInert(chatgptTraffic);
});
