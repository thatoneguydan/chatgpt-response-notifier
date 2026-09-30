import {
  test,
  expect,
  evaluateInExtensionWorld
} from './extension-fixture.mjs';

test('ordinary typing wakes only monitor draft transitions, never terminal observers per character', async ({ fixturePage, chatgptTraffic }) => {
  const result = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Response Notifier', `(async () => {
    const runtime = globalThis.__chatgptNotifierTypingPerformanceGuard;
    const composer = document.getElementById('prompt-textarea');
    const assistant = document.querySelector('[data-testid="conversation-turn-1"] .markdown');
    if (!runtime || !composer || !assistant) throw new Error('Typing-performance fixture is incomplete.');

    let terminalCallbacks = 0;
    let terminalRecords = 0;
    const terminalObserver = new MutationObserver((records) => {
      terminalCallbacks += 1;
      terminalRecords += records.length;
    });
    terminalObserver.observe(document, {
      childList: true,
      subtree: true,
      characterData: true
    });

    let monitorCallbacks = 0;
    let monitorRecords = 0;
    const monitorObserver = new MutationObserver((records) => {
      monitorCallbacks += 1;
      monitorRecords += records.length;
    });
    monitorObserver.observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-testid', 'aria-label', 'aria-disabled', 'aria-hidden', 'hidden', 'disabled']
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
    const afterFirstTransition = { terminalCallbacks, terminalRecords, monitorCallbacks, monitorRecords };

    for (let index = 2; index <= 40; index += 1) typeValue('x'.repeat(index));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterFortyCharacters = { terminalCallbacks, terminalRecords, monitorCallbacks, monitorRecords };

    typeValue('');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const afterEmptyTransition = { terminalCallbacks, terminalRecords, monitorCallbacks, monitorRecords };

    assistant.textContent = assistant.textContent + ' Real assistant change.';
    await new Promise((resolve) => setTimeout(resolve, 80));
    const afterAssistantMutation = { terminalCallbacks, terminalRecords, monitorCallbacks, monitorRecords };

    terminalObserver.disconnect();
    monitorObserver.disconnect();
    return {
      runtimeVersion: Number(runtime.version || 0),
      afterFirstTransition,
      afterFortyCharacters,
      afterEmptyTransition,
      afterAssistantMutation
    };
  })()`);

  expect(result.runtimeVersion).toBeGreaterThanOrEqual(2);
  expect(result.afterFirstTransition.terminalCallbacks).toBe(0);
  expect(result.afterFirstTransition.monitorCallbacks).toBeGreaterThan(0);
  expect(result.afterFortyCharacters).toEqual(result.afterFirstTransition);
  expect(result.afterEmptyTransition.terminalCallbacks).toBe(0);
  expect(result.afterEmptyTransition.monitorCallbacks).toBeGreaterThan(result.afterFortyCharacters.monitorCallbacks);
  expect(result.afterAssistantMutation.terminalCallbacks).toBeGreaterThan(result.afterEmptyTransition.terminalCallbacks);
  expect(result.afterAssistantMutation.terminalRecords).toBeGreaterThan(result.afterEmptyTransition.terminalRecords);
  expect(result.afterAssistantMutation.monitorCallbacks).toBeGreaterThan(result.afterEmptyTransition.monitorCallbacks);
  expect(result.afterAssistantMutation.monitorRecords).toBeGreaterThan(result.afterEmptyTransition.monitorRecords);

  const blocked = chatgptTraffic.filter((entry) => entry.kind === 'blocked');
  expect(blocked, `Unexpected ChatGPT network attempts: ${JSON.stringify(blocked)}`).toEqual([]);
});
