import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readText = (relative) => readFileSync(new URL(relative, root), 'utf8');

function loadPolicy() {
  const context = vm.createContext({ Date, Number, String, Set, Object, Math, URL });
  vm.runInContext(readText('extension/traffic-safety-background.js'), context);
  return context.ChatGPTNotifierTrafficSafetyPolicy;
}

test('traffic safety requires a fresh runtime-authorized human run', () => {
  const policy = loadPolicy();
  assert.equal(policy.trafficDecision({ stateReady: false }, {}, 1_000), 'traffic-safety-state-loading');
  assert.equal(policy.trafficDecision({ stateReady: true }, {}, 1_000), 'runtime-safety-hold');
  assert.equal(policy.trafficDecision({ stateReady: true, originAuthorized: true }, {}, 1_000), '');
});

test('hard breaker and rate-limit evidence fail closed', () => {
  const policy = loadPolicy();
  assert.equal(policy.trafficDecision({ stateReady: true, hardBreakerOpen: true, originAuthorized: true }, {}, 1_000), 'traffic-breaker-open');
  assert.equal(policy.trafficDecision({ stateReady: true, originAuthorized: true }, { rateLimited: true }, 1_000), 'rate-limited');
});

test('profile traffic governor enforces five minutes across actions', () => {
  const policy = loadPolicy();
  assert.equal(policy.minProfileActionSpacingMs, 300_000);
  assert.equal(policy.profileFloor(10_000), 310_000);
  assert.equal(policy.trafficDecision({ stateReady: true, originAuthorized: true, lastAutomaticActionAt: 10_000 }, {}, 309_999), 'traffic-profile-spacing');
  assert.equal(policy.trafficDecision({ stateReady: true, originAuthorized: true, lastAutomaticActionAt: 10_000 }, {}, 310_000), '');
});

test('only a work-start signal attached to a request begun in this runtime authorizes recovery', () => {
  const policy = loadPolicy();
  const base = { promptKey: 'conversation|turn', workStartSignal: true, requestPhase: 'started', requestStartedAt: 20_000 };
  assert.equal(policy.freshTrustedSnapshot(base, 10_000), true);
  assert.equal(policy.freshTrustedSnapshot({ ...base, workStartSignal: false }, 10_000), false);
  assert.equal(policy.freshTrustedSnapshot({ ...base, requestStartedAt: 9_999 }, 10_000), false);
  assert.equal(policy.freshTrustedSnapshot({ ...base, requestPhase: 'unknown' }, 10_000), false);
});

test('production worker loads the traffic guard before bounded recovery and normal continuation', () => {
  const background = readText('extension/background.js');
  const trafficIndex = background.indexOf("'traffic-safety-background.js'");
  const boundedIndex = background.indexOf("'bounded-recovery-background.js'");
  const normalIndex = background.indexOf("'normal-continuation-budget-hook.js'");
  assert.ok(trafficIndex >= 0);
  assert.ok(trafficIndex < boundedIndex);
  assert.ok(trafficIndex < normalIndex);
});

test('traffic action evidence serializes initial records before request-result patches', () => {
  const traffic = readText('extension/traffic-safety-background.js');
  assert.match(traffic, /const actionWriteChains = new Map\(\)/);
  assert.match(traffic, /function queueActionWrite\(actionId, writer\)/);
  assert.match(traffic, /queueActionWrite\(actionId, \(\) => putAction\(record\)\)/);
  assert.match(traffic, /return queueActionWrite\(actionId, \(\) => patchActionNow\(actionId, patch\)\)/);
  assert.match(traffic, /metaWriteChain = metaWriteChain\.catch\(\(\) => \{\}\)\.then\(\(\) => writeMetaNow\(\)\)/);
});

test('page monitor treats literal too-many-requests UI as rate-limit evidence', () => {
  const monitor = readText('extension/monitor-script.js');
  assert.match(monitor, /too many requests\|rate limit\|try again later/);
});
