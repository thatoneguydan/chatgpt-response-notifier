'use strict';

(() => {
  if (globalThis.__chatgptNotifierV0914Safety) return;

  const RUNTIME_VERSION = 1;
  const PASSIVE_STATUS_REASON = 'status-missing-passive';
  const RESOLVED_COMPAT_REASON = 'work-resumed-after-reload';

  function passiveStatusMissing(classification = {}) {
    if (String(classification?.reason || '') !== 'status-missing') return classification;
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
        const result = originalPolicy.classifyObservation?.(observation) || {};
        return passiveStatusMissing(result);
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
          return { kind: '', reason: RESOLVED_COMPAT_REASON };
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

  function conversationFromUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''));
      if (!['chatgpt.com', 'www.chatgpt.com'].includes(url.hostname)) return null;
      const parts = url.pathname.split('/').filter(Boolean);
      for (let index = parts.length - 2; index >= 0; index -= 1) {
        if (parts[index] !== 'c') continue;
        const id = decodeURIComponent(parts[index + 1] || '').trim();
        if (id) return { id, url: `https://chatgpt.com${url.pathname.replace(/\/+$/, '')}` };
      }
    } catch {}
    return null;
  }

  async function chromeOnlyConversationFocus(conversationId, conversationUrl) {
    const id = String(conversationId || '');
    const target = conversationFromUrl(conversationUrl);
    if (!id || !target || target.id !== id) return false;

    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); } catch {}
    const existing = tabs.find((tab) => conversationFromUrl(tab?.url || '')?.id === id);

    if (Number.isInteger(existing?.id)) {
      await chrome.tabs.update(existing.id, { active: true });
      if (Number.isInteger(existing.windowId)) {
        try { await chrome.windows.update(existing.windowId, { focused: true }); } catch {}
      }
    } else {
      const created = await chrome.tabs.create({ url: target.url, active: true });
      if (Number.isInteger(created?.windowId)) {
        try { await chrome.windows.update(created.windowId, { focused: true }); } catch {}
      }
    }

    try { globalThis.sendNative?.({ type: 'toast.dismissConversation', conversationId: id }); } catch {}
    return true;
  }

  function installChromeOnlyToastClick(attempt = 0) {
    const focusReady = typeof globalThis.focusOrOpenConversation === 'function';
    const nativeForegroundReady = typeof globalThis.requestNativeChromeForeground === 'function';
    if (focusReady || nativeForegroundReady) {
      // Defense in depth: even if a stale caller retains the old focus helper,
      // the native Win32 foreground request is permanently disabled.
      globalThis.requestNativeChromeForeground = async () => false;
      globalThis.focusOrOpenConversation = chromeOnlyConversationFocus;
      return true;
    }
    if (attempt < 120) setTimeout(() => installChromeOnlyToastClick(attempt + 1), 25);
    return false;
  }

  setTimeout(() => installChromeOnlyToastClick(), 0);

  globalThis.__chatgptNotifierV0914Safety = Object.freeze({
    version: RUNTIME_VERSION,
    passiveStatusReason: PASSIVE_STATUS_REASON,
    formatRepairRetired: true,
    chromeOnlyConversationFocus,
    installChromeOnlyToastClick
  });
})();
