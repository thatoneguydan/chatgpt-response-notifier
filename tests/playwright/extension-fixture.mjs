import { test as base, chromium, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
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

      function readNode(node) {
        if (!node) return '';
        if (node.nodeType === Node.TEXT_NODE) return String(node.nodeValue || '');
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        if (node.tagName === 'BR') return '\n';
        return Array.from(node.childNodes || []).map(readNode).join('');
      }

      function readComposer(node) {
        if (!node) return '';
        const children = Array.from(node.children || []);
        const paragraphChildren = children.length > 0 && children.every((child) => child.tagName === 'P');
        if (paragraphChildren) {
          return children.map((child) => {
            const text = readNode(child);
            return /^\n+$/.test(text) ? '' : text;
          }).join('\n').replace(/\r\n?/g, '\n');
        }
        return readNode(node).replace(/\r\n?/g, '\n');
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

async function discoverExtensionWorlds(page, expectedHrefPrefix = fixtureUrl) {
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
        && candidate.href.startsWith(expectedHrefPrefix)
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
      && candidate.href.startsWith(expectedHrefPrefix)
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

export async function evaluateInExtensionWorld(page, extensionName, expression, expectedHrefPrefix = fixtureUrl) {
  const { session, names } = await discoverExtensionWorlds(page, expectedHrefPrefix);
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

export async function extensionWorker(context, name) {
  for (const worker of context.serviceWorkers()) {
    if (!worker.url().startsWith('chrome-extension://')) continue;
    const workerName = await worker.evaluate(() => chrome.runtime.getManifest().name).catch(() => '');
    if (workerName === name) return worker;
  }
  return null;
}

async function nativeExtensionDiagnostics(context) {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions/');
    return await page.evaluate(async () => {
      const extensions = await chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true });
      return extensions.map(({ id, name, state, version, manifestErrors, runtimeErrors, views }) => ({ id, name, state, version, manifestErrors, runtimeErrors, views }));
    });
  } finally {
    await page.close();
  }
}

async function requireExtensionWorkers(context, testInfo, chromiumLog) {
  const knownNames = ['ChatGPT Quick Continue', 'ChatGPT Response Notifier'];
  try {
    await expect.poll(async () => {
      const workers = await Promise.all(knownNames.map((name) => extensionWorker(context, name)));
      return workers.every(Boolean);
    }, { timeout: 10_000, message: 'Both native MV3 background workers must start before testing extension behavior.' }).toBe(true);
  } catch (error) {
    // Read only this disposable profile's native extension errors. Content
    // scripts alone do not prove that the background service worker registered.
    let nativeDiagnostics;
    try {
      nativeDiagnostics = await nativeExtensionDiagnostics(context);
    } catch (diagnosticError) {
      nativeDiagnostics = { error: String(diagnosticError) };
    }
    const log = await fs.readFile(chromiumLog, 'utf8').catch(() => '');
    const diagnostics = { workers: context.serviceWorkers().map((worker) => worker.url()), nativeDiagnostics, chromiumLog: log.slice(-12000) };
    await testInfo.attach('extension-worker-startup.json', { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' });
    throw new Error(`${error.message}\nNative extension worker diagnostics: ${JSON.stringify(diagnostics)}`);
  }
}

export const test = base.extend({
  extensionContext: async ({}, use, testInfo) => {
    // Windows Chromium cache/LevelDB paths exceed MAX_PATH when the profile is
    // nested under the runner checkout plus Playwright's long test directory.
    // Content scripts can load despite those failures while both workers fail.
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'cgpt-mv3-'));
    const chromiumLog = testInfo.outputPath('chromium-worker-startup.log');
    const extensions = [notifierExtensionPath, quickContinueExtensionPath].join(',');
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      viewport: { width: 1280, height: 900 },
      args: [
        `--disable-extensions-except=${extensions}`,
        `--load-extension=${extensions}`,
        '--disable-gpu',
        '--enable-logging=file',
        `--log-file=${chromiumLog}`,
        '--proxy-server=http://127.0.0.1:9',
        '--proxy-bypass-list=<-loopback>'
      ]
    });
    try {
      // A fresh unpacked MV3 install legitimately runs Quick Continue's one-time
      // onInstalled hot-replacement path. Keep only a neutral about:blank tab
      // open until that startup work has had time to query existing tabs, so the
      // browser fixture cannot be mistaken for a pre-existing ChatGPT tab and
      // reinjected underneath the first assertion. The dead loopback proxy also
      // prevents the machine's live managed updater from replacing exact-head
      // extension bytes while the isolated browser regression is running.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await requireExtensionWorkers(context, testInfo, chromiumLog);
      await use(context);
    } finally {
      await context.close();
      await fs.rm(profile, { recursive: true, force: true });
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
