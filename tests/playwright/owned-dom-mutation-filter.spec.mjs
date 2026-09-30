import {
  test,
  expect,
  evaluateInExtensionWorld
} from './extension-fixture.mjs';

const toolbarSelector = '#chatgpt-quick-continue-toolbar';

test('notifier-owned toolbar churn is invisible to notifier MutationObservers', async ({ fixturePage, chatgptTraffic }) => {
  await expect(fixturePage.locator(toolbarSelector)).toHaveCount(1);
  await expect(fixturePage.locator(toolbarSelector)).toBeVisible();

  const result = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Response Notifier', `(async () => {
    const filter = globalThis.ChatGPTNotifierOwnedDomMutationFilter;
    const toolbar = document.getElementById('chatgpt-quick-continue-toolbar');
    const assistant = document.querySelector('[data-testid="conversation-turn-1"]');
    if (!filter || !toolbar || !assistant) throw new Error('Notifier mutation-filter fixture is incomplete.');

    let callbackCount = 0;
    let recordCount = 0;
    const observer = new MutationObserver((records) => {
      callbackCount += 1;
      recordCount += records.length;
    });
    observer.observe(document, { childList: true, subtree: true, characterData: true });

    const marker = document.createElement('span');
    marker.className = 'playwright-owned-dom-churn';
    toolbar.append(marker);
    for (let index = 0; index < 12; index += 1) marker.textContent = 'tick-' + index;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const afterOwned = { callbackCount, recordCount };

    const pageMarker = document.createElement('span');
    pageMarker.className = 'playwright-page-mutation';
    assistant.append(pageMarker);
    pageMarker.textContent = 'real response mutation';
    await new Promise((resolve) => setTimeout(resolve, 80));
    const afterPage = { callbackCount, recordCount };

    observer.disconnect();
    marker.remove();
    pageMarker.remove();

    return {
      filterVersion: Number(filter.version || 0),
      mutationObserverFiltered: filter.mutationObserverFiltered === true,
      ownedRootSelector: String(filter.ownedRootSelector || ''),
      afterOwned,
      afterPage
    };
  })()`);

  expect(result.filterVersion).toBeGreaterThanOrEqual(2);
  expect(result.mutationObserverFiltered).toBe(true);
  expect(result.ownedRootSelector).toBe(toolbarSelector);
  expect(result.afterOwned).toEqual({ callbackCount: 0, recordCount: 0 });
  expect(result.afterPage.callbackCount).toBeGreaterThan(0);
  expect(result.afterPage.recordCount).toBeGreaterThan(0);

  const blocked = chatgptTraffic.filter((entry) => entry.kind === 'blocked');
  expect(blocked, `Unexpected ChatGPT network attempts: ${JSON.stringify(blocked)}`).toEqual([]);
});
