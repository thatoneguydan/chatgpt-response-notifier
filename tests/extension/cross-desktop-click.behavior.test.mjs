import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../../extension/cross-desktop-click-fallback-background.js', import.meta.url), 'utf8');

function createRuntime({ presentation = 'hidden', probeAvailable = true } = {}) {
  const diagnostics = [];
  const windowsCreated = [];
  let originalCalls = 0;
  let probeCalls = 0;

  const context = vm.createContext({
    URL,
    console,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    globalThis: null,
    chrome: {
      tabs: {
        query: async (query) => {
          if (Number.isInteger(query?.windowId)) {
            return [{ id: 88, windowId: query.windowId, active: true, url: 'https://chatgpt.com/c/conversation-1' }];
          }
          return [{ id: 77, windowId: 12, active: true, url: 'https://chatgpt.com/c/conversation-1' }];
        },
        get: async () => ({ id: 77, windowId: 12, active: true, url: 'https://chatgpt.com/c/conversation-1' })
      },
      scripting: {
        executeScript: async ({ target }) => {
          probeCalls += 1;
          if (!probeAvailable) throw new Error('probe unavailable');
          if (target.tabId === 88) return [{ result: { visibility: 'visible', hasFocus: true } }];
          return [{ result: { visibility: presentation, hasFocus: presentation === 'visible' } }];
        }
      },
      windows: {
        create: async (options) => {
          windowsCreated.push(options);
          return { id: 23 };
        }
      }
    },
    focusOrOpenConversation: async () => {
      originalCalls += 1;
      return true;
    },
    emitClickDiagnostic: (status, data) => diagnostics.push({ status, ...data })
  });
  context.globalThis = context;
  vm.runInContext(source, context);
  return {
    context,
    diagnostics,
    windowsCreated,
    originalCalls: () => originalCalls,
    probeCalls: () => probeCalls
  };
}

test('visible clicked tab keeps the primary Chrome-only route without fallback', async () => {
  const runtime = createRuntime({ presentation: 'visible' });
  const result = await runtime.context.focusOrOpenConversation(
    'conversation-1',
    'https://chatgpt.com/c/conversation-1',
    { correlationId: 'click-1', notificationId: 'note-1' }
  );

  assert.equal(result, true);
  assert.equal(runtime.originalCalls(), 1);
  assert.equal(runtime.windowsCreated.length, 0);
  assert.ok(runtime.diagnostics.some((entry) => entry.status === 'cross-desktop-focus-visible'));
});

test('tab remaining hidden after a toast click opens a focused current-desktop fallback window', async () => {
  const runtime = createRuntime({ presentation: 'hidden' });
  const result = await runtime.context.focusOrOpenConversation(
    'conversation-1',
    'https://chatgpt.com/c/conversation-1',
    { correlationId: 'click-2', notificationId: 'note-2' }
  );

  assert.equal(result, true);
  assert.equal(runtime.originalCalls(), 1);
  assert.equal(runtime.windowsCreated.length, 1);
  assert.equal(runtime.windowsCreated[0].url, 'https://chatgpt.com/c/conversation-1');
  assert.equal(runtime.windowsCreated[0].focused, true);
  assert.equal(runtime.windowsCreated[0].type, 'normal');
  assert.ok(runtime.diagnostics.some((entry) => entry.status === 'cross-desktop-focus-hidden'));
  assert.ok(runtime.diagnostics.some((entry) => entry.status === 'cross-desktop-fallback-window-created'));
  assert.ok(runtime.diagnostics.some((entry) => entry.status === 'cross-desktop-fallback-visible'));
});

test('unavailable page verification fails closed without opening a duplicate window', async () => {
  const runtime = createRuntime({ probeAvailable: false });
  const result = await runtime.context.focusOrOpenConversation(
    'conversation-1',
    'https://chatgpt.com/c/conversation-1',
    { correlationId: 'click-3', notificationId: 'note-3' }
  );

  assert.equal(result, true);
  assert.equal(runtime.windowsCreated.length, 0);
  assert.ok(runtime.diagnostics.some((entry) => entry.status === 'cross-desktop-focus-verification-unavailable'));
});

test('fallback rejects non-ChatGPT conversation URLs and contains no native foreground route', async () => {
  const runtime = createRuntime({ presentation: 'hidden' });
  const result = await runtime.context.focusOrOpenConversation(
    'conversation-1',
    'https://example.com/c/conversation-1',
    { correlationId: 'click-4', notificationId: 'note-4' }
  );

  assert.equal(result, true);
  assert.equal(runtime.windowsCreated.length, 0);
  assert.ok(runtime.diagnostics.some((entry) => entry.status === 'cross-desktop-fallback-rejected'));
  assert.doesNotMatch(source, /window\.foreground/);
  assert.doesNotMatch(source, /requestNativeChromeForeground/);
  assert.doesNotMatch(source, /SetForegroundWindow/);
  assert.doesNotMatch(source, /IVirtualDesktop/);
  assert.doesNotMatch(source, /Process\./);
});
