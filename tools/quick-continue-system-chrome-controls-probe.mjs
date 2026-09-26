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
        <form id="composer-form">
          <div id="prompt-textarea" data-testid="prompt-textarea" contenteditable="true"></div>
          <button type="button" data-testid="send-button" disabled>Send</button>
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
      const sendButton = document.querySelector('[data-testid="send-button"]');
      let remounted = false;
      let clicks = 0;

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
        sendButton.disabled = false;
      });
      sendButton.addEventListener('click', (event) => {
        event.preventDefault();
        clicks += 1;
      });

      const result = await globalThis.ChatGPTQuickContinueSend.submit(initialComposer, 'first line\nsecond line');
      const live = document.getElementById('prompt-textarea');
      return {
        result,
        clicks,
        remounted,
        oldConnected: initialComposer.isConnected,
        liveIsReplacement: live !== initialComposer,
        liveText: globalThis.ChatGPTQuickContinueComposer.read(live),
      };
    });

    console.log(`SEND_RESULT ${JSON.stringify(sendResult)}`);
    if (sendResult.result?.ok !== true) throw new Error(`remount-send-failed:${sendResult.result?.reason || 'unknown'}`);
    if (!sendResult.remounted || sendResult.oldConnected !== false || !sendResult.liveIsReplacement) throw new Error('composer-remount-not-exercised');
    if (sendResult.liveText !== 'first line\nsecond line') throw new Error(`live-composer-mismatch:${JSON.stringify(sendResult.liveText)}`);
    if (sendResult.clicks !== 1) throw new Error(`send-click-count:${sendResult.clicks}`);

    await page.evaluate(() => {
      globalThis.ChatGPTQuickContinuePrompts = Object.freeze({
        formatTimestamp: () => 'Sep 26, 12:16 PM',
        renderManualMessage: (_template, message) => `[Sep 26, 12:16 PM] ${message}`,
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
      replacement.textContent = '12:17 PM';
      document.getElementById('clock-one').replaceWith(replacement);
    });
    await page.click('#clock-two');
    timestampState = await page.evaluate(() => globalThis.__chatgptQuickContinueHoverEditRuntime?.manualTimestampEnabled === true);
    if (timestampState) throw new Error('remounted-clock-click-did-not-disable');

    console.log('PROBE_SUCCESS quick-continue-live-controls');
  } catch (error) {
    fail(`quick-continue-live-controls:${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
