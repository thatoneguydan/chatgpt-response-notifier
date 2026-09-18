import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../../extension/cross-desktop-click-fallback-background.js', import.meta.url), 'utf8');

function createRuntime({
  presentation = 'focused',
  probeAvailable = true,
  probeHangs = false,
  exactTabMatches = true,
  nativeSuccess = true,
  nativeReason = 'desktop-switched'
} = {}) {
  const diagnostics = [];
  const nativeCalls = [];
  const tabUpdates = [];
  const windowUpdates = [];
  let originalCalls = 0;
  let probeCalls = 0;
  let switched = false;
  const target = {
    id: 77,
    windowId: 12,
    active: true,
    title: 'Notifier test chat',
    url: exactTabMatches ? 'https://chatgpt.com/c/conversation-1' : 'https://chatgpt.com/c/other'
  };

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
        },
        update: async (tabId, options) => {
          tabUpdates.push({ tabId, options });
          return target;
        }
      },
      scripting: {
        executeScript: async () => {
          probeCalls += 1;
          if (probeHangs) return await new Promise(() => {});
          if (!probeAvailable) throw new Error('probe unavailable');
          if (switched) return [{ result: { visibility: 'visible', hasFocus: true } }];
          if (presentation === 'focused') return [{ result: { visibility: 'visible', hasFocus: true } }];
          if (presentation === 'visible') return [{ result: { visibility: 'visible', hasFocus: false } }];
          return [{ result: { visibility: 'hidden', hasFocus: false } }];
        }
      },
      windows: {
        update: async (windowId, options) => {
          windowUpdates.push({ windowId, options });
          return { id: windowId };
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
    __chatgptNotifierPresentExistingWindow: async (targetTabId, targetWindowId, clickContext) => {
      nativeCalls.push({ targetTabId, targetWindowId, clickContext });
      if (nativeSuccess) switched = true;
      return { success: nativeSuccess, reason: nativeReason };
    },
    emitClickDiagnostic: (status, data) => diagnostics.push({ status, ...data })
  });
  context.globalThis = context;
  vm.runInContext(source, context);
  return {
    context,
    diagnostics,
    nativeCalls,
    tabUpdates,
    windowUpdates,
    originalCalls: () => originalCalls,
    probeCalls: () => probeCalls
  };
}

test('focused exact target is verified without native desktop switching', async () => {
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
  assert.equal(runtime.nativeCalls.length, 0);
  assert.ok(runtime.diagnostics.some((entry) => entry.status === 'cross-desktop-click-focused'));
});

test('hidden exact target switches to its existing Windows desktop and verifies focus', async () => {
  const runtime = createRuntime({ presentation: 'hidden' });
  const result = await runtime.context.focusOrOpenConversation(
    'conversation-1',
    'https://chatgpt.com/c/conversation-1',
    { correlationId: 'click-2', notificationId: 'note-2', targetTabId: 77 }
  );

  assert.equal(result.presented, true);
  assert.equal(result.presentationState, 'focused');
  assert.equal(result.targetTabId, 77);
  assert.equal(runtime.nativeCalls.length, 1);
  assert.deepEqual(
    { targetTabId: runtime.nativeCalls[0].targetTabId, targetWindowId: runtime.nativeCalls[0].targetWindowId },
    { targetTabId: 77, targetWindowId: 12 }
  );
  assert.ok(runtime.tabUpdates.some((entry) => entry.tabId === 77 && entry.options.active === true));
  assert.ok(runtime.windowUpdates.some((entry) => entry.windowId === 12 && entry.options.focused === true));
  assert.ok(runtime.diagnostics.some((entry) => entry.status === 'cross-desktop-click-after-switch-focused'));
});

test('native desktop switch failure stays retryable and never moves or duplicates the tab', async () => {
  const runtime = createRuntime({
    presentation: 'hidden',
    nativeSuccess: false,
    nativeReason: 'chrome-window-ambiguous'
  });
  const result = await runtime.context.focusOrOpenConversation(
    'conversation-1',
    'https://chatgpt.com/c/conversation-1',
    { correlationId: 'click-3', notificationId: 'note-3', targetTabId: 77 }
  );

  assert.equal(result.presented, false);
  assert.equal(result.presentationState, 'desktop-window-ambiguous');
  assert.equal(result.reason, 'chrome-window-ambiguous');
  assert.equal(runtime.nativeCalls.length, 1);
  assert.equal(runtime.tabUpdates.length, 0);
  assert.equal(runtime.windowUpdates.length, 0);
});

test('visible but unfocused target is not falsely reported as completed presentation', async () => {
  const runtime = createRuntime({ presentation: 'visible' });
  const result = await runtime.context.focusOrOpenConversation(
    'conversation-1',
    'https://chatgpt.com/c/conversation-1',
    { correlationId: 'click-4', notificationId: 'note-4', targetTabId: 77 }
  );

  assert.equal(result.presented, false);
  assert.equal(result.presentationState, 'visible-not-focused');
  assert.equal(runtime.nativeCalls.length, 0);
});

test('unavailable or hung page probes are wall-clock bounded and fail closed', async () => {
  const unavailable = createRuntime({ probeAvailable: false });
  const unavailableResult = await unavailable.context.focusOrOpenConversation(
    'conversation-1',
    'https://chatgpt.com/c/conversation-1',
    { correlationId: 'click-5a', notificationId: 'note-5a', targetTabId: 77 }
  );
  assert.equal(unavailableResult.presented, false);
  assert.equal(unavailableResult.presentationState, 'unverified');
  assert.equal(unavailable.nativeCalls.length, 0);

  const hung = createRuntime({ probeHangs: true });
  const hungResult = await hung.context.focusOrOpenConversation(
    'conversation-1',
    'https://chatgpt.com/c/conversation-1',
    { correlationId: 'click-5b', notificationId: 'note-5b', targetTabId: 77 }
  );
  assert.equal(hungResult.presented, false);
  assert.ok(['probe-timeout', 'route-timeout'].includes(hungResult.presentationState));
  assert.equal(hung.nativeCalls.length, 0);
});

test('changed exact target identity fails closed before desktop switching', async () => {
  const runtime = createRuntime({ presentation: 'hidden', exactTabMatches: false });
  const result = await runtime.context.focusOrOpenConversation(
    'conversation-1',
    'https://chatgpt.com/c/conversation-1',
    { correlationId: 'click-6', notificationId: 'note-6', targetTabId: 77 }
  );

  assert.equal(result.presented, false);
  assert.equal(result.presentationState, 'target-changed');
  assert.equal(runtime.nativeCalls.length, 0);
});

test('cross-desktop route contains no move-tab or duplicate-window fallback', () => {
  assert.doesNotMatch(source, /windows\.create/);
  assert.doesNotMatch(source, /moveTabHere/);
  assert.doesNotMatch(source, /Move this tab here/);
  assert.doesNotMatch(source, /requestNativeChromeForeground/);
  assert.match(source, /__chatgptNotifierPresentExistingWindow/);
  assert.match(source, /nativeDesktopSwitchUsed:\s*true/);
  assert.match(source, /explicitMoveExistingTabFallback:\s*false/);
});
