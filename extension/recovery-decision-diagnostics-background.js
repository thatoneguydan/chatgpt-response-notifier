'use strict';

(() => {
  if (globalThis.__chatgptNotifierRecoveryDecisionDiagnostics?.version === 1) return;

  const base = globalThis.ChatGPTNotifierRecoveryModel;
  if (!base || typeof base !== 'object') return;
  const incidentObservations = new Map();

  const suffix = (value) => {
    const text = String(value || '').trim();
    return text.length <= 8 ? text : text.slice(-8);
  };

  function record(status, kind, reason, observation = {}, incident = null, fields = {}) {
    const diagnostic = {
      source: 'recovery-decision',
      status: String(status || 'decision').slice(0, 96),
      observedAt: new Date().toISOString(),
      extensionVersion: (() => { try { return String(chrome.runtime.getManifest().version || ''); } catch { return ''; } })(),
      reason: String(reason || '').replace(/[\r\n\t]+/g, ' ').slice(0, 160),
      actionKind: String(kind || '').slice(0, 32),
      allowed: typeof fields.allowed === 'boolean' ? fields.allowed : undefined,
      decisionState: String(fields.decisionState || '').slice(0, 48),
      uncertain: typeof fields.uncertain === 'boolean' ? fields.uncertain : undefined,
      conversationSuffix: suffix(observation.conversationId),
      chromeDocumentSuffix: suffix(observation.documentId),
      requestSuffix: suffix(observation.requestId),
      incidentSuffix: suffix(incident?.incidentId),
      generationSuffix: suffix(incident?.generationKey)
    };
    try {
      if (typeof sendNative === 'function') sendNative({ type: 'diagnostics.event', diagnostic });
    } catch {}
  }

  globalThis.ChatGPTNotifierRecoveryModel = Object.freeze({
    ...base,
    recoveryCandidate(classification = {}, observation = {}, incident = {}) {
      const result = base.recoveryCandidate(classification, observation, incident);
      record('candidate', result?.kind || '', result?.reason || classification?.reason || incident?.reason || '', observation, incident, {
        allowed: Boolean(result?.kind),
        decisionState: classification?.state || ''
      });
      return result;
    },
    claimAction(kind, humanRun, incident, profile, observation = {}, options = {}) {
      const result = base.claimAction(kind, humanRun, incident, profile, observation, options);
      if (result?.allowed === true && incident?.incidentId) {
        incidentObservations.set(String(incident.incidentId), {
          conversationId: suffix(observation.conversationId),
          documentId: suffix(observation.documentId),
          requestId: suffix(observation.requestId)
        });
      }
      record(result?.allowed ? 'action-admitted' : 'action-blocked', kind, result?.reason || '', observation, incident, {
        allowed: result?.allowed === true,
        decisionState: result?.incident?.state || incident?.state || ''
      });
      return result;
    },
    finishAction(humanRun, incident, profile, result = {}, options = {}) {
      const incidentId = String(incident?.incidentId || '');
      const observation = incidentObservations.get(incidentId) || {};
      const kind = String(incident?.inFlight?.kind || '');
      const finished = base.finishAction(humanRun, incident, profile, result, options);
      const uncertain = result?.uncertain === true;
      record('action-finished', kind, uncertain ? 'action-interrupted-uncertain' : (result?.state || finished?.incident?.state || ''), observation, incident, {
        allowed: true,
        decisionState: finished?.incident?.state || '',
        uncertain
      });
      if (incidentId) incidentObservations.delete(incidentId);
      return finished;
    },
    postReloadDecision(observation = {}, expected = {}) {
      const result = base.postReloadDecision(observation, expected);
      record('post-reload-decision', result?.kind || '', result?.reason || '', observation, null, {
        allowed: Boolean(result?.kind),
        decisionState: result?.state || ''
      });
      return result;
    }
  });

  globalThis.__chatgptNotifierRecoveryDecisionDiagnostics = Object.freeze({ version: 1 });
})();
