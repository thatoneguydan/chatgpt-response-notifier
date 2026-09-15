import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../../extension/runtime-identity-background.js', import.meta.url), 'utf8');
const sanitizerSource = readFileSync(new URL('../../src/ChatGPTResponseNotifier.Host/DiagnosticsSanitizer.cs', import.meta.url), 'utf8');
const publisherSource = readFileSync(new URL('../../src/ChatGPTResponseNotifier.Host/RuntimeEvidencePublisher.cs', import.meta.url), 'utf8');

const V1_SHA = '9c60a07bc26b639c15a6456b08707c2e92fa06fe98baa21b6b731b3f9dda4cd1';
const V2_SHA = 'a2570315b911add3c57231f08b84214daa56750f9c93fd76c5d8b459d28c3efb';
const CAPABILITY_REASON = `work-status:active=v2;v1=${V1_SHA};v2=${V2_SHA}`;

function loadRuntimeIdentity() {
  const nativeMessages = [];
  const alarms = [];
  const alarmListeners = [];
  const context = vm.createContext({
    console,
    crypto: { randomUUID: () => 'runtime-id-0918' },
    ChatGPTNotifierStatusCode: {
      contractId: 'github-work-status/v2',
      contractSemanticSha256: V2_SHA,
      supportedContracts: {
        'github-work-status/v1': V1_SHA,
        'github-work-status/v2': V2_SHA
      }
    },
    sendNative: (message) => {
      nativeMessages.push(structuredClone(message));
      return true;
    },
    chrome: {
      runtime: { getManifest: () => ({ version: '0.9.18' }) },
      alarms: {
        create: (name, options) => alarms.push({ name, options: structuredClone(options) }),
        onAlarm: { addListener: (listener) => alarmListeners.push(listener) }
      }
    }
  });
  vm.runInContext(source, context);
  return { context, nativeMessages, alarms, alarmListeners };
}

test('runtime identity publishes exact v1/v2 work-status capability and schedules a local heartbeat', () => {
  const runtime = loadRuntimeIdentity();
  assert.equal(runtime.nativeMessages.length, 1);
  assert.equal(runtime.nativeMessages[0].type, 'diagnostics.event');
  const diagnostic = runtime.nativeMessages[0].diagnostic;
  assert.equal(diagnostic.source, 'extension-runtime');
  assert.equal(diagnostic.status, 'worker-connected');
  assert.equal(diagnostic.extensionVersion, '0.9.18');
  assert.equal(diagnostic.captureSource, 'runtime-identity-heartbeat-v4');
  assert.equal(diagnostic.reason, CAPABILITY_REASON);
  assert.ok(diagnostic.reason.length <= 160);
  assert.equal(diagnostic.workStatusContractId, 'github-work-status/v2');
  assert.equal(diagnostic.workStatusContractSemanticSha256, V2_SHA);
  assert.equal(
    diagnostic.workStatusCompatibility,
    `github-work-status/v1@${V1_SHA};github-work-status/v2@${V2_SHA}`
  );

  assert.equal(runtime.alarms.length, 1);
  assert.equal(runtime.alarms[0].name, 'chatgpt-notifier-runtime-identity-heartbeat');
  assert.equal(runtime.alarms[0].options.periodInMinutes, 0.5);
  assert.equal(runtime.alarmListeners.length, 1);
});

test('runtime heartbeat refreshes identity and contract capability only for its own alarm', () => {
  const runtime = loadRuntimeIdentity();
  runtime.alarmListeners[0]({ name: 'unrelated' });
  assert.equal(runtime.nativeMessages.length, 1);

  runtime.alarmListeners[0]({ name: 'chatgpt-notifier-runtime-identity-heartbeat' });
  assert.equal(runtime.nativeMessages.length, 2);
  const diagnostic = runtime.nativeMessages[1].diagnostic;
  assert.equal(diagnostic.status, 'worker-alive');
  assert.equal(diagnostic.extensionVersion, '0.9.18');
  assert.equal(diagnostic.captureSource, 'runtime-identity-heartbeat-v4');
  assert.equal(diagnostic.reason, CAPABILITY_REASON);
  assert.equal(diagnostic.workStatusContractId, 'github-work-status/v2');
  assert.equal(diagnostic.workStatusContractSemanticSha256, V2_SHA);
});

test('helper evidence path preserves a bounded exact contract capability', () => {
  assert.match(sanitizerSource, /reason = StringValue\(input, "reason", 160\)/);
  assert.match(publisherSource, /reason = StringValue\(input, "reason", 160\)/);
  assert.match(sanitizerSource, /workStatusContractId = StringValue\(input, "workStatusContractId", 64\)/);
  assert.match(sanitizerSource, /workStatusContractSemanticSha256 = StringValue\(input, "workStatusContractSemanticSha256", 64\)/);
  assert.match(sanitizerSource, /workStatusCompatibility = StringValue\(input, "workStatusCompatibility", 320\)/);
});
