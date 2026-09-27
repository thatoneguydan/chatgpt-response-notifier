import {
  test,
  expect,
  evaluateInExtensionWorld
} from './extension-fixture.mjs';

const toolbarSelector = '#chatgpt-quick-continue-toolbar';
const fixtureConversationId = 'playwright-browser-regression';
const extensionWorkerPaths = Object.freeze({
  'ChatGPT Quick Continue': 'background.js',
  'ChatGPT Response Notifier': 'diagnostics-bootstrap.js'
});
const notifierControlPages = new WeakMap();

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
    scriptUrl: `chrome-extension://${extensionId}/${workerPath}`,
    scopeUrl: `chrome-extension://${extensionId}/`
  };
}

async function notifierControlPage(page) {
  const context = page.context();
  const existing = notifierControlPages.get(context);
  if (existing && !existing.isClosed()) return existing;

  const descriptor = await extensionDescriptor(page, 'ChatGPT Response Notifier');
  const control = await context.newPage();
  await control.goto(`chrome-extension://${descriptor.extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  notifierControlPages.set(context, control);
  return control;
}

async function restartExtensionServiceWorker(page, extensionName) {
  const descriptor = await extensionDescriptor(page, extensionName);
  const session = await page.context().newCDPSession(page);
  const versions = new Map();
  const updateVersions = (event) => {
    for (const version of event?.versions || []) {
      versions.set(String(version.versionId || ''), version);
    }
  };
  session.on('ServiceWorker.workerVersionUpdated', updateVersions);

  try {
    await session.send('ServiceWorker.enable');
    await session.send('ServiceWorker.startWorker', { scopeURL: descriptor.scopeUrl });

    let runningVersionId = '';
    await expect.poll(() => {
      const running = [...versions.values()].find((version) =>
        String(version.scriptURL || '') === descriptor.scriptUrl
        && String(version.runningStatus || '') === 'running'
      );
      runningVersionId = String(running?.versionId || '');
      return runningVersionId;
    }, { timeout: 10_000 }).not.toBe('');

    await session.send('ServiceWorker.stopWorker', { versionId: runningVersionId });
    await expect.poll(() => {
      const version = versions.get(runningVersionId);
      return String(version?.runningStatus || '');
    }, { timeout: 10_000 }).toBe('stopped');

    await session.send('ServiceWorker.startWorker', { scopeURL: descriptor.scopeUrl });
    await expect.poll(() => [...versions.values()].some((version) =>
      String(version.scriptURL || '') === descriptor.scriptUrl
      && String(version.runningStatus || '') === 'running'
    ), { timeout: 10_000 }).toBe(true);

    return {
      extensionId: descriptor.extensionId,
      scriptUrl: descriptor.scriptUrl,
      scopeUrl: descriptor.scopeUrl
    };
  } finally {
    await session.detach().catch(() => {});
  }
}

async function notifierMessage(page, message) {
  const payload = JSON.stringify(message);
  return evaluateInExtensionWorld(page, 'ChatGPT Response Notifier', `(async () => {
    return await chrome.runtime.sendMessage(${payload});
  })()`);
}

async function notifierWatchdog(page, conversationId = fixtureConversationId) {
  const control = await notifierControlPage(page);
  return control.evaluate(async (id) => {
    const DB_NAME = 'chatgpt-response-notifier-monitor';
    const DB_VERSION = 1;
    const PROFILE_STORE = 'profile';
    const key = `code-watchdog:${id}`;
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open watchdog database.'));
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(PROFILE_STORE, 'readonly');
        const request = transaction.objectStore(PROFILE_STORE).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('Could not read watchdog record.'));
      });
    } finally {
      try { database.close(); } catch {}
    }
  }, conversationId);
}

async function prepareNonTerminalNotifier(page) {
  await page.evaluate(() => {
    const wrapper = document.querySelector('[data-testid="conversation-turn-1"]');
    wrapper?.querySelector('.rendered-footer')?.remove();
    const markdown = wrapper?.querySelector('.markdown');
    if (markdown) markdown.textContent = 'Browser-level work is still in progress.';
  });

  // The real status runtime intentionally remembers a terminal code for the
  // current prompt once observed. Reinject it from the actual extension origin
  // after removing the fixture terminal so watchdog cases start nonterminal.
  const control = await notifierControlPage(page);
  await control.evaluate(async (conversationId) => {
    const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    const target = tabs.find((tab) => {
      try { return new URL(String(tab.url || '')).pathname === `/c/${conversationId}`; }
      catch { return false; }
    });
    if (!Number.isInteger(target?.id)) throw new Error('Playwright ChatGPT fixture tab not found.');
    await chrome.scripting.executeScript({
      target: { tabId: target.id },
      files: ['status-code.js', 'status-policy.js', 'status-script.js']
    });
  }, fixtureConversationId);

  await expect.poll(() => evaluateInExtensionWorld(page, 'ChatGPT Response Notifier', `(() => {
    return String(globalThis.__chatgptNotifierStatusDom?.latestAssistantSnapshot?.()?.statusCode || '');
  })()`), { timeout: 10_000 }).toBe('');
}

async function enableNotifierAutomation(page) {
  const result = await notifierMessage(page, {
    type: 'SET_BUILD_AUTOMATION_STATE_FOR_SENDER',
    enabled: true,
    requestId: 'playwright-enable-automation'
  });
  expect(result?.ok).toBe(true);

  await expect.poll(async () => {
    const watchdog = await notifierWatchdog(page);
    return {
      exists: Boolean(watchdog),
      stopped: watchdog?.stopped === true,
      deadlineAt: Math.max(0, Number(watchdog?.deadlineAt || 0))
    };
  }, { timeout: 15_000 }).toMatchObject({ exists: true, stopped: false });

  return await notifierWatchdog(page);
}

async function seedWatchdogDue(page, conversationId = fixtureConversationId) {
  const control = await notifierControlPage(page);
  return control.evaluate(async (id) => {
    const DB_NAME = 'chatgpt-response-notifier-monitor';
    const DB_VERSION = 1;
    const PROFILE_STORE = 'profile';
    const key = `code-watchdog:${id}`;
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open watchdog database.'));
    });

    try {
      const current = await new Promise((resolve, reject) => {
        const transaction = database.transaction(PROFILE_STORE, 'readonly');
        const request = transaction.objectStore(PROFILE_STORE).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('Could not read watchdog record.'));
      });
      if (!current) throw new Error('Watchdog record missing before due-state seed.');

      const next = {
        ...current,
        deadlineAt: Date.now() - 1000,
        retryAt: 0,
        retryReason: '',
        stopped: false,
        stopReason: '',
        watchdogRevision: Math.max(0, Number(current.watchdogRevision || 0)) + 1,
        updatedAt: Date.now()
      };

      await new Promise((resolve, reject) => {
        const transaction = database.transaction(PROFILE_STORE, 'readwrite');
        transaction.objectStore(PROFILE_STORE).put(next);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('Could not seed due watchdog record.'));
        transaction.onabort = () => reject(transaction.error || new Error('Due watchdog seed was aborted.'));
      });
      return next;
    } finally {
      try { database.close(); } catch {}
    }
  }, conversationId);
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

test('Quick Continue MV3 worker stop/wake does not rebuild live page UI', async ({ fixturePage, chatgptTraffic }) => {
  const toolbar = fixturePage.locator(toolbarSelector);
  await expect(toolbar).toBeVisible();
  const original = await fixturePage.evaluateHandle(() => document.getElementById('chatgpt-quick-continue-toolbar'));
  const before = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Quick Continue', `(() => ({
    runtimeVersion: Number(globalThis.__chatgptQuickContinueRuntime?.version || 0),
    hoverVersion: Number(globalThis.__chatgptQuickContinueHoverEditRuntime?.version || 0)
  }))()`);

  const restarted = await restartExtensionServiceWorker(fixturePage, 'ChatGPT Quick Continue');
  expect(restarted.scriptUrl.endsWith('/background.js')).toBe(true);
  await fixturePage.waitForTimeout(800);

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
  await prepareNonTerminalNotifier(fixturePage);
  const armed = await enableNotifierAutomation(fixturePage);
  expect(String(armed?.lastPromptKey || '')).not.toBe('');

  const rejected = await notifierMessage(fixturePage, {
    type: 'FORCE_PARK_CODE_WATCHDOG_TERMINAL_V3',
    conversationId: fixtureConversationId,
    promptKey: `${armed.lastPromptKey}-superseded`,
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
  await prepareNonTerminalNotifier(fixturePage);
  const armed = await enableNotifierAutomation(fixturePage);
  expect(String(armed?.lastPromptKey || '')).not.toBe('');

  await seedWatchdogDue(fixturePage);
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
