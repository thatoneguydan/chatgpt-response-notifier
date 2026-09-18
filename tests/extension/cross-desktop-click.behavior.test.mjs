import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../../extension/cross-desktop-click-fallback-background.js', import.meta.url), 'utf8');

function createRuntime({
  presentation = 'focused',
  probeAvailable = true,
  probeHangs = false,
  exactTabMatches = true
} = {}) {
  const diagnostics = [];
  const windowsCreated = [];
  let originalCalls = 0;
  let probeCalls = 0;
  const target = { id: 77, windowId: 12, active: true, url: exactTabMatches ? 'https://chatgpt.com/c/conversation-1' : 'https://chatgpt.com/c/other' };

  const context = vm.createContext({
    URL,
    console,
    setTimeout: (fn, delay) => setTimeout(fn, Number(delay || 0) >= 3000 ? 100 : Math.min(Number(delay || 0), 2)),
    clearTimeout,
    globalThis: null,
    chrome: {
      tabs: {
        get: async (tabId) => {
          if (tabId !== 77) throw new Error('unknown tab');
          return target;
        }
      },
      scripting: {
        executeScript: async () => {
          probeCalls += 1;
          if (probeHangs) return await new Promise(() => {});
          if (!probeAvailable) throw new Error('probe unavailable');
          if (windowsCreated.length > 0) return [{ result: { visibility: 'visible', hasFocus: true } }];
          if (presentation === 'focused') return [{ result: { visibility: 'visible', hasFocus: true } }];
          if (presentation === 'visible') return [{ result: { visibility: 'visible', hasFocus: false } }];
          return [{ result: { visibility: 'hidden', hasFocus: false } }];
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
      return {
        requested: true,
        presented: false,
        presentationState: 'requested',
        reason: 'focus-requested',
        targetTabId: 77,
        targetWindowId: 12,
        created: false
      };
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

test('focused exact target is verified without any fallback window', async () => {
  const runtime = createRuntime({ presentation: 'focused' });
  const result = await runtime.context.focusOrOpenConversation(
    'conversation-1',
    'https://chatgpt.com/c/conversation-1',
    { correlationId: 'click-1', notificationId: 'note-1', targetTabId: 77 }
  );

  assert.equal(result.presented, true);
  assert.equal(result.presentationState, 'focused');
  assert.equal(result.targetTabId, 77);
  assert.equal(runtime.originalCalls(), 1);
  assert.equal(runtime.windowsCreated.length, 0);
  assert.ok(runtime.diagnostics.some((entry) => entry.status === 'cross-desktop-click-focused'));
});

test('hidden exact target stays retryable and never opens a duplicate window automatically', async () => {
  const runtime = createRuntime({ presentation: 'hidden' });
  const result = await runtime.context.focusOrOpenConversation(
    'conversation-1',
    'https://chatgpt.com/c/conversation-1',
    { correlationId: 'click-2', notificationId: 'note-2', targetTabId: 77 }
  );

  assert.equal(result.presented, false);
  assert.equal(result.presentationState, 'other-desktop');
  assert.equal(result.targetTabId, 77);
  assert.equal(runtime.windowsCreated.length, 0);
  assert.ok(runtime.diagnostics.some((entry) => entry.status === 'cross-desktop-click-other-desktop'));
});

test('visible but unfocused target is not falsely reported as completed presentation', async () => {
  const runtime = createRuntime({ presentation: 'visible' });
  const result = await runtime.context.focusOrOpenConversation(
    'conversation-1',
    'https://chatgpt.com/c/conversation-1',
    { correlationId: 'click-3', notificationId: 'note-3', targetTabId: 77 }
  );

  assert.equal(result.presented, false);
  assert.equal(result.presentationState, 'visible-not-focused');
  assert.equal(runtime.windowsCreated.length, 0);
});

test('unavailable or hung page probes are wall-clock bounded and fail closed', async () => {
  const unavailable = createRuntime({ probeAvailable: false });
  const unavailableResult = await unavailable.context.focusOrOpenConversation(
    'conversation-1',
    'https://chatgpt.com/c/conversation-1',
    { correlationId: 'click-4a', notificationId: 'note-4a', targetTabId: 77 }
  );
  assert.equal(unavailableResult.presented, false);
  assert.equal(unavailableResult.presentationState, 'unverified');
  assert.equal(unavailable.windowsCreated.length, 0);

  const hung = createRuntime({ probeHangs: true });
  const hungResult = await hung.context.focusOrOpenConversation(
    'conversation-1',
    'https://chatgpt.com/c/conversation-1',
    { correlationId: 'click-4b', notificationId: 'note-4b', targetTabId: 77 }
  );
  assert.equal(hungResult.presented, false);
  assert.ok(['probe-timeout', 'route-timeout'].includes(hungResult.presentationState));
  assert.equal(hung.windowsCreated.length, 0);
});

test('explicit move-tab-here relocates the exact tab rather than duplicating its URL', async () => {
  const runtime = createRuntime({ presentation: 'hidden' });
  const result = await runtime.context.__chatgptNotifierCrossDesktopClickFallback.moveTabHere(
    'conversation-1',
    77,
    { correlationId: 'move-1', notificationId: 'note-5', targetTabId: 77 }
  );

  assert.equal(result.presented, true);
  assert.equal(result.targetTabId, 77);
  assert.equal(runtime.windowsCreated.length, 1);
  assert.equal(runtime.windowsCreated[0].tabId, 77);
  assert.equal(runtime.windowsCreated[0].focused, true);
  assert.equal(runtime.windowsCreated[0].type, 'normal');
  assert.equal('url' in runtime.windowsCreated[0], false);
  assert.ok(runtime.diagnostics.some((entry) => entry.status === 'cross-desktop-move-focused'));
});

test('move-tab-here rejects changed target identity and source contains no native foreground route', async () => {
  const runtime = createRuntime({ exactTabMatches: false });
  const result = await runtime.context.__chatgptNotifierCrossDesktopClickFallback.moveTabHere(
    'conversation-1',
    77,
    { correlationId: 'move-2', notificationId: 'note-6', targetTabId: 77 }
  );

  assert.equal(result.presented, false);
  assert.equal(result.presentationState, 'target-changed');
  assert.equal(runtime.windowsCreated.length, 0);
  assert.doesNotMatch(source, /window\.foreground/);
  assert.doesNotMatch(source, /requestNativeChromeForeground/);
  assert.doesNotMatch(source, /SetForegroundWindow/);
  assert.doesNotMatch(source, /IVirtualDesktop/);
  assert.doesNotMatch(source, /Process\./);
  assert.doesNotMatch(source, /windows\.create\(\{\s*url:/);
});
