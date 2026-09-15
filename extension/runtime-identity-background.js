'use strict';

(() => {
  if (globalThis.__chatgptNotifierRuntimeIdentity) return;

  const HEARTBEAT_ALARM = 'chatgpt-notifier-runtime-identity-heartbeat';
  const HEARTBEAT_PERIOD_MINUTES = 0.5;
  const CAPABILITY = 'runtime-identity-heartbeat-v3';

  let extensionVersion = '';
  let runtimeId = '';
  try { extensionVersion = String(chrome.runtime.getManifest().version || ''); } catch {}
  try { runtimeId = crypto.randomUUID(); } catch { runtimeId = `${Date.now()}-${Math.random()}`; }

  function publish(status = 'worker-alive') {
    const diagnostic = {
      source: 'extension-runtime',
      status: String(status || 'worker-alive'),
      observedAt: new Date().toISOString(),
      extensionVersion,
      correlationId: runtimeId,
      captureSource: CAPABILITY
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
    version: 3,
    extensionVersion,
    runtimeId,
    capability: CAPABILITY,
    heartbeatAlarm: HEARTBEAT_ALARM,
    publish,
    scheduleHeartbeat
  });
  globalThis.__chatgptNotifierRuntimeIdentity = runtime;
  publish('worker-connected');
  scheduleHeartbeat();
})();
