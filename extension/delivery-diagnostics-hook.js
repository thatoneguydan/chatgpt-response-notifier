'use strict';

(() => {
  if (globalThis.__chatgptNotifierDeliveryDiagnostics) return;

  function record(status, fields = {}) {
    const delivery = globalThis.__chatgptNotifierDeliveryReliability;
    if (delivery?.record) {
      delivery.record(status, fields);
      return;
    }

    let extensionVersion = '';
    try { extensionVersion = String(chrome.runtime.getManifest().version || ''); } catch {}
    const suffix = (value) => {
      const text = String(value || '').trim();
      return text.length <= 8 ? text : text.slice(-8);
    };
    const diagnostic = {
      source: 'delivery-pipeline',
      status: String(status || 'unknown'),
      observedAt: new Date().toISOString(),
      extensionVersion,
      reason: fields.reason ? String(fields.reason).replace(/[\r\n\t]+/g, ' ').slice(0, 160) : undefined,
      conversationSuffix: suffix(fields.conversationId),
      notificationSuffix: suffix(fields.notificationId)
    };
    try {
      if (typeof sendNative === 'function') sendNative({ type: 'diagnostics.event', diagnostic });
    } catch {}
  }

  // Delivery diagnostics are now emitted synchronously at the actual pipeline
  // boundaries by delivery-reliability-background.js and the Windows helper.
  // Keep this compatibility surface for diagnostic probes without re-querying
  // ChatGPT or inferring delivery from coordinator/outbox absence.
  async function diagnose(tabId, snapshot) {
    record('diagnostic-probe-requested', {
      tabId,
      conversationId: snapshot?.conversationId,
      reason: 'stage-events-are-authoritative'
    });
    return { authoritative: 'stage-events' };
  }

  globalThis.__chatgptNotifierDeliveryDiagnostics = Object.freeze({
    version: 2,
    record,
    diagnose
  });
})();