import {
  test,
  expect,
  evaluateInExtensionWorld
} from './extension-fixture.mjs';

test('ordinary typing does not wake downstream notifier observers per character', async ({ fixturePage, chatgptTraffic }) => {
  const result = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Response Notifier', `(async () => {
    const runtime = globalThis.__chatgptNotifierTypingPerformanceGuard;
    const composer = document.getElementById('prompt-textarea');
    const assistant = document.querySelector('[data-testid="conversation-turn-1"] .markdown');
    if (!runtime || !composer || !assistant) throw new Error('Typing-performance fixture is incomplete.');

    let callbackCount = 0;
    let recordCount = 0;
    const observer = new MutationObserver((records) => {
      callbackCount += 1;
      recordCount += records.length;
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-label']
    });

    const typeValue = (value) => {
      composer.textContent = value;
      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: value ? 'insertText' : 'deleteContentBackward',
        data: value ? value.at(-1) : null
      }));
    };

    typeValue('a');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const afterFirstTransition = { callbackCount, recordCount };

    for (let index = 2; index <= 40; index += 1) typeValue('x'.repeat(index));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterFortyCharacters = { callbackCount, recordCount };

    typeValue('');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const afterEmptyTransition = { callbackCount, recordCount };

    assistant.textContent = assistant.textContent + ' Real assistant change.';
    await new Promise((resolve) => setTimeout(resolve, 80));
    const afterAssistantMutation = { callbackCount, recordCount };

    observer.disconnect();
    return {
      runtimeVersion: Number(runtime.version || 0),
      afterFirstTransition,
      afterFortyCharacters,
      afterEmptyTransition,
      afterAssistantMutation
    };
  })()`);

  expect(result.runtimeVersion).toBeGreaterThanOrEqual(1);
  expect(result.afterFirstTransition.callbackCount).toBeGreaterThan(0);
  expect(result.afterFortyCharacters).toEqual(result.afterFirstTransition);
  expect(result.afterEmptyTransition.callbackCount).toBeGreaterThan(result.afterFortyCharacters.callbackCount);
  expect(result.afterAssistantMutation.callbackCount).toBeGreaterThan(result.afterEmptyTransition.callbackCount);
  expect(result.afterAssistantMutation.recordCount).toBeGreaterThan(result.afterEmptyTransition.recordCount);

  const blocked = chatgptTraffic.filter((entry) => entry.kind === 'blocked');
  expect(blocked, `Unexpected ChatGPT network attempts: ${JSON.stringify(blocked)}`).toEqual([]);
});
