import {
  test,
  expect,
  evaluateInExtensionWorld
} from './extension-fixture.mjs';

async function expectTrafficInert(traffic) {
  const blocked = traffic.filter((entry) => entry.kind === 'blocked');
  expect(blocked, `Unexpected ChatGPT network attempts: ${JSON.stringify(blocked)}`).toEqual([]);
}

test('notifier recovers current ChatGPT turns from screen-reader speaker labels when legacy and role attributes are absent', async ({ fixturePage, chatgptTraffic }) => {
  await fixturePage.evaluate(() => {
    const user = document.querySelector('[data-testid="conversation-turn-0"]');
    const assistant = document.querySelector('[data-testid="conversation-turn-1"]');
    if (!user || !assistant) throw new Error('Fixture conversation turns are missing.');

    const convert = (source, labelText) => {
      const section = document.createElement('section');
      const label = document.createElement('h4');
      label.className = 'sr-only select-none';
      label.textContent = labelText;
      section.append(label);
      while (source.firstChild) section.append(source.firstChild);
      source.replaceWith(section);
      for (const node of [section, ...section.querySelectorAll('*')]) {
        node.removeAttribute?.('data-testid');
        node.removeAttribute?.('data-message-author-role');
        node.removeAttribute?.('data-turn');
        node.removeAttribute?.('data-turn-id');
        node.removeAttribute?.('data-message-id');
      }
      return section;
    };

    const userSection = convert(user, 'You said:');
    const assistantSection = convert(assistant, 'ChatGPT said:');

    const visibleDecoy = document.createElement('section');
    const heading = document.createElement('h4');
    heading.textContent = 'ChatGPT said:';
    visibleDecoy.append(heading, document.createTextNode('Visible prose must not become a turn.'));
    assistantSection.after(visibleDecoy);

    window.__speakerLabelFixture = { userSection, assistantSection, visibleDecoy };
  });

  const recovered = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Response Notifier', `(() => {
    const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
    const labels = turns.map((turn) => ({
      tag: String(turn.tagName || '').toLowerCase(),
      role: String(turn.getAttribute('data-turn') || turn.getAttribute('data-message-author-role') || ''),
      testId: String(turn.getAttribute('data-testid') || ''),
      text: String(turn.innerText || turn.textContent || '').replace(/\\s+/g, ' ').trim()
    }));
    const assistant = turns.find((turn) => String(turn.getAttribute('data-turn') || turn.getAttribute('data-message-author-role') || '') === 'assistant');
    return {
      compatVersion: Number(globalThis.__chatgptNotifierPageDomCompat?.version || 0),
      count: turns.length,
      labels,
      terminal: String(globalThis.ChatGPTNotifierRenderedTerminalStatus?.detect?.(assistant) || '')
    };
  })()`);

  expect(recovered.compatVersion).toBe(3);
  expect(recovered.count).toBe(2);
  expect(recovered.labels.map((entry) => entry.tag)).toEqual(['section', 'section']);
  expect(recovered.labels.map((entry) => entry.role)).toEqual(['user', 'assistant']);
  expect(recovered.labels.every((entry) => entry.testId.startsWith('conversation-turn-compat-'))).toBe(true);
  expect(recovered.labels[0].text).toContain('You said:');
  expect(recovered.labels[1].text).toContain('ChatGPT said:');
  expect(recovered.terminal).toBe('COMPLETE_APPLIED');
  await expectTrafficInert(chatgptTraffic);
});
