import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../../extension/runtime-identity-background.js', import.meta.url), 'utf8');

function loadRuntimeIdentity() {
  const nativeMessages = [];
  const alarms = [];
  const alarmListeners = [];
  const context = vm.createContext({
    console,
    crypto: { randomUUID: () => 'runtime-id-0917' },
    sendNative: (message) => {
      nativeMessages.push(structuredClone(message));
      return true;
    },
    chrome: {
      runtime: { getManifest: () => ({ version: '0.9.17' }) },
      alarms: {
        create: (name, options) => alarms.push({ name, options: structuredClone(options) }),
        onAlarm: { addListener: (listener) => alarmListeners.push(listener) }
      }
    }
  });
  vm.runInContext(source, context);
  return { context, nativeMessages, alarms, alarmListeners };
}

test('runtime identity publishes a versioned connection marker and schedules a local heartbeat', () => {
  const runtime = loadRuntimeIdentity();
  assert.equal(runtime.nativeMessages.length, 1);
  assert.equal(runtime.nativeMessages[0].type, 'diagnostics.event');
  assert.equal(runtime.nativeMessages[0].diagnostic.source, 'extension-runtime');
  assert.equal(runtime.nativeMessages[0].diagnostic.status, 'worker-connected');
  assert.equal(runtime.nativeMessages[0].diagnostic.extensionVersion, '0.9.17');
  assert.equal(runtime.nativeMessages[0].diagnostic.captureSource, 'runtime-identity-heartbeat-v3');

  assert.equal(runtime.alarms.length, 1);
  assert.equal(runtime.alarms[0].name, 'chatgpt-notifier-runtime-identity-heartbeat');
  assert.equal(runtime.alarms[0].options.periodInMinutes, 0.5);
  assert.equal(runtime.alarmListeners.length, 1);
});

test('runtime heartbeat refreshes identity only for its own alarm', () => {
  const runtime = loadRuntimeIdentity();
  runtime.alarmListeners[0]({ name: 'unrelated' });
  assert.equal(runtime.nativeMessages.length, 1);

  runtime.alarmListeners[0]({ name: 'chatgpt-notifier-runtime-identity-heartbeat' });
  assert.equal(runtime.nativeMessages.length, 2);
  assert.equal(runtime.nativeMessages[1].diagnostic.status, 'worker-alive');
  assert.equal(runtime.nativeMessages[1].diagnostic.extensionVersion, '0.9.17');
  assert.equal(runtime.nativeMessages[1].diagnostic.captureSource, 'runtime-identity-heartbeat-v3');
});
