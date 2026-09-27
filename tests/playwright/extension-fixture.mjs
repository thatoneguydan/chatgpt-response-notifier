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
        composerGeneration: 0,
        submittedTurns: 0
      };

      function readComposer(node) {
        return String(node?.innerText || node?.textContent || '').replace(/\r\n?/g, '\n');
      }

      function clearComposer(editor) {
        editor.replaceChildren();
        const paragraph = document.createElement('p');
        paragraph.append(document.createElement('br'));
        editor.append(paragraph);
        try {
          editor.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'deleteContentBackward',
            data: null
          }));
        } catch {
          editor.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      function appendSubmittedUserTurn(text) {
        state.submittedTurns += 1;
        const turn = document.createElement('section');
        turn.dataset.testid = 'conversation-turn-fixture-submitted-' + state.submittedTurns;
        turn.dataset.messageId = 'fixture-user-' + state.submittedTurns;
        const role = document.createElement('div');
        role.dataset.messageAuthorRole = 'user';
        role.textContent = text;
        turn.append(role);
        app.append(turn);
      }

      function buildComposer() {
        state.composerGeneration += 1;
        const generation = state.composerGeneration;
        const form = document.createElement('form');
        form.dataset.type = 'unified-composer';
        form.dataset.fixtureGeneration = String(generation);

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
        send.disabled = true;

        form.addEventListener('input', () => {
          send.disabled = !readComposer(editor).trim();
        });

        form.addEventListener('submit', (event) => {
          event.preventDefault();
          const text = readComposer(editor);
          state.submits.push({
            text,
            generation,
            at: Date.now()
          });
          appendSubmittedUserTurn(text);
          clearComposer(editor);
          send.disabled = true;
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

async function discoverExtensionWorlds(page) {
  const session = await page.context().newCDPSession(page);
  const contexts = new Map();
  session.on('Runtime.executionContextCreated', ({ context }) => {
    contexts.set(context.id, context);
  });
  session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
    contexts.delete(executionContextId);
  });
  session.on('Runtime.executionContextsCleared', () => {
    contexts.clear();
  });

  await session.send('Page.enable');
  await session.send('Runtime.enable');
  const frameTree = await session.send('Page.getFrameTree');
  const mainFrameId = String(frameTree?.frameTree?.frame?.id || '');
  if (!mainFrameId) {
    await session.detach().catch(() => {});
    throw new Error('Could not resolve Playwright fixture main-frame identity.');
  }

  const selected = new Map();
  let diagnostics = [];
  await expect.poll(async () => {
    const candidates = [];
    for (const context of contexts.values()) {
      if (String(context?.auxData?.frameId || '') !== mainFrameId) continue;
      try {
        const evaluated = await session.send('Runtime.evaluate', {
          contextId: context.id,
          expression: `(() => ({
            extensionName: globalThis.chrome?.runtime?.getManifest?.().name || '',
            href: String(globalThis.location?.href || ''),
            hasComposer: Boolean(document?.querySelector?.('#prompt-textarea')),
            hasToolbar: Boolean(document?.getElementById?.('chatgpt-quick-continue-toolbar')),
            quickContinueRuntime: Number(globalThis.__chatgptQuickContinueRuntime?.version || 0),
            hoverRuntime: Number(globalThis.__chatgptQuickContinueHoverEditRuntime?.version || 0)
          }))()`,
          returnByValue: true
        });
        const value = evaluated?.result?.value || {};
        const extensionName = String(value.extensionName || '');
        if (!extensionName) continue;
        candidates.push({
          id: context.id,
          extensionName,
          href: String(value.href || ''),
          hasComposer: value.hasComposer === true,
          hasToolbar: value.hasToolbar === true,
          quickContinueRuntime: Number(value.quickContinueRuntime || 0),
          hoverRuntime: Number(value.hoverRuntime || 0),
          contextName: String(context.name || ''),
          origin: String(context.origin || ''),
          auxType: String(context?.auxData?.type || ''),
          auxIsDefault: context?.auxData?.isDefault === true,
          frameId: String(context?.auxData?.frameId || '')
        });
      } catch {}
    }

    diagnostics = candidates;
    selected.clear();
    for (const extensionName of ['ChatGPT Quick Continue', 'ChatGPT Response Notifier']) {
      const matches = candidates.filter((candidate) =>
        candidate.extensionName === extensionName
        && candidate.href.startsWith('https://chatgpt.com/c/playwright-browser-regression')
        && candidate.hasComposer
      );
      if (matches.length === 1) selected.set(extensionName, matches[0]);
    }
    return [...selected.keys()].sort();
  }, {
    timeout: 10_000,
    message: `Current-main-frame extension worlds were not unique. Last candidates: ${JSON.stringify(diagnostics)}`
  }).toEqual([
    'ChatGPT Quick Continue',
    'ChatGPT Response Notifier'
  ]);

  for (const extensionName of ['ChatGPT Quick Continue', 'ChatGPT Response Notifier']) {
    const matches = diagnostics.filter((candidate) =>
      candidate.extensionName === extensionName
      && candidate.href.startsWith('https://chatgpt.com/c/playwright-browser-regression')
      && candidate.hasComposer
    );
    if (matches.length !== 1) {
      await session.detach().catch(() => {});
      throw new Error(`Expected exactly one current main-frame world for ${extensionName}; found ${matches.length}: ${JSON.stringify(matches)}`);
    }
  }

  return {
    session,
    names: new Map([...selected].map(([name, candidate]) => [name, candidate.id])),
    worlds: new Map(selected),
    mainFrameId
  };
}

export async function evaluateInExtensionWorld(page, extensionName, expression) {
  const { session, names } = await discoverExtensionWorlds(page);
  try {
    const contextId = names.get(extensionName);
    if (!contextId) throw new Error(`Extension world not found: ${extensionName}`);
    const evaluated = await session.send('Runtime.evaluate', {
      contextId,
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (evaluated?.exceptionDetails) {
      throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text || 'Extension-world evaluation failed.');
    }
    return evaluated?.result?.value;
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function extensionWorldNames(page) {
  const { session, names } = await discoverExtensionWorlds(page);
  try {
    return [...names.keys()].sort();
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function extensionWorldDiagnostics(page) {
  const { session, worlds } = await discoverExtensionWorlds(page);
  try {
    return [...worlds.values()];
  } finally {
    await session.detach().catch(() => {});
  }
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
