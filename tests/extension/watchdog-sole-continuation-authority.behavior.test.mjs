import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');

const authoritySource = readText('extension/watchdog-sole-continuation-authority-background.js');
const invariantSource = readText('extension/watchdog-continuation-invariant-background.js');
const bootstrapSource = readText('extension/diagnostics-bootstrap.js');

test('production installs the watchdog-only gate after background construction and before compatibility layers', () => {
  const backgroundAt = bootstrapSource.indexOf("importScripts('background.js')");
  const authorityAt = bootstrapSource.indexOf("importScripts('watchdog-sole-continuation-authority-background.js')");
  const lifecycleAt = bootstrapSource.indexOf("importScripts('watchdog-request-lifecycle-fix-background.js')");
  assert.ok(backgroundAt >= 0 && authorityAt > backgroundAt && lifecycleAt > authorityAt);
  assert.doesNotThrow(() => new vm.Script(authoritySource));
});

test('durable cadence owner reserves before dispatch and never authorizes a short retry cadence', () => {
  assert.match(invariantSource, /const VERSION = 4/);
  assert.match(invariantSource, /const CADENCE_SCHEMA_VERSION = 1/);
  assert.match(invariantSource, /const WATCHDOG_DELAY_MS = 30 \* 60_000/);
  assert.match(invariantSource, /RETIRED_SHORT_RETRY_REASON = 'incomplete-awaiting-continuation'/);
  assert.match(invariantSource, /function authorizePageDispatch/);
  assert.match(invariantSource, /database\.transaction\(\[PROFILE_STORE, ENROLLMENT_STORE\], 'readwrite'\)/);
  assert.match(invariantSource, /cadenceSendCount: nextCount/);
  assert.match(invariantSource, /nextSendEligibleAt: conservativeFloor/);
  assert.match(invariantSource, /function finalizePageDispatch/);
  assert.match(invariantSource, /chrome\.alarms\.create/);
  assert.doesNotMatch(invariantSource, /FALLBACK_RETRY_MS/);
});

test('legacy immediate continuation primitives are vetoed while definitive completions retain their original handler', async () => {
  let oldRequestCalls = 0;
  let oldHandleCalls = 0;
  const updates = [];

  const context = vm.createContext({
    console,
    Date,
    Math,
    Number,
    String,
    Object,
    Promise,
    setTimeout,
    clearTimeout,
    structuredClone,
    indexedDB: {
      open() {
        // Leave the startup migration pending; no event-loop handle is created.
        return {};
      }
    },
    chrome: {
      alarms: {
        clear: async () => true,
        create: () => {}
      }
    },
    requestContinuation: async () => {
      oldRequestCalls += 1;
      return { ok: true, clicked: true };
    },
    handleContinuationClaim: async () => {
      oldHandleCalls += 1;
      return 'original-result';
    },
    coordinator: () => ({
      updateTurn: async (turnKey, patch) => updates.push({ turnKey, patch })
    }),
    ChatGPTNotifierContinuationPolicy: {
      isAutoContinueStatusCode: (code) => String(code || '') === 'INCOMPLETE_CONTINUE'
    }
  });
  context.globalThis = context;

  vm.runInContext(authoritySource, context);

  const vetoed = await context.requestContinuation(3, 'doc', {});
  assert.deepEqual({ ...vetoed }, {
    ok: false,
    clicked: false,
    reason: 'watchdog-only-continuation-authority'
  });
  assert.equal(oldRequestCalls, 0);

  const autoResult = await context.handleContinuationClaim(
    { turnKey: 'turn-1', statusCode: 'INCOMPLETE_CONTINUE' },
    { statusCode: 'INCOMPLETE_CONTINUE' },
    3,
    'doc'
  );
  assert.equal(autoResult, null);
  assert.equal(oldHandleCalls, 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].turnKey, 'turn-1');
  assert.equal(updates[0].patch?.state, 'superseded');
  assert.equal(updates[0].patch?.actionReason, 'watchdog-owned-continuation');

  const terminalResult = await context.handleContinuationClaim(
    { turnKey: 'turn-2', statusCode: 'COMPLETE_APPLIED' },
    { statusCode: 'COMPLETE_APPLIED' },
    3,
    'doc'
  );
  assert.equal(terminalResult, 'original-result');
  assert.equal(oldHandleCalls, 1);
});

test('startup migration retires only the poisoned one-minute continuation retry marker and restores a 30-minute deadline', () => {
  assert.match(authoritySource, /RETIRED_SHORT_RETRY_REASON = 'incomplete-awaiting-continuation'/);
  assert.match(authoritySource, /WATCHDOG_DELAY_MS = 30 \* 60_000/);
  assert.match(authoritySource, /lastAutomaticSentAt \+ WATCHDOG_DELAY_MS/);
  assert.match(authoritySource, /retryAt: 0/);
  assert.match(authoritySource, /retryReason: ''/);
  assert.match(authoritySource, /retireShortCadenceState\(\)\.catch/);
});
