import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const monitorSource = readFileSync(new URL('extension/monitor-script.js', root), 'utf8');

test('a fresh request fails open by rearming a stopped green watchdog before publishing', () => {
  assert.match(monitorSource, /const RUNTIME_VERSION = 12/);
  assert.match(monitorSource, /async function rearmStoppedWatchdogForNewRequest\(\)/);
  assert.match(monitorSource, /GET_BUILD_AUTOMATION_OVERVIEW_FOR_SENDER/);
  assert.match(monitorSource, /overview\?\.automationEnabled !== true/);
  assert.match(monitorSource, /overview\?\.pausedByUser === true/);
  assert.match(monitorSource, /watchdog && watchdog\.stopped !== true/);
  assert.match(monitorSource, /ARM_CODE_WATCHDOG_FOR_SENDER/);
  assert.match(monitorSource, /source: 'request-start-fail-open'/);

  const requestPhaseStart = monitorSource.indexOf('function setRequestPhase');
  const requestPhaseEnd = monitorSource.indexOf('const messageListener', requestPhaseStart);
  assert.ok(requestPhaseStart >= 0 && requestPhaseEnd > requestPhaseStart, 'request phase handler must exist');
  const requestPhaseSource = monitorSource.slice(requestPhaseStart, requestPhaseEnd);
  const captureIndex = requestPhaseSource.indexOf('requestPriorPromptKey = lastPublishedPromptKey');
  const rearmIndex = requestPhaseSource.indexOf('rearmStoppedWatchdogForNewRequest()');
  const publishIndex = requestPhaseSource.indexOf('.finally(() => schedulePublish())');
  assert.ok(captureIndex >= 0, 'request start must remember the previously published prompt');
  assert.ok(rearmIndex > captureIndex, 'watchdog rearm must start after prior-prompt capture');
  assert.ok(publishIndex > rearmIndex, 'request state must publish only after the rearm attempt settles');
});

test('request/DOM ordering cannot attribute the previous terminal footer to the new request', () => {
  assert.match(monitorSource, /let lastPublishedPromptKey = '';/);
  assert.match(monitorSource, /let requestPriorPromptKey = '';/);

  const snapshotStart = monitorSource.indexOf('function snapshot()');
  const snapshotEnd = monitorSource.indexOf('function clearTimer', snapshotStart);
  assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart, 'snapshot function must exist');
  const snapshotSource = monitorSource.slice(snapshotStart, snapshotEnd);

  assert.match(snapshotSource, /const inheritedPriorPrompt = Boolean\(/);
  assert.match(snapshotSource, /turnState\.promptKey === requestPriorPromptKey/);
  assert.match(snapshotSource, /requestPriorPromptKey = ''/);
  assert.match(snapshotSource, /lastPublishedPromptKey = turnState\.promptKey/);
  assert.match(snapshotSource, /promptKey: inheritedPriorPrompt \? '' : turnState\.promptKey/);
  assert.match(snapshotSource, /statusCode: inheritedPriorPrompt \? '' : turnState\.statusCode/);
  assert.match(snapshotSource, /hasStatusEvidence: !inheritedPriorPrompt && turnState\.hasStatusEvidence === true/);
});
