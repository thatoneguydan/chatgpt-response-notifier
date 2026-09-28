'use strict';

(() => {
  if (globalThis.__chatgptNotifierTerminalLiveProof) return;

  const RUNTIME_VERSION = 2;
  const OBSERVATION_DELAYS_MS = Object.freeze([50, 350, 1200]);

  function suffix(value) {
    const text = String(value || '').trim();
    return text.length <= 8 ? text : text.slice(-8);
  }

  function buildCommitSuffix() {
    const text = String(globalThis.__chatgptNotifierBuildIdentity?.sourceCommit || '').trim();
    return text.length <= 12 ? text : text.slice(-12);
  }

  function emit(status, fields = {}) {
    let extensionVersion = '';
    try { extensionVersion = String(chrome.runtime.getManifest().version || ''); } catch {}
    const commitSuffix = buildCommitSuffix();
    const fieldReason = fields.reason ? String(fields.reason).replace(/[\r\n\t]+/g, ' ').slice(0, 140) : '';
    const diagnostic = {
      source: 'terminal-live-proof',
      status: String(status || 'unknown').slice(0, 80),
      observedAt: new Date().toISOString(),
      extensionVersion,
      buildCommitSuffix: commitSuffix,
      tabId: Number.isInteger(fields.tabId) ? fields.tabId : undefined,
      statusCode: fields.statusCode ? String(fields.statusCode).slice(0, 40) : undefined,
      reason: `build=${commitSuffix || 'unknown'}${fieldReason ? `;${fieldReason}` : ''}`.slice(0, 160),
      conversationSuffix: suffix(fields.conversationId),
      requestSuffix: suffix(fields.requestId),
      promptSuffix: suffix(fields.promptKey),
      assistantSuffix: suffix(fields.assistantKey),
      revisionSuffix: suffix(fields.assistantRevision)
    };
    try {
      if (typeof sendNative === 'function') sendNative({ type: 'diagnostics.event', diagnostic });
    } catch {}
  }

  function targetForSender(sender) {
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    if (typeof monitor?.chatTargetFromTab !== 'function') return null;
    try { return monitor.chatTargetFromTab(sender?.tab) || null; } catch { return null; }
  }

  function diagnosticFields(message, sender, target) {
    const snapshot = message?.snapshot || {};
    return {
      tabId: sender?.tab?.id,
      statusCode: message?.statusCode,
      conversationId: snapshot.conversationId || target?.id,
      requestId: snapshot.requestId,
      promptKey: snapshot.promptKey,
      assistantKey: snapshot.assistantKey,
      assistantRevision: snapshot.assistantRevision
    };
  }

  async function observePersistedState(message, sender, target, delayMs) {
    if (!target?.id) return;
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    if (typeof monitor?.monitorOverview !== 'function') return;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

    let overview = null;
    try { overview = await monitor.monitorOverview(target); } catch {}
    const watchdog = overview?.codeWatchdog || null;
    const expectedStop = `status:${String(message?.statusCode || '')}`;
    const stopped = watchdog?.stopped === true && String(watchdog?.stopReason || '') === expectedStop;
    const reason = [
      `delay=${delayMs}`,
      `automation=${overview?.automationEnabled === true ? 'on' : 'off'}`,
      `watchdog=${watchdog ? 'present' : 'missing'}`,
      `stopped=${watchdog?.stopped === true ? 'true' : 'false'}`,
      `stopReason=${String(watchdog?.stopReason || 'none').slice(0, 56)}`,
      `deadline=${Number(watchdog?.deadlineAt || 0) > 0 ? 'set' : 'zero'}`
    ].join(';');
    emit(stopped ? 'terminal-watchdog-stopped-observed' : 'terminal-watchdog-not-stopped-observed', {
      ...diagnosticFields(message, sender, target),
      reason
    });
  }

  function handleMessage(message, sender) {
    if (!['CHATGPT_RENDERED_TERMINAL_STATUS', 'CHATGPT_RESPONSE_STREAM_TERMINAL_STATUS'].includes(String(message?.type || ''))) {
      return false;
    }
    const target = targetForSender(sender);
    emit('terminal-message-received', {
      ...diagnosticFields(message, sender, target),
      reason: String(message?.type || '')
    });
    for (const delayMs of OBSERVATION_DELAYS_MS) {
      observePersistedState(message, sender, target, delayMs).catch(() => {});
    }
    return false;
  }

  try { chrome.runtime.onMessage.addListener(handleMessage); } catch {}

  globalThis.__chatgptNotifierTerminalLiveProof = Object.freeze({
    version: RUNTIME_VERSION,
    emit,
    observePersistedState
  });
})();
