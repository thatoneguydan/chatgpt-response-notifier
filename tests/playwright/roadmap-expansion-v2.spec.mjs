import {
  test,
  expect,
  evaluateInExtensionWorld
} from './extension-fixture.mjs';

const toolbarSelector = '#chatgpt-quick-continue-toolbar';
const fixtureConversationId = 'playwright-browser-regression';
const watchdogDelayMs = 30 * 60_000;

async function expectTrafficInert(traffic) {
  const blocked = traffic.filter((entry) => entry.kind === 'blocked');
  expect(blocked, `Unexpected ChatGPT network attempts: ${JSON.stringify(blocked)}`).toEqual([]);
}

async function extensionMessage(page, extensionName, message) {
  const payload = JSON.stringify(message);
  return evaluateInExtensionWorld(page, extensionName, `(async () => {
    return await chrome.runtime.sendMessage(${payload});
  })()`);
}

async function notifierMessage(page, message) {
  return extensionMessage(page, 'ChatGPT Response Notifier', message);
}

async function notifierOverview(page) {
  const overview = await notifierMessage(page, {
    type: 'GET_BUILD_AUTOMATION_OVERVIEW_FOR_SENDER'
  });
  if (overview?.ok !== true) {
    throw new Error(`Notifier overview unavailable: ${String(overview?.error || overview?.reason || 'unknown')}`);
  }
  return overview;
}

async function prepareNonTerminalNotifier(page) {
  await page.evaluate(() => {
    const wrapper = document.querySelector('[data-testid="conversation-turn-1"]');
    wrapper?.querySelector('.rendered-footer')?.remove();
    const markdown = wrapper?.querySelector('.markdown');
    if (markdown) markdown.textContent = 'Browser-level work is still in progress.';
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

  const enabled = await notifierMessage(page, {
    type: 'SET_BUILD_AUTOMATION_STATE_FOR_SENDER',
    enabled: true,
    requestId: 'playwright-enable-automation'
  });
  expect(enabled?.ok).toBe(true);
  expect(enabled?.automationEnabled).toBe(true);

  const armed = await notifierMessage(page, {
    type: 'ARM_CODE_WATCHDOG_FOR_SENDER',
    conversationId: fixtureConversationId,
    promptKey,
    source: 'playwright-browser-regression',
    requestId: 'playwright-arm-watchdog'
  });
  expect(armed?.ok).toBe(true);
  expect(armed?.armed).toBe(true);
  return { promptKey, armed };
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

test('scheduled MV3 background wake does not rebuild the live Quick Continue toolbar', async ({ fixturePage, chatgptTraffic }) => {
  test.setTimeout(95_000);
  const toolbar = fixturePage.locator(toolbarSelector);
  await expect(toolbar).toBeVisible();
  const original = await fixturePage.evaluateHandle(() => document.getElementById('chatgpt-quick-continue-toolbar'));
  const before = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Quick Continue', `(() => ({
    runtimeVersion: Number(globalThis.__chatgptQuickContinueRuntime?.version || 0),
    hoverVersion: Number(globalThis.__chatgptQuickContinueHoverEditRuntime?.version || 0)
  }))()`);

  // production background.js schedules its first managed-update alarm one minute
  // after worker startup. Waiting beyond that boundary exercises an ordinary MV3
  // background wake while the fixture page remains live; the wake must not run
  // destructive content-script reinjection or replace the toolbar owner.
  await fixturePage.waitForTimeout(70_000);

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

test('rendered definitive terminal status rejects stale ownership then persists the real watchdog stop', async ({ fixturePage, chatgptTraffic }) => {
  const { promptKey, armed } = await prepareNonTerminalNotifier(fixturePage);
  expect(String(armed?.codeWatchdog?.lastPromptKey || '')).toBe(promptKey);
  expect(armed?.codeWatchdog?.stopped === true).toBe(false);

  const rejected = await notifierMessage(fixturePage, {
    type: 'FORCE_PARK_CODE_WATCHDOG_TERMINAL_V3',
    conversationId: fixtureConversationId,
    promptKey: `${promptKey}-superseded`,
    statusCode: 'COMPLETE_APPLIED'
  });
  expect(rejected).toMatchObject({ ok: false, reason: 'terminal-prompt-superseded' });
  expect((await notifierOverview(fixturePage))?.codeWatchdog?.stopped === true).toBe(false);

  await fixturePage.evaluate(() => {
    const wrapper = document.querySelector('[data-testid="conversation-turn-1"]');
    const footer = document.createElement('div');
    footer.className = 'rendered-footer';
    footer.textContent = '[GITHUB_STATUS: COMPLETE_APPLIED]';
    wrapper?.append(footer);
  });

  await expect.poll(async () => {
    const watchdog = (await notifierOverview(fixturePage))?.codeWatchdog || null;
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

test('browser watchdog arm establishes the 30-minute floor and refuses immediate replay', async ({ fixturePage, chatgptTraffic }) => {
  const startedAt = Date.now();
  const { armed } = await prepareNonTerminalNotifier(fixturePage);
  const watchdog = armed?.codeWatchdog || null;
  const deadlineAt = Math.max(0, Number(watchdog?.deadlineAt || 0));

  expect(Math.max(0, Number(watchdog?.sendCount || 0))).toBe(0);
  expect(Math.max(0, Number(watchdog?.retryAt || 0))).toBe(0);
  expect(deadlineAt).toBeGreaterThanOrEqual(startedAt + watchdogDelayMs - 5_000);
  expect(deadlineAt).toBeLessThanOrEqual(Date.now() + watchdogDelayMs + 5_000);

  const immediate = await notifierMessage(fixturePage, {
    type: 'RUN_CODE_WATCHDOG_NOW_V3',
    conversationId: fixtureConversationId
  });
  expect(immediate).toMatchObject({ ok: true, ran: false, reason: 'watchdog-not-due' });
  expect(await fixturePage.evaluate(() => window.__fixture.submits.length)).toBe(0);

  const after = (await notifierOverview(fixturePage))?.codeWatchdog || null;
  expect(Math.max(0, Number(after?.sendCount || 0))).toBe(0);
  expect(Math.max(0, Number(after?.retryAt || 0))).toBe(0);
  expect(Math.max(0, Number(after?.deadlineAt || 0))).toBe(deadlineAt);
  await expectTrafficInert(chatgptTraffic);
});
