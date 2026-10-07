import fs from 'node:fs';
import path from 'node:path';
import { test, expect, repoRoot, evaluateInExtensionWorld, extensionWorker } from './extension-fixture.mjs';

const toolbar = '#chatgpt-quick-continue-toolbar';
const simple = '#chatgpt-quick-continue-simple-watchdog';
const countdown = '#chatgpt-quick-continue-simple-countdown';
const menuButtonName = 'Quick Continue menu';

async function openQuickContinueMenu(page) {
  const simpleButton = page.locator(simple);
  await expect(simpleButton).toHaveCount(1);
  for (let attempt = 0; attempt < 4 && !(await simpleButton.isVisible()); attempt += 1) {
    const menuButton = page.getByRole('button', { name: menuButtonName, exact: true });
    await expect(menuButton).toHaveCount(1);
    await menuButton.click();
    if (await simpleButton.isVisible()) break;
    await page.waitForTimeout(100);
  }
  await expect(simpleButton).toBeVisible();
}
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'standalone-quick-continue/manifest.json'), 'utf8'));
const runtimeFiles = manifest.content_scripts[0].js;

async function hotReplace(context) {
  const worker = await extensionWorker(context, 'ChatGPT Quick Continue');
  expect(worker, 'Quick Continue MV3 worker must be loaded').toBeTruthy();
  await worker.evaluate(async (files) => {
    const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    for (const tab of tabs) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
  }, runtimeFiles);
}

test('Simple lives in the hamburger menu and starts its own timer despite draft, terminal footer and inactive smart monitoring', async ({ fixturePage, chatgptTraffic }) => {
  await fixturePage.locator('#prompt-textarea').fill('An existing draft must not prevent starting the timer.');
  await expect(fixturePage.locator(simple)).toBeHidden();
  const buttons = await Promise.all([
    fixturePage.getByRole('button', { name: 'Send timestamped Continue', exact: true }).boundingBox(),
    fixturePage.getByRole('button', { name: 'Project Continue', exact: true }).boundingBox(),
    fixturePage.getByRole('button', { name: menuButtonName, exact: true }).boundingBox()
  ]);
  expect(buttons.every(Boolean)).toBe(true);
  expect(buttons[0].x).toBeLessThan(buttons[1].x);
  expect(buttons[1].x).toBeLessThan(buttons[2].x);
  await openQuickContinueMenu(fixturePage);
  const clickedAt = Date.now();
  await fixturePage.locator(simple).click();
  await expect(fixturePage.locator(simple)).toHaveAttribute('aria-pressed', 'true');
  await expect(fixturePage.locator(countdown)).toBeVisible();
  await expect(fixturePage.locator(countdown)).toContainText('3 auto-continues left');
  const state = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Quick Continue', `chrome.runtime.sendMessage({ type: 'QUICK_CONTINUE_SIMPLE_WATCHDOG_GET', conversationId: 'playwright-browser-regression' })`);
  expect(state.enabled).toBe(true);
  expect(state.phase).toBe('countdown');
  expect(state.nextAt - clickedAt).toBeGreaterThan(1_798_000);
  expect(state.nextAt - clickedAt).toBeLessThan(1_802_000);
  expect(await fixturePage.locator(`${toolbar} [role="status"]`).textContent()).toBe('');
  await fixturePage.locator(simple).click();
  await expect(fixturePage.locator(simple)).toHaveAttribute('aria-pressed', 'false');
  await expect(fixturePage.locator(countdown)).toBeHidden();
  expect(await fixturePage.locator('#prompt-textarea').textContent()).toContain('An existing draft');
  expect(chatgptTraffic.filter((entry) => entry.kind === 'blocked')).toEqual([]);
});

test('Monitor arms its independent watchdog without toggling hamburger Simple', async ({ fixturePage }) => {
  const monitorControl = fixturePage.locator('[id^="chatgpt-notifier-control-v"]');
  await expect(monitorControl).toHaveCount(1);

  // The persistent fixture may enter this test paused from prior Monitor use.
  // Drive it to enabled deterministically without asserting a particular
  // persisted off-state label.
  const initialLabel = String(await monitorControl.getAttribute('aria-label') || '');
  if (!/Build automation: Pause/.test(initialLabel)) {
    await monitorControl.click();
  }
  await expect(monitorControl).toHaveAttribute('aria-label', /Build automation: Pause/);

  await expect.poll(() => evaluateInExtensionWorld(
    fixturePage,
    'ChatGPT Quick Continue',
    `chrome.runtime.sendMessage({ type: 'QUICK_CONTINUE_MONITOR_WATCHDOG_GET', conversationId: 'playwright-browser-regression' })`
  )).toMatchObject({ enabled: true, phase: 'countdown' });

  const monitorCountdown = fixturePage.locator('#chatgpt-quick-continue-monitor-countdown');
  await expect(monitorCountdown).toBeVisible();
  await expect(monitorCountdown).toContainText('Monitor:');

  await openQuickContinueMenu(fixturePage);
  await expect(fixturePage.locator(simple)).toHaveAttribute('aria-pressed', 'false');
  const simpleState = await evaluateInExtensionWorld(
    fixturePage,
    'ChatGPT Quick Continue',
    `chrome.runtime.sendMessage({ type: 'QUICK_CONTINUE_SIMPLE_WATCHDOG_GET', conversationId: 'playwright-browser-regression' })`
  );
  expect(simpleState.enabled).toBe(false);

  await monitorControl.click();
  await expect(monitorControl).toHaveAttribute('aria-label', /Build automation: (Resume|Monitor)/);
  await expect.poll(() => evaluateInExtensionWorld(
    fixturePage,
    'ChatGPT Quick Continue',
    `chrome.runtime.sendMessage({ type: 'QUICK_CONTINUE_MONITOR_WATCHDOG_GET', conversationId: 'playwright-browser-regression' })`
  )).toMatchObject({ enabled: false });
  await expect(fixturePage.locator(simple)).toHaveAttribute('aria-pressed', 'false');

  // Leave the shared fixture with the hamburger closed for the next route test.
  // Monitor state changes may remount/reconcile toolbar UI, so key cleanup off
  // the actual Simple visibility instead of assuming the prior menu state.
  if (await fixturePage.locator(simple).isVisible()) {
    await fixturePage.getByRole('button', { name: menuButtonName, exact: true }).click();
  }
  await expect(fixturePage.locator(simple)).toBeHidden();
});

test('Simple starts before a new chat has a saved conversation ID', async ({ fixturePage }) => {
  await fixturePage.evaluate(() => {
    history.pushState({}, '', '/');
    window.__fixture.remountComposer();
  });
  await expect.poll(() => evaluateInExtensionWorld(
    fixturePage,
    'ChatGPT Quick Continue',
    'globalThis.__chatgptQuickContinueConversationStateRuntime?.activeConversationId ?? null',
    'https://chatgpt.com/'
  )).toBe('');
  await expect(fixturePage.locator(simple)).toBeHidden();
  await openQuickContinueMenu(fixturePage);
  await fixturePage.locator(simple).click();
  await expect(fixturePage.locator(simple)).toHaveAttribute('aria-pressed', 'true');
  await expect(fixturePage.locator(countdown)).toBeVisible();
});

test('JSON editor shares the hamburger popover with Simple and fits the viewport', async ({ fixturePage }) => {
  await openQuickContinueMenu(fixturePage);
  await fixturePage.locator(simple).click();
  await expect(fixturePage.locator(countdown)).toBeVisible();
  await fixturePage.getByRole('button', { name: 'Edit Quick Continue JSON', exact: true }).click();
  const frame = fixturePage.locator(`${toolbar} > [role="group"][aria-label="Quick Continue menu popover"]`);
  await expect(fixturePage.getByRole('textbox', { name: 'Quick Continue JSON', exact: true })).toBeVisible();
  await expect.poll(async () => {
    const [popover, row] = await Promise.all([frame.boundingBox(), fixturePage.locator(countdown).boundingBox()]);
    return popover.y + popover.height <= row.y - 5;
  }).toBe(true);
  const bounds = await frame.boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(8);
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(1272);
});

test('repeated hot updates retire old closures even when their globals are lost', async ({ fixturePage, extensionContext }) => {
  await fixturePage.getByRole('button', { name: 'Current local time', exact: true }).click();
  await expect(fixturePage.getByRole('button', { name: 'Current local time', exact: true })).toHaveAttribute('aria-pressed', 'true');
  for (let index = 0; index < 3; index += 1) {
    await evaluateInExtensionWorld(fixturePage, 'ChatGPT Quick Continue', `(() => {
      delete globalThis.__chatgptQuickContinueRuntime;
      delete globalThis.__chatgptQuickContinueHoverEditRuntime;
      delete globalThis.__chatgptQuickContinueMonitorWatchdogRuntime;
      delete globalThis.__chatgptQuickContinueConversationStateRuntime;
      const stale = document.getElementById('chatgpt-quick-continue-toolbar').cloneNode(true);
      document.body.append(stale);
    })()`);
    await hotReplace(extensionContext);
    await expect(fixturePage.locator(toolbar)).toHaveCount(1);
    await expect(fixturePage.locator(simple)).toHaveCount(1);
    await expect(fixturePage.locator(countdown)).toHaveCount(1);
  }
  await expect(fixturePage.getByRole('button', { name: 'Current local time', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await fixturePage.locator('#prompt-textarea').fill('One submission after three updates');
  await fixturePage.locator('#prompt-textarea').press('Enter');
  await expect.poll(() => fixturePage.evaluate(() => window.__fixture.submits.length)).toBe(1);
  expect(await fixturePage.evaluate(() => window.__fixture.submits[0].text)).toMatch(/^\[.*\] One submission after three updates$/);
});

test('a native extension reload replaces controls on the open page without refreshing it', async ({ fixturePage, extensionContext }) => {
  await fixturePage.getByRole('button', { name: 'Current local time', exact: true }).click();
  await expect(fixturePage.getByRole('button', { name: 'Current local time', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const worker = await extensionWorker(extensionContext, 'ChatGPT Quick Continue');
  const token = `native-reload-${Date.now()}`;
  await fixturePage.locator(toolbar).evaluate((root, value) => { root.dataset.nativeReloadMarker = value; }, token);
  await worker.evaluate((value) => { globalThis.__nativeReloadProbe = value; }, token);
  const extensionId = new URL(worker.url()).hostname;
  const settings = await extensionContext.newPage();
  try {
    await settings.goto('chrome://extensions/');
    // Command-line loading starts unpacked extensions with developer mode off.
    // A later native reload then disables them instead of completing. Enable
    // the disposable profile's normal unpacked-extension setting first.
    await settings.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
    const loadError = await settings.evaluate((id) => chrome.developerPrivate.reload(id, { failQuietly: true, populateErrorForUnpacked: true }), extensionId);
    expect(loadError, 'Chrome must complete the native unpacked-extension reload').toBeFalsy();
  } finally {
    await settings.close();
  }
  await expect.poll(async () => {
    const current = await extensionWorker(extensionContext, 'ChatGPT Quick Continue');
    // Chrome/Playwright may reuse the Worker handle across a native reload.
    return current ? current.evaluate((value) => globalThis.__nativeReloadProbe !== value, token).catch(() => false) : false;
  }, { timeout: 10_000 }).toBe(true);
  await expect(fixturePage.locator(toolbar)).toHaveCount(1);
  await expect(fixturePage.locator(toolbar)).not.toHaveAttribute('data-native-reload-marker', token);
  await expect(fixturePage.locator(simple)).toHaveCount(1);
  await expect(fixturePage.getByRole('button', { name: 'Current local time', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await fixturePage.locator('#prompt-textarea').fill('One submission after native extension reload');
  await fixturePage.locator('#prompt-textarea').press('Enter');
  await expect.poll(() => fixturePage.evaluate(() => window.__fixture.submits.length)).toBe(1);
  expect(await fixturePage.evaluate(() => window.__fixture.submits[0].text)).toMatch(/^\[.*\] One submission after native extension reload$/);
});

test('scrolling never rereads a draft and typing does not trigger terminal scans', async ({ fixturePage, extensionContext }) => {
  await evaluateInExtensionWorld(fixturePage, 'ChatGPT Quick Continue', `(() => {
    const original = globalThis.ChatGPTQuickContinueComposer;
    globalThis.__performanceReads = 0;
    globalThis.ChatGPTQuickContinueComposer = Object.freeze({ ...original, read(node) {
      globalThis.__performanceReads += 1;
      return original.read(node);
    }});
  })()`);
  await hotReplace(extensionContext);
  await expect(fixturePage.locator(toolbar)).toHaveCount(1);
  await fixturePage.locator('#prompt-textarea').fill('A long draft '.repeat(500));
  await evaluateInExtensionWorld(fixturePage, 'ChatGPT Quick Continue', `new Promise(resolve => setTimeout(resolve, 200))`);
  const scrollReads = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Quick Continue', `(async () => {
    globalThis.__performanceReads = 0;
    for (let index = 0; index < 40; index += 1) {
      document.dispatchEvent(new Event('scroll'));
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return globalThis.__performanceReads;
  })()`);
  expect(scrollReads).toBe(0);
  // Put the composer under the same main root as the real ChatGPT page so its
  // draft mutations exercise the monitor's observer as well as terminal readers.
  await fixturePage.evaluate(() => {
    document.querySelector('main').append(document.querySelector('form[data-type="unified-composer"]'));
    // Let the earlier terminal-notification retries settle before measuring work
    // caused by typing. The separate Simple test retains the terminal footer.
    document.querySelector('.rendered-footer').remove();
    document.querySelector('[data-message-author-role="assistant"] .markdown').textContent = 'A quiet assistant reply for draft performance measurements.';
  });
  await evaluateInExtensionWorld(fixturePage, 'ChatGPT Response Notifier', `new Promise(resolve => setTimeout(resolve, 3500))`);
  const work = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Response Notifier', `(async () => {
    const original = globalThis.ChatGPTNotifierRenderedTerminalStatus;
    const clone = Element.prototype.cloneNode;
    const send = chrome.runtime.sendMessage;
    const detectionSources = [];
    const turnCloneSources = [];
    const independentDiagnosticSources = [];
    const draftPublications = [];
    globalThis.ChatGPTNotifierRenderedTerminalStatus = Object.freeze({ ...original, detect(...args) {
      const source = new Error().stack;
      // The existing no-status diagnostic has its own delayed timer and asks
      // for a fresh snapshot. Attribute that exact path separately; mutation
      // scans and all other submitted-turn work must still fail this check.
      if (source.includes('publishNoStatusDiagnostic')) independentDiagnosticSources.push(source);
      else detectionSources.push(source);
      return original.detect(...args);
    }});
    Element.prototype.cloneNode = function (...args) {
      if (this.closest('[data-testid^="conversation-turn-"]')) {
        const source = new Error().stack;
        if (source.includes('publishNoStatusDiagnostic')) independentDiagnosticSources.push(source);
        else turnCloneSources.push(source);
      }
      return clone.apply(this, args);
    };
    chrome.runtime.sendMessage = function (...args) {
      if (args[0]?.type === 'CHATGPT_MONITOR_STATE') draftPublications.push(args[0].snapshot.hasDraft);
      return send.apply(this, args);
    };
    try {
      const composer = document.getElementById('prompt-textarea');
      for (let index = 0; index < 40; index += 1) {
        composer.textContent = 'Typing draft ' + index;
        composer.dispatchEvent(new InputEvent('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await new Promise(resolve => setTimeout(resolve, 650));
      return { detectionSources, turnCloneSources, independentDiagnosticSources, draftPublications };
    } finally {
      globalThis.ChatGPTNotifierRenderedTerminalStatus = original;
      Element.prototype.cloneNode = clone;
      chrome.runtime.sendMessage = send;
    }
  })()`);
  expect(work.detectionSources, 'Draft mutations must not schedule terminal scans').toEqual([]);
  expect(work.turnCloneSources, 'Draft publications must reuse submitted-turn state').toEqual([]);
  expect(work.draftPublications.length).toBeGreaterThan(0);
  expect(work.draftPublications.every(Boolean)).toBe(true);
});
