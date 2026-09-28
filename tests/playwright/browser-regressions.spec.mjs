import {
  test,
  expect,
  extensionWorldNames,
  evaluateInExtensionWorld
} from './extension-fixture.mjs';

const toolbarSelector = '#chatgpt-quick-continue-toolbar';

async function expectTrafficInert(traffic) {
  const blocked = traffic.filter((entry) => entry.kind === 'blocked');
  expect(blocked, `Unexpected ChatGPT network attempts: ${JSON.stringify(blocked)}`).toEqual([]);
}

async function waitForStableToolbarOwner(page, stableMs = 1500, timeoutMs = 7500) {
  let ownerToken = '';
  let stableSince = 0;
  await expect.poll(async () => {
    const currentToken = await page.evaluate(() => {
      const toolbar = document.getElementById('chatgpt-quick-continue-toolbar');
      if (!toolbar) return '';
      if (!toolbar.dataset.playwrightOwnerToken) {
        toolbar.dataset.playwrightOwnerToken = crypto.randomUUID();
      }
      return toolbar.dataset.playwrightOwnerToken;
    });
    const now = Date.now();
    if (!currentToken) {
      ownerToken = '';
      stableSince = 0;
      return 0;
    }
    if (currentToken !== ownerToken) {
      ownerToken = currentToken;
      stableSince = now;
      return 0;
    }
    return now - stableSince;
  }, {
    timeout: timeoutMs,
    message: 'Quick Continue toolbar owner did not stabilize after fresh extension install'
  }).toBeGreaterThanOrEqual(stableMs);
}

async function quickContinueDiagnostics(page) {
  return evaluateInExtensionWorld(page, 'ChatGPT Quick Continue', `(async () => {
    const composer = document.querySelector('#prompt-textarea');
    const sendButton = document.querySelector('button[data-testid="send-button"]');
    let config = null;
    let configError = '';
    try { config = await globalThis.ChatGPTQuickContinueConfig?.load?.(); }
    catch (error) { configError = String(error?.message || error || ''); }
    return {
      runtimeVersion: Number(globalThis.__chatgptQuickContinueRuntime?.version || 0),
      hoverVersion: Number(globalThis.__chatgptQuickContinueHoverEditRuntime?.version || 0),
      manualTimestampEnabled: globalThis.__chatgptQuickContinueHoverEditRuntime?.manualTimestampEnabled === true,
      sendVersion: Number(globalThis.ChatGPTQuickContinueSend?.version || 0),
      composerVersion: Number(globalThis.ChatGPTQuickContinueComposer?.version || 0),
      composerText: String(globalThis.ChatGPTQuickContinueComposer?.read?.(composer) || ''),
      sendDisabled: Boolean(sendButton?.disabled),
      toolbarPresent: Boolean(document.getElementById('chatgpt-quick-continue-toolbar')),
      configLoaded: Boolean(config),
      configError
    };
  })()`);
}

test('loads both production MV3 extension worlds in headless Chromium', async ({ fixturePage, chatgptTraffic }) => {
  expect(await extensionWorldNames(fixturePage)).toEqual([
    'ChatGPT Quick Continue',
    'ChatGPT Response Notifier'
  ]);
  await expect(fixturePage.locator(toolbarSelector)).toHaveCount(1);
  await expect(fixturePage.locator(toolbarSelector)).toBeVisible();
  await expect(fixturePage.locator('html')).toHaveAttribute('data-chatgpt-notifier-automation-owner', /.+/);
  await expectTrafficInert(chatgptTraffic);
});

test('keeps one stable Quick Continue toolbar across composer remounts and SPA navigation', async ({ fixturePage, chatgptTraffic }) => {
  const toolbar = fixturePage.locator(toolbarSelector);
  await expect(toolbar).toHaveCount(1);
  await expect(toolbar).toBeVisible();
  const original = await fixturePage.evaluateHandle(() => document.getElementById('chatgpt-quick-continue-toolbar'));

  for (let index = 1; index <= 6; index += 1) {
    await fixturePage.evaluate((iteration) => {
      window.__fixture.remountComposer();
      history.pushState({}, '', `/c/playwright-browser-regression?remount=${iteration}`);
    }, index);
    await expect(toolbar).toHaveCount(1);
  }

  await fixturePage.waitForTimeout(800);
  expect(await fixturePage.evaluate(
    (node) => node === document.getElementById('chatgpt-quick-continue-toolbar') && node?.isConnected === true,
    original
  )).toBe(true);
  await expect(toolbar).toBeVisible();
  await expect(fixturePage.getByRole('button', { name: 'Send timestamped Continue' })).toBeEnabled();
  await expectTrafficInert(chatgptTraffic);
});

test('Quick Continue exact Continue transaction reaches one browser form submit', async ({ fixturePage, chatgptTraffic }) => {
  const result = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Quick Continue', `(async () => {
    const composer = document.querySelector('#prompt-textarea');
    const config = await globalThis.ChatGPTQuickContinueConfig.load();
    const prompt = globalThis.ChatGPTQuickContinuePrompts.continuePrompt(config.continueText, new Date());
    const sendResult = await globalThis.ChatGPTQuickContinueSend.submit(composer, prompt, { replace: true });
    return { prompt, sendResult };
  })()`);

  const submissions = await fixturePage.evaluate(() => window.__fixture.submits.map((entry) => entry.text));
  const diagnostics = await quickContinueDiagnostics(fixturePage);
  expect(result.sendResult).toMatchObject({ ok: true, reason: 'sent', activated: true });
  expect(submissions, `Quick Continue diagnostics: ${JSON.stringify(diagnostics)}`).toEqual([result.prompt]);
  expect(submissions[0]).toContain('Continue until you finish or need something from me.');
  expect(diagnostics.composerText).toBe('');
  await expectTrafficInert(chatgptTraffic);
});

test('keyboard timestamp toggle preserves one exact logical newline and trusted Enter sends once', async ({ fixturePage, chatgptTraffic }) => {
  const toolbar = fixturePage.locator(toolbarSelector);
  await expect(toolbar).toBeVisible();
  await waitForStableToolbarOwner(fixturePage);

  const clock = fixturePage.getByLabel('Current local time');
  await clock.focus();
  await clock.press('Enter');
  await expect(clock).toHaveAttribute('aria-pressed', 'true');

  const composer = fixturePage.locator('#prompt-textarea');
  await composer.fill('first line\nsecond line');
  await expect.poll(async () => {
    const diagnostics = await quickContinueDiagnostics(fixturePage);
    return {
      manualTimestampEnabled: diagnostics.manualTimestampEnabled,
      composerText: diagnostics.composerText,
      sendDisabled: diagnostics.sendDisabled
    };
  }, {
    timeout: 5_000,
    message: 'Timestamp send preconditions changed before trusted Enter'
  }).toEqual({
    manualTimestampEnabled: true,
    composerText: 'first line\nsecond line',
    sendDisabled: false
  });

  await composer.press('Enter');

  await expect.poll(() => fixturePage.evaluate(() => window.__fixture.submits.length), { timeout: 5_000 }).toBe(1);
  await fixturePage.waitForTimeout(300);
  const submissions = await fixturePage.evaluate(() => window.__fixture.submits.map((entry) => entry.text));
  const diagnostics = await quickContinueDiagnostics(fixturePage);
  expect(submissions, `Quick Continue diagnostics: ${JSON.stringify(diagnostics)}`).toHaveLength(1);
  expect(submissions[0].endsWith('first line\nsecond line')).toBe(true);
  expect(submissions[0]).not.toContain('first line\n\nsecond line');
  expect(diagnostics.composerText).toBe('');
  await expectTrafficInert(chatgptTraffic);
});

test('notifier terminal detector sees a footer sibling inside the same assistant turn wrapper', async ({ fixturePage, chatgptTraffic }) => {
  await expect(fixturePage.locator('[data-testid="conversation-turn-1"]')).toBeVisible();

  const detection = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Response Notifier', `(() => {
    const api = globalThis.ChatGPTNotifierRenderedTerminalStatus;
    const wrapper = document.querySelector('[data-testid="conversation-turn-1"]');
    const semanticAssistant = wrapper?.querySelector('[data-message-author-role="assistant"]');
    return {
      version: Number(api?.version || 0),
      wrapper: String(api?.detect?.(wrapper) || ''),
      semanticAssistant: String(api?.detect?.(semanticAssistant) || '')
    };
  })()`);

  expect(detection).toEqual({
    version: 3,
    wrapper: 'COMPLETE_APPLIED',
    semanticAssistant: 'COMPLETE_APPLIED'
  });
  await expectTrafficInert(chatgptTraffic);
});

test('notifier terminal detector crosses deep same-turn wrappers until a neighboring turn boundary', async ({ fixturePage, chatgptTraffic }) => {
  await fixturePage.evaluate(() => {
    const turn = document.querySelector('[data-testid="conversation-turn-1"]');
    const semanticAssistant = turn?.querySelector('[data-message-author-role="assistant"]');
    const footer = turn?.querySelector('.rendered-footer');
    if (!turn || !semanticAssistant || !footer) throw new Error('Fixture assistant turn is incomplete.');

    footer.remove();
    let current = turn;
    for (let depth = 0; depth < 6; depth += 1) {
      const wrapper = document.createElement('div');
      current.replaceWith(wrapper);
      wrapper.append(current);
      current = wrapper;
    }
    current.append(footer);
  });

  const detection = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Response Notifier', `(() => {
    const api = globalThis.ChatGPTNotifierRenderedTerminalStatus;
    const semanticAssistant = document.querySelector('[data-message-author-role="assistant"]');
    return String(api?.detect?.(semanticAssistant) || '');
  })()`);

  expect(detection).toBe('COMPLETE_APPLIED');
  await expectTrafficInert(chatgptTraffic);
});
