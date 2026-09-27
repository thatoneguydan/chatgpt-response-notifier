import {
  test,
  expect,
  evaluateInExtensionWorld
} from './wrapped-extension-fixture.mjs';

const toolbarSelector = '#chatgpt-quick-continue-toolbar';
const fixtureConversationId = 'playwright-browser-regression';
const workerCommandKey = 'playwright-test:worker-command';
const workerResponsePrefix = 'playwright-test:worker-response:';

async function expectTrafficInert(traffic) {
  const blocked = traffic.filter((entry) => entry.kind === 'blocked');
  expect(blocked, `Unexpected ChatGPT network attempts: ${JSON.stringify(blocked)}`).toEqual([]);
}

async function testControl(page, extensionName, message) {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const responseKey = `${workerResponsePrefix}${requestId}`;
  const command = { ...message, requestId, issuedAt: Date.now() };
  const commandJson = JSON.stringify(command);
  const responseKeyJson = JSON.stringify(responseKey);
  const commandKeyJson = JSON.stringify(workerCommandKey);

  await evaluateInExtensionWorld(page, extensionName, `(async () => {
    await chrome.storage.local.remove(${responseKeyJson});
    await chrome.storage.local.set({ [${commandKeyJson}]: ${commandJson} });
    return true;
  })()`);

  let response = null;
  await expect.poll(async () => {
    response = await evaluateInExtensionWorld(page, extensionName, `(async () => {
      const values = await chrome.storage.local.get(${responseKeyJson});
      return values?.[${responseKeyJson}] || null;
    })()`);
    return response?.ok === true ? 'ok' : response?.ok === false ? 'error' : 'pending';
  }, {
    timeout: 12_000,
    message: `Worker control did not settle for ${extensionName}: ${message?.type || 'unknown'}`
  }).not.toBe('pending');

  await evaluateInExtensionWorld(page, extensionName, `(async () => {
    await chrome.storage.local.remove([${responseKeyJson}, ${commandKeyJson}]);
    return true;
  })()`).catch(() => false);

  if (response?.ok !== true) {
    throw new Error(`Playwright worker control failed: ${String(response?.error || 'unknown')}`);
  }
  return response.result;
}

async function notifierWatchdog(page, conversationId = fixtureConversationId) {
  return testControl(page, 'ChatGPT Response Notifier', {
    type: 'PLAYWRIGHT_TEST_READ_WATCHDOG',
    conversationId
  });
}

async function prepareNonTerminalNotifier(page) {
  await page.evaluate(() => {
    const wrapper = document.querySelector('[data-testid="conversation-turn-1"]');
    wrapper?.querySelector('.rendered-footer')?.remove();
    const markdown = wrapper?.querySelector('.markdown');
    if (markdown) markdown.textContent = 'Browser-level work is still in progress.';
  });

  await testControl(page, 'ChatGPT Response Notifier', {
    type: 'PLAYWRIGHT_TEST_INJECT_STATUS_RUNTIME',
    conversationId: fixtureConversationId
  });

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
  return testControl(page, 'ChatGPT Response Notifier', {
    type: 'PLAYWRIGHT_TEST_SEED_WATCHDOG',
    conversationId: fixtureConversationId,
    promptKey,
    due
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
  test.setTimeout(100_000);
  const toolbar = fixturePage.locator(toolbarSelector);
  await expect(toolbar).toBeVisible();
  const original = await fixturePage.evaluateHandle(() => document.getElementById('chatgpt-quick-continue-toolbar'));
  const beforeRuntime = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Quick Continue', `(() => ({
    runtimeVersion: Number(globalThis.__chatgptQuickContinueRuntime?.version || 0),
    hoverVersion: Number(globalThis.__chatgptQuickContinueHoverEditRuntime?.version || 0)
  }))()`);
  const beforeWorker = await testControl(fixturePage, 'ChatGPT Quick Continue', {
    type: 'PLAYWRIGHT_TEST_WORKER_GENERATION'
  });
  expect(beforeWorker.extensionName).toBe('ChatGPT Quick Continue');
  expect(String(beforeWorker.generation || '')).not.toBe('');

  // Chrome terminates idle MV3 extension workers after roughly 30 seconds. A
  // storage-change extension event wakes the worker without relying on CDP's
  // web-service-worker control path; a new generation proves global recreation.
  await fixturePage.waitForTimeout(40_000);
  const afterWorker = await testControl(fixturePage, 'ChatGPT Quick Continue', {
    type: 'PLAYWRIGHT_TEST_WORKER_GENERATION'
  });
  expect(afterWorker.extensionName).toBe('ChatGPT Quick Continue');
  expect(afterWorker.generation).not.toBe(beforeWorker.generation);

  await fixturePage.waitForTimeout(500);
  const afterRuntime = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Quick Continue', `(() => ({
    runtimeVersion: Number(globalThis.__chatgptQuickContinueRuntime?.version || 0),
    hoverVersion: Number(globalThis.__chatgptQuickContinueHoverEditRuntime?.version || 0)
  }))()`);
  expect(await fixturePage.evaluate(
    (node) => node === document.getElementById('chatgpt-quick-continue-toolbar') && node?.isConnected === true,
    original
  )).toBe(true);
  expect(afterRuntime).toEqual(beforeRuntime);
  await expect(toolbar).toHaveCount(1);
  await expect(toolbar).toBeVisible();
  await expectTrafficInert(chatgptTraffic);
});

test('terminal stop rejects a superseded prompt then persists the rendered definitive stop', async ({ fixturePage, chatgptTraffic }) => {
  const promptKey = await prepareNonTerminalNotifier(fixturePage);
  const armed = await seedEnabledWatchdog(fixturePage, promptKey);
  expect(String(armed?.lastPromptKey || '')).toBe(promptKey);

  const rejected = await testControl(fixturePage, 'ChatGPT Response Notifier', {
    type: 'PLAYWRIGHT_TEST_FORCE_TERMINAL_STOP',
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

  const first = await testControl(fixturePage, 'ChatGPT Response Notifier', {
    type: 'PLAYWRIGHT_TEST_RUN_DUE_WATCHDOG',
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

  const second = await testControl(fixturePage, 'ChatGPT Response Notifier', {
    type: 'PLAYWRIGHT_TEST_RUN_DUE_WATCHDOG',
    conversationId: fixtureConversationId
  });
  expect(second).toMatchObject({ ok: true, ran: false, reason: 'watchdog-not-due' });
  await fixturePage.waitForTimeout(1000);
  expect(await fixturePage.evaluate(() => window.__fixture.submits.length)).toBe(1);
  await expectTrafficInert(chatgptTraffic);
});
