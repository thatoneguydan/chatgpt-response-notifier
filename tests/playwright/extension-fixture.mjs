import { test as base, chromium, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');
export const notifierExtensionPath = path.join(repoRoot, 'extension');
export const quickContinueExtensionPath = path.join(repoRoot, 'standalone-quick-continue');

export const fixtureUrl = 'https://chatgpt.com/c/playwright-browser-regression';

const fixtureHtml = String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>ChatGPT extension Playwright fixture</title>
  <style>
    body { margin: 0; min-height: 100vh; font: 16px system-ui, sans-serif; background: #fff; color: #111; }
    main { width: min(900px, calc(100vw - 80px)); margin: 40px auto 180px; }
    [data-testid^="conversation-turn-"] { padding: 12px 0; }
    form[data-type="unified-composer"] {
      position: fixed;
      left: 50%;
      bottom: 36px;
      transform: translateX(-50%);
      width: min(820px, calc(100vw - 120px));
      min-height: 96px;
      padding: 12px;
      border: 1px solid #aaa;
      border-radius: 16px;
      background: #fff;
      box-sizing: border-box;
    }
    #prompt-textarea {
      min-height: 56px;
      padding: 8px;
      border: 1px solid #ddd;
      white-space: pre-wrap;
      outline: none;
    }
    button[data-testid="send-button"] { position: absolute; right: 12px; bottom: 10px; }
  </style>
</head>
<body>
  <main id="app">
    <section data-testid="conversation-turn-0">
      <div data-message-author-role="user">Fixture request</div>
    </section>
    <section data-testid="conversation-turn-1" data-turn-id="assistant-fixture-1">
      <div data-message-author-role="assistant">
        <div class="markdown">Browser-level work completed.</div>
      </div>
      <div class="rendered-footer">[GITHUB_STATUS: COMPLETE_APPLIED]</div>
      <button type="button" aria-label="Copy response">Copy</button>
    </section>
  </main>
  <script>
    (() => {
      const app = document.getElementById('app');
      const state = {
        submits: [],
        composerGeneration: 0
      };

      function readComposer(node) {
        return String(node?.innerText || node?.textContent || '').replace(/\r\n?/g, '\n');
      }

      function buildComposer() {
        state.composerGeneration += 1;
        const form = document.createElement('form');
        form.dataset.type = 'unified-composer';
        form.dataset.fixtureGeneration = String(state.composerGeneration);

        const editor = document.createElement('div');
        editor.id = 'prompt-textarea';
        editor.dataset.testid = 'prompt-textarea';
        editor.setAttribute('contenteditable', 'true');
        editor.setAttribute('role', 'textbox');
        editor.setAttribute('aria-label', 'Message ChatGPT');
        const paragraph = document.createElement('p');
        paragraph.append(document.createElement('br'));
        editor.append(paragraph);

        const send = document.createElement('button');
        send.type = 'submit';
        send.dataset.testid = 'send-button';
        send.setAttribute('aria-label', 'Send prompt');
        send.textContent = 'Send';

        form.addEventListener('submit', (event) => {
          event.preventDefault();
          state.submits.push({
            text: readComposer(editor),
            generation: state.composerGeneration,
            at: Date.now()
          });
        });

        form.append(editor, send);
        return form;
      }

      function remountComposer() {
        const previous = document.querySelector('form[data-type="unified-composer"]');
        const replacement = buildComposer();
        if (previous) previous.replaceWith(replacement);
        else document.body.append(replacement);
        return state.composerGeneration;
      }

      window.__fixture = Object.assign(state, {
        remountComposer,
        readComposer: () => readComposer(document.getElementById('prompt-textarea'))
      });

      document.body.append(buildComposer());
    })();
  </script>
</body>
</html>`;

async function extensionNames(context) {
  const result = new Map();
  for (const worker of context.serviceWorkers()) {
    try {
      const name = await worker.evaluate(() => chrome.runtime.getManifest().name);
      if (name) result.set(name, worker);
    } catch {}
  }
  return result;
}

export async function waitForExtensionWorkers(context) {
  await expect.poll(async () => {
    const names = await extensionNames(context);
    return [...names.keys()].sort();
  }, { timeout: 10_000 }).toEqual([
    'ChatGPT Quick Continue',
    'ChatGPT Response Notifier'
  ]);
  return extensionNames(context);
}

export const test = base.extend({
  extensionContext: async ({}, use, testInfo) => {
    const profile = testInfo.outputPath('chromium-profile');
    await fs.rm(profile, { recursive: true, force: true });
    const extensions = [notifierExtensionPath, quickContinueExtensionPath].join(',');
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 900 },
      args: [
        `--disable-extensions-except=${extensions}`,
        `--load-extension=${extensions}`
      ]
    });
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },

  chatgptTraffic: async ({ extensionContext }, use) => {
    const traffic = [];
    await extensionContext.route(/https:\/\/(?:www\.)?chatgpt\.com\/.*/, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/c/playwright-browser-regression') {
        traffic.push({ kind: 'fixture', method: request.method(), url: request.url() });
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: fixtureHtml
        });
        return;
      }
      traffic.push({ kind: 'blocked', method: request.method(), url: request.url() });
      await route.abort('blockedbyclient');
    });
    await extensionContext.route(/https:\/\/chat\.openai\.com\/.*/, async (route) => {
      const request = route.request();
      traffic.push({ kind: 'blocked', method: request.method(), url: request.url() });
      await route.abort('blockedbyclient');
    });
    await use(traffic);
  },

  fixturePage: async ({ extensionContext, chatgptTraffic }, use) => {
    const pages = extensionContext.pages();
    const page = pages[0] || await extensionContext.newPage();
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    await use(page);
  }
});

export { expect };
