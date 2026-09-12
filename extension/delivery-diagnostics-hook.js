'use strict';

(() => {
  if (globalThis.__chatgptNotifierDeliveryDiagnostics) return;

  const observed = new Set();
  let extensionVersion = '';
  try { extensionVersion = String(chrome.runtime.getManifest().version || ''); } catch {}

  function suffix(value) {
    const text = String(value || '').trim();
    return text.length <= 8 ? text : text.slice(-8);
  }

  function record(status, fields = {}) {
    const diagnostic = {
      source: 'delivery-diagnostics',
      status: String(status || 'unknown'),
      observedAt: new Date().toISOString(),
      extensionVersion,
      tabId: Number.isInteger(fields.tabId) ? fields.tabId : undefined,
      frozen: fields.frozen === true,
      discarded: fields.discarded === true,
      deliveredNow: fields.deliveredNow === true,
      triggerPath: fields.triggerPath ? String(fields.triggerPath) : undefined,
      reason: fields.reason ? String(fields.reason) : undefined,
      error: fields.error ? String(fields.error).slice(0, 240) : undefined,
      conversationSuffix: suffix(fields.conversationId),
      notificationSuffix: suffix(fields.notificationId)
    };
    try {
      if (typeof sendNative === 'function') {
        sendNative({ type: 'diagnostics.event', diagnostic });
      }
    } catch {}
  }

  async function diagnose(tabId, snapshot) {
    record('monitor-terminal-seen', {
      tabId,
      conversationId: snapshot?.conversationId,
      triggerPath: 'CHATGPT_MONITOR_STATE'
    });

    if (typeof queryTerminalStatus !== 'function') {
      record('status-query-unavailable', { tabId, conversationId: snapshot?.conversationId, reason: 'queryTerminalStatus-missing' });
      return;
    }

    let status = null;
    try {
      status = await queryTerminalStatus(tabId, '', 5000);
    } catch (error) {
      record('status-query-error', { tabId, conversationId: snapshot?.conversationId, error: error?.message || error });
      return;
    }

    const code = String(status?.statusCode || '');
    if (!globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(code)) {
      record('status-query-missing', {
        tabId,
        conversationId: snapshot?.conversationId,
        reason: status?.ok === true ? 'no-terminal-code' : 'query-not-ok'
      });
      return;
    }

    record('status-query-valid', {
      tabId,
      conversationId: status?.conversationId,
      triggerPath: code
    });

    const state = globalThis.__chatgptNotifierCoordinator;
    if (!state?.makeTurnKey || !state?.getTurn || !state?.listOutbox) {
      record('coordinator-unavailable', { tabId, conversationId: status?.conversationId });
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 750));

    let turn = null;
    let outbox = [];
    try {
      const turnKey = state.makeTurnKey(status);
      turn = turnKey ? await state.getTurn(turnKey) : null;
      outbox = await state.listOutbox();
      const pending = Array.isArray(outbox)
        ? outbox.find((item) => String(item?.turnKey || '') === String(turnKey || ''))
        : null;
      record(turn ? 'delivery-turn-present' : 'delivery-turn-missing', {
        tabId,
        conversationId: status?.conversationId,
        notificationId: pending?.notification?.id || turn?.notificationId || '',
        deliveredNow: Boolean(turn && !pending),
        reason: turn ? String(turn.state || 'turn-present') : 'turn-not-created'
      });
      if (pending) {
        record('delivery-outbox-pending', {
          tabId,
          conversationId: status?.conversationId,
          notificationId: pending?.notification?.id || '',
          reason: 'durable-outbox-record-present'
        });
      }
    } catch (error) {
      record('delivery-state-read-error', {
        tabId,
        conversationId: status?.conversationId,
        error: error?.message || error
      });
    }
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== 'CHATGPT_MONITOR_STATE') return false;
    const snapshot = message?.snapshot || {};
    const statusCode = String(snapshot.statusCode || '');
    if (!globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(statusCode)) return false;
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId)) return false;

    const key = [
      tabId,
      String(snapshot.conversationId || ''),
      String(snapshot.promptKey || ''),
      String(snapshot.assistantKey || ''),
      String(snapshot.assistantRevision || ''),
      statusCode
    ].join('|');
    if (observed.has(key)) return false;
    observed.add(key);
    if (observed.size > 200) observed.delete(observed.values().next().value);

    diagnose(tabId, snapshot).catch((error) => {
      record('diagnostic-run-error', {
        tabId,
        conversationId: snapshot?.conversationId,
        error: error?.message || error
      });
    });
    return false;
  });

  globalThis.__chatgptNotifierDeliveryDiagnostics = Object.freeze({
    version: 1,
    record,
    diagnose
  });
})();
