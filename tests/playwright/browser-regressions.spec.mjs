import { test, expect, waitForExtensionWorkers } from './extension-fixture.mjs';

const toolbarSelector = '#chatgpt-quick-continue-toolbar';

async function expectTrafficInert(traffic) {
  const blocked = traffic.filter((entry) => entry.kind === 'blocked');
  expect(blocked, `Unexpected ChatGPT network attempts: ${JSON.stringify(blocked)}`).toEqual([]);
}

test('loads both production MV3 extensions in headless Chromium', async ({ extensionContext, fixturePage, chatgptTraffic }) => {
  const workers = await waitForExtensionWorkers(extensionContext);
  expect([...workers.keys()].sort()).toEqual([
    'ChatGPT Quick Continue',
    'ChatGPT Response Notifier'
  ]);
  await expect(fixturePage.locator(toolbarSelector)).toHaveCount(1);
  await expect(fixturePage.locator(toolbarSelector)).toBeVisible();
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
  await expectTrafficInert(chatgptTraffic);
});

test('Continue performs exactly one browser-native form submission', async ({ fixturePage, chatgptTraffic }) => {
  await expect(fixturePage.locator(toolbarSelector)).toBeVisible();
  await fixturePage.getByRole('button', { name: 'Send timestamped Continue' }).click();

  await expect.poll(() => fixturePage.evaluate(() => window.__fixture.submits.length)).toBe(1);
  await fixturePage.waitForTimeout(300);
  const submissions = await fixturePage.evaluate(() => window.__fixture.submits.map((entry) => entry.text));
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toContain('Continue until you finish or need something from me.');
  await expectTrafficInert(chatgptTraffic);
});

test('manual timestamp submission preserves one exact logical newline and sends once', async ({ fixturePage, chatgptTraffic }) => {
  const toolbar = fixturePage.locator(toolbarSelector);
  await expect(toolbar).toBeVisible();

  const clock = fixturePage.getByLabel('Current local time');
  await clock.click();
  await expect(clock).toHaveAttribute('aria-pressed', 'true');

  const composer = fixturePage.locator('#prompt-textarea');
  await composer.fill('first line\nsecond line');
  await composer.press('Enter');

  await expect.poll(() => fixturePage.evaluate(() => window.__fixture.submits.length)).toBe(1);
  await fixturePage.waitForTimeout(300);
  const submissions = await fixturePage.evaluate(() => window.__fixture.submits.map((entry) => entry.text));
  expect(submissions).toHaveLength(1);
  expect(submissions[0].endsWith('first line\nsecond line')).toBe(true);
  expect(submissions[0]).not.toContain('first line\n\nsecond line');
  await expectTrafficInert(chatgptTraffic);
});

test('notifier terminal detector sees a footer sibling inside the same assistant turn wrapper', async ({ extensionContext, fixturePage, chatgptTraffic }) => {
  await expect(fixturePage.locator('[data-testid="conversation-turn-1"]')).toBeVisible();
  const workers = await waitForExtensionWorkers(extensionContext);
  const notifier = workers.get('ChatGPT Response Notifier');
  expect(notifier).toBeTruthy();

  const detection = await notifier.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    const tab = tabs.find((candidate) => candidate.url?.includes('/c/playwright-browser-regression'));
    if (!tab?.id) throw new Error('Fixture tab not found.');

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['status-code.js', 'rendered-terminal-status.js']
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const api = globalThis.ChatGPTNotifierRenderedTerminalStatus;
        const wrapper = document.querySelector('[data-testid="conversation-turn-1"]');
        const semanticAssistant = wrapper?.querySelector('[data-message-author-role="assistant"]');
        return {
          version: Number(api?.version || 0),
          wrapper: String(api?.detect?.(wrapper) || ''),
          semanticAssistant: String(api?.detect?.(semanticAssistant) || '')
        };
      }
    });
    return results[0]?.result || null;
  });

  expect(detection).toEqual({
    version: 2,
    wrapper: 'COMPLETE_APPLIED',
    semanticAssistant: 'COMPLETE_APPLIED'
  });
  await expectTrafficInert(chatgptTraffic);
});
