'use strict';

(() => {
  if (globalThis.__chatgptNotifierV0914Safety) return;

  const RUNTIME_VERSION = 3;
  const PASSIVE_STATUS_REASON = 'status-missing-passive';
  const RESOLVED_COMPAT_REASON = 'work-resumed-after-reload';

  function passiveStatusMissing(classification = {}) {
    if (!['status-missing', PASSIVE_STATUS_REASON].includes(String(classification?.reason || ''))) return classification;
    return {
      ...classification,
      state: 'waiting',
      reason: PASSIVE_STATUS_REASON,
      automaticActionAllowed: false,
      recoveryCandidate: false,
      formatRepairCandidate: false
    };
  }

  const originalPolicy = globalThis.ChatGPTNotifierContinuationPolicy;
  if (originalPolicy && typeof originalPolicy === 'object') {
    globalThis.ChatGPTNotifierContinuationPolicy = Object.freeze({
      ...originalPolicy,
      runtimeVersion: Math.max(5, Number(originalPolicy.runtimeVersion || 0)),
      classifyObservation(observation = {}) {
        return passiveStatusMissing(originalPolicy.classifyObservation?.(observation) || {});
      },
      recoveryActionDecision(kind, budgetValue = {}, options = {}) {
        if (String(kind || '') === 'format-repair') {
          return {
            allowed: false,
            reason: 'format-repair-retired',
            budget: originalPolicy.normalizeBudget?.(budgetValue) || { ...(budgetValue || {}) }
          };
        }
        return originalPolicy.recoveryActionDecision?.(kind, budgetValue, options) || {
          allowed: false,
          reason: 'recovery-policy-unavailable'
        };
      },
      beginRecoveryAction(kind, budgetValue = {}, options = {}) {
        if (String(kind || '') === 'format-repair') {
          return {
            allowed: false,
            reason: 'format-repair-retired',
            budget: originalPolicy.normalizeBudget?.(budgetValue) || { ...(budgetValue || {}) }
          };
        }
        return originalPolicy.beginRecoveryAction?.(kind, budgetValue, options) || {
          allowed: false,
          reason: 'recovery-policy-unavailable'
        };
      }
    });
  }

  const originalModel = globalThis.ChatGPTNotifierRecoveryModel;
  if (originalModel && typeof originalModel === 'object') {
    globalThis.ChatGPTNotifierRecoveryModel = Object.freeze({
      ...originalModel,
      recoveryCandidate(classification = {}, observation = {}, incidentValue = {}) {
        const classificationReason = String(classification?.reason || '');
        if (classificationReason === 'status-missing' || classificationReason === PASSIVE_STATUS_REASON) {
          return { kind: '', reason: PASSIVE_STATUS_REASON };
        }
        const result = originalModel.recoveryCandidate?.(classification, observation, incidentValue) || { kind: '', reason: 'no-recovery-candidate' };
        if (String(result?.kind || '') === 'format-repair' || String(result?.reason || '') === 'status-missing') {
          return { kind: '', reason: RESOLVED_COMPAT_REASON };
        }
        return result;
      },
      admissionDecision(kind, ...args) {
        if (String(kind || '') === 'format-repair') return { allowed: false, reason: 'format-repair-retired' };
        return originalModel.admissionDecision?.(kind, ...args) || { allowed: false, reason: 'recovery-model-unavailable' };
      },
      claimAction(kind, ...args) {
        if (String(kind || '') === 'format-repair') return { allowed: false, reason: 'format-repair-retired' };
        return originalModel.claimAction?.(kind, ...args) || { allowed: false, reason: 'recovery-model-unavailable' };
      },
      postReloadDecision(observation = {}, expected = {}) {
        const result = originalModel.postReloadDecision?.(observation, expected) || { kind: '', state: 'attention', reason: 'recovery-model-unavailable' };
        if (String(result?.kind || '') === 'format-repair' || String(result?.reason || '') === 'status-missing') {
          return { kind: '', state: 'resolved', reason: PASSIVE_STATUS_REASON };
        }
        return result;
      }
    });
  }

  const MONITOR_DB_NAME = 'chatgpt-response-notifier-monitor';
  const ATTENTION_STORE_NAME = 'attention';
  const staleAttentionIds = [];

  function retirePersistedStatusMissingAttention() {
    return new Promise((resolve) => {
      let request;
      try { request = indexedDB.open(MONITOR_DB_NAME, 1); }
      catch { resolve([]); return; }

      request.onupgradeneeded = () => {
        try { request.transaction?.abort(); } catch {}
      };
      request.onerror = () => resolve([]);
      request.onsuccess = () => {
        const database = request.result;
        try {
          if (!database.objectStoreNames.contains(ATTENTION_STORE_NAME)) {
            database.close();
            resolve([]);
            return;
          }
          const transaction = database.transaction(ATTENTION_STORE_NAME, 'readwrite');
          const store = transaction.objectStore(ATTENTION_STORE_NAME);
          const all = store.getAll();
          all.onsuccess = () => {
            for (const record of Array.isArray(all.result) ? all.result : []) {
              if (String(record?.reason || '') !== 'status-missing') continue;
              const id = String(record?.attentionId || '');
              if (id) staleAttentionIds.push(id);
              if (id) store.delete(id);
            }
          };
          transaction.oncomplete = () => {
            try { database.close(); } catch {}
            resolve([...staleAttentionIds]);
          };
          transaction.onerror = () => {
            try { database.close(); } catch {}
            resolve([...staleAttentionIds]);
          };
          transaction.onabort = transaction.onerror;
        } catch {
          try { database.close(); } catch {}
          resolve([...staleAttentionIds]);
        }
      };
    });
  }

  function dismissRetiredAttentionToasts(attempt = 0) {
    if (!staleAttentionIds.length) return true;
    if (typeof globalThis.sendNative === 'function') {
      for (const notificationId of staleAttentionIds.splice(0)) {
        try { globalThis.sendNative({ type: 'toast.dismissEvent', notificationId }); } catch {}
      }
      return true;
    }
    if (attempt < 120) setTimeout(() => dismissRetiredAttentionToasts(attempt + 1), 25);
    return false;
  }

  // The primary service-worker now owns Chrome-only click navigation directly.
  // This compatibility layer intentionally does not replace it; replacing the
  // function would discard primary click-stage diagnostics and could regress the
  // exact route this layer originally existed to protect.
  function verifyPrimaryClickPath() {
    return typeof globalThis.requestNativeChromeForeground !== 'function';
  }

  retirePersistedStatusMissingAttention().then(() => dismissRetiredAttentionToasts()).catch(() => {});

  globalThis.__chatgptNotifierV0914Safety = Object.freeze({
    version: RUNTIME_VERSION,
    passiveStatusReason: PASSIVE_STATUS_REASON,
    formatRepairRetired: true,
    staleStatusMissingAttentionRetired: true,
    retirePersistedStatusMissingAttention,
    dismissRetiredAttentionToasts,
    verifyPrimaryClickPath
  });
})();
