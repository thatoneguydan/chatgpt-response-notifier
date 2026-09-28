import {
  test,
  expect,
  evaluateInExtensionWorld
} from './extension-fixture.mjs';

const toolbarSelector = '#chatgpt-quick-continue-toolbar';

async function expectTrafficInert(traffic) {
  const blocked = traffic.filter((entry) => entry.kind === 'blocked');
  expect(blocked, `Unexpected ChatGPT network attempts: ${JSON.stringify(blocked)}`).toEqual([]);
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
