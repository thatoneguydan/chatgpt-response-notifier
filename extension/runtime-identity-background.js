'use strict';

(() => {
  if (globalThis.__chatgptNotifierRuntimeIdentity) return;

  const HEARTBEAT_ALARM = 'chatgpt-notifier-runtime-identity-heartbeat';
  const HEARTBEAT_PERIOD_MINUTES = 0.5;
  const CAPABILITY = 'runtime-identity-heartbeat-v4';

  let extensionVersion = '';
  let sourceCommitSuffix = '';
  let runtimeId = '';
  try { extensionVersion = String(chrome.runtime.getManifest().version || ''); } catch {}
  try {
    const sourceCommit = String(globalThis.__chatgptNotifierBuildIdentity?.sourceCommit || '').trim().toLowerCase();
    sourceCommitSuffix = /^[0-9a-f]{40}$/.test(sourceCommit) ? sourceCommit.slice(-8) : '';
  } catch {}
  try { runtimeId = crypto.randomUUID(); } catch { runtimeId = `${Date.now()}-${Math.random()}`; }

  function workStatusCapability() {
    const api = globalThis.ChatGPTNotifierStatusCode;
    const supported = api?.supportedContracts && typeof api.supportedContracts === 'object'
      ? Object.entries(api.supportedContracts)
          .map(([contractId, digest]) => `${String(contractId || '')}@${String(digest || '')}`)
          .filter((value) => value && !value.startsWith('@'))
          .sort()
          .join(';')
      : '';
    const v1 = String(api?.supportedContracts?.['github-work-status/v1'] || '');
    const v2 = String(api?.supportedContracts?.['github-work-status/v2'] || '');
    const evidenceReason = v1 && v2
      ? `work-status:active=v2;v1=${v1};v2=${v2}`
      : 'work-status:capability-unavailable';
    return {
      workStatusContractId: String(api?.contractId || ''),
      workStatusContractSemanticSha256: String(api?.contractSemanticSha256 || ''),
      workStatusCompatibility: supported,
      evidenceReason
    };
  }

  function publish(status = 'worker-alive') {
    const capability = workStatusCapability();
    const diagnostic = {
      source: 'extension-runtime',
      status: String(status || 'worker-alive'),
      observedAt: new Date().toISOString(),
      extensionVersion,
      sourceCommitSuffix,
      correlationId: runtimeId,
      captureSource: CAPABILITY,
      reason: capability.evidenceReason,
      workStatusContractId: capability.workStatusContractId,
      workStatusContractSemanticSha256: capability.workStatusContractSemanticSha256,
      workStatusCompatibility: capability.workStatusCompatibility
    };
    try {
      if (typeof sendNative === 'function') return sendNative({ type: 'diagnostics.event', diagnostic });
    } catch {}
    return false;
  }

  function scheduleHeartbeat() {
    try {
      chrome.alarms.create(HEARTBEAT_ALARM, {
        delayInMinutes: HEARTBEAT_PERIOD_MINUTES,
        periodInMinutes: HEARTBEAT_PERIOD_MINUTES
      });
      return true;
    } catch {
      return false;
    }
  }

  try {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm?.name !== HEARTBEAT_ALARM) return;
      publish('worker-alive');
    });
  } catch {}

  const runtime = Object.freeze({
    version: 4,
    extensionVersion,
    sourceCommitSuffix,
    runtimeId,
    capability: CAPABILITY,
    heartbeatAlarm: HEARTBEAT_ALARM,
    workStatusCapability,
    publish,
    scheduleHeartbeat
  });
  globalThis.__chatgptNotifierRuntimeIdentity = runtime;
  publish('worker-connected');
  scheduleHeartbeat();
})();
