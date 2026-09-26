import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const extensionPath = path.resolve(process.argv[2] ?? '');
const browserExecutablePath = path.resolve(process.argv[3] ?? '');

function fail(message) {
  console.error(`PROBE_FAILURE ${message}`);
  process.exitCode = 1;
}

if (!extensionPath || !fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
  fail('quick-continue-manifest-missing');
} else if (!browserExecutablePath || !fs.existsSync(browserExecutablePath)) {
  fail('system-chrome-executable-missing');
} else {
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: browserExecutablePath,
      headless: true,
      args: ['--no-first-run', '--no-default-browser-check'],
    });

    console.log(`SYSTEM_CHROME_VERSION ${await browser.version()}`);
    const page = await browser.newPage();
    await page.setContent(`<!doctype html>
      <html><body>
        <main id="conversation"></main>
        <form id="composer-form">
          <button id="decoy-send" type="button" data-testid="send-button" disabled>Old Send</button>
          <div id="prompt-textarea" data-testid="prompt-textarea" contenteditable="true"></div>
          <button id="live-send" type="submit" aria-label="Send message" disabled>Send</button>
        </form>
        <div id="chatgpt-quick-continue-toolbar">
          <span id="clock-one" aria-label="Current local time">12:00 PM</span>
        </div>
      </body></html>`);

    await page.addScriptTag({ path: path.join(extensionPath, 'composer-text.js') });
    await page.addScriptTag({ path: path.join(extensionPath, 'send-transaction.js') });

    const sendResult = await page.evaluate(async () => {
      const form = document.getElementById('composer-form');
      const initialComposer = document.getElementById('prompt-textarea');
      const liveSend = document.getElementById('live-send');
      const decoySend = document.getElementById('decoy-send');
      const conversation = document.getElementById('conversation');
      let remounted = false;
      let submits = 0;
      let decoyClicks = 0;

      decoySend.addEventListener('click', () => { decoyClicks += 1; });
      form.addEventListener('input', () => {
        if (!remounted) {
          remounted = true;
          const replacement = document.createElement('div');
          replacement.id = 'prompt-textarea';
          replacement.dataset.testid = 'prompt-textarea';
          replacement.contentEditable = 'true';
          document.getElementById('prompt-textarea').replaceWith(replacement);
          return;
        }
        liveSend.disabled = false;
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        submits += 1;
        const live = document.getElementById('prompt-textarea');
        const text = globalThis.ChatGPTQuickContinueComposer.read(live);
        const turn = document.createElement('div');
        turn.dataset.testid = `conversation-turn-${submits}`;
        turn.dataset.messageAuthorRole = 'user';
        turn.textContent = text;
        conversation.append(turn);
        live.textContent = '';
        live.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
        liveSend.disabled = true;
      });

      const result = await globalThis.ChatGPTQuickContinueSend.submit(initialComposer, 'first line\nsecond line');
      const live = document.getElementById('prompt-textarea');
      const userTurns = Array.from(conversation.querySelectorAll('[data-message-author-role="user"]')).map((node) => node.textContent);
      return {
        result,
        submits,
        decoyClicks,
        remounted,
        oldConnected: initialComposer.isConnected,
        liveIsReplacement: live !== initialComposer,
        liveText: globalThis.ChatGPTQuickContinueComposer.read(live),
        userTurns,
      };
    });

    console.log(`SEND_RESULT ${JSON.stringify(sendResult)}`);
    if (sendResult.result?.ok !== true) throw new Error(`remount-send-failed:${sendResult.result?.reason || 'unknown'}`);
    if (!sendResult.remounted || sendResult.oldConnected !== false || !sendResult.liveIsReplacement) throw new Error('composer-remount-not-exercised');
    if (sendResult.liveText !== '') throw new Error(`accepted-send-did-not-clear-composer:${JSON.stringify(sendResult.liveText)}`);
    if (sendResult.submits !== 1) throw new Error(`form-submit-count:${sendResult.submits}`);
    if (sendResult.decoyClicks !== 0) throw new Error(`decoy-send-was-activated:${sendResult.decoyClicks}`);
    if (JSON.stringify(sendResult.userTurns) !== JSON.stringify(['first line\nsecond line'])) throw new Error(`user-turn-mismatch:${JSON.stringify(sendResult.userTurns)}`);

    await page.evaluate(() => {
      globalThis.ChatGPTQuickContinuePrompts = Object.freeze({
        formatTimestamp: () => 'Sep 26, 1:30 PM',
        renderManualMessage: (_template, message) => `[Sep 26, 1:30 PM] ${message}`,
      });
      globalThis.ChatGPTQuickContinueConfig = Object.freeze({
        subscribe: () => () => {},
        load: async () => ({ manualTimestampText: '[{time}] {message}' }),
      });
    });
    await page.addScriptTag({ path: path.join(extensionPath, 'hover-edit-script.js') });

    await page.click('#clock-one');
    let timestampState = await page.evaluate(() => globalThis.__chatgptQuickContinueHoverEditRuntime?.manualTimestampEnabled === true);
    if (!timestampState) throw new Error('first-clock-click-did-not-enable');

    await page.evaluate(() => {
      const replacement = document.createElement('span');
      replacement.id = 'clock-two';
      replacement.setAttribute('aria-label', 'Current local time');
      replacement.textContent = '1:30 PM';
      document.getElementById('clock-one').replaceWith(replacement);
    });
    await page.click('#clock-two');
    timestampState = await page.evaluate(() => globalThis.__chatgptQuickContinueHoverEditRuntime?.manualTimestampEnabled === true);
    if (timestampState) throw new Error('remounted-clock-click-did-not-disable');

    // Re-enable timestamping on the replacement clock and prove that one trusted
    // Enter both timestamps and submits. A second Enter must never be necessary.
    await page.click('#clock-two');
    timestampState = await page.evaluate(() => globalThis.__chatgptQuickContinueHoverEditRuntime?.manualTimestampEnabled === true);
    if (!timestampState) throw new Error('replacement-clock-did-not-reenable');

    await page.evaluate(() => {
      const composer = document.getElementById('prompt-textarea');
      composer.focus();
      document.execCommand('insertText', false, 'single enter message');
      document.getElementById('live-send').disabled = false;
    });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#conversation [data-message-author-role="user"]').length === 2, { timeout: 2500 });

    const manualResult = await page.evaluate(() => ({
      turns: Array.from(document.querySelectorAll('#conversation [data-message-author-role="user"]')).map((node) => node.textContent),
      composerText: globalThis.ChatGPTQuickContinueComposer.read(document.getElementById('prompt-textarea')),
      timestampEnabled: globalThis.__chatgptQuickContinueHoverEditRuntime?.manualTimestampEnabled === true,
    }));
    console.log(`MANUAL_ENTER_RESULT ${JSON.stringify(manualResult)}`);
    if (manualResult.turns.length !== 2) throw new Error(`manual-turn-count:${manualResult.turns.length}`);
    if (manualResult.turns[1] !== '[Sep 26, 1:30 PM] single enter message') throw new Error(`manual-turn-text:${JSON.stringify(manualResult.turns[1])}`);
    if (manualResult.composerText !== '') throw new Error(`manual-enter-did-not-clear:${JSON.stringify(manualResult.composerText)}`);
    if (!manualResult.timestampEnabled) throw new Error('manual-enter-disabled-timestamp-toggle');

    console.log('PROBE_SUCCESS quick-continue-live-controls');
  } catch (error) {
    fail(`quick-continue-live-controls:${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
