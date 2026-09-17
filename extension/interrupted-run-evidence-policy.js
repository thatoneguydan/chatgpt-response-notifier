'use strict';

(() => {
  if (globalThis.ChatGPTNotifierInterruptedEvidencePolicy?.version === 1) return;

  const VERSION = 1;
  const EVIDENCE_TTL_MS = 30 * 60_000;
  const MAX_IDENTITY_CHARS = 256;

  const text = (value) => String(value || '').slice(0, MAX_IDENTITY_CHARS);
  const number = (value) => Math.max(0, Number(value || 0));

  function generationKey(value = {}) {
    const conversationId = text(value.conversationId);
    const promptKey = text(value.promptKey);
    return conversationId && promptKey ? `${conversationId}|${promptKey}` : '';
  }

  function normalizeEvidence(value = {}) {
    return {
      generationKey: text(value.generationKey || generationKey(value)),
      conversationId: text(value.conversationId),
      promptKey: text(value.promptKey),
      promptRevision: text(value.promptRevision),
      assistantKey: text(value.assistantKey),
      assistantRevision: text(value.assistantRevision),
      failureReason: text(value.failureReason),
      interruptionKind: text(value.interruptionKind),
      requestPhase: text(value.requestPhase),
      requestSettledAt: number(value.requestSettledAt),
      observedDocumentId: text(value.observedDocumentId || value.documentId),
      observedAt: number(value.observedAt)
    };
  }

  function fromObservation(observation = {}, classification = {}, now = Date.now()) {
    if (!observation.conversationId || !observation.promptKey) return null;
    if (observation.applicationStateIdentityMatched === false) return null;
    if (observation.explicitInterruption !== true || !observation.interruptionKind) return null;
    if (observation.rateLimited === true || observation.authRequired === true || observation.approvalRequired === true) return null;
    const evidence = normalizeEvidence({
      generationKey: generationKey(observation),
      conversationId: observation.conversationId,
      promptKey: observation.promptKey,
      promptRevision: observation.promptRevision,
      assistantKey: observation.assistantKey,
      assistantRevision: observation.assistantRevision,
      failureReason: classification.reason || observation.interruptionKind,
      interruptionKind: observation.interruptionKind,
      requestPhase: observation.requestPhase,
      requestSettledAt: observation.requestSettledAt,
      observedDocumentId: observation.documentId,
      observedAt: now
    });
    return evidence.generationKey && evidence.observedDocumentId ? evidence : null;
  }

  function evaluate(observation = {}, evidenceValue = {}, now = Date.now()) {
    const evidence = normalizeEvidence(evidenceValue);
    if (!evidence.generationKey || !evidence.observedAt) return { action: 'clear', reason: 'evidence-invalid', patch: null };
    if (number(now) - evidence.observedAt > EVIDENCE_TTL_MS) return { action: 'clear', reason: 'evidence-expired', patch: null };
    if (generationKey(observation) !== evidence.generationKey) return { action: 'clear', reason: 'request-identity-changed', patch: null };
    if (observation.statusCode) return { action: 'clear', reason: 'coded-terminal', patch: null };
    if (evidence.promptRevision && text(observation.promptRevision) !== evidence.promptRevision) return { action: 'clear', reason: 'prompt-revision-changed', patch: null };
    if (number(observation.requestStartedAt) > evidence.observedAt) return { action: 'clear', reason: 'new-request-started', patch: null };

    const currentAssistantKey = text(observation.assistantKey);
    const currentAssistantRevision = text(observation.assistantRevision);
    if (currentAssistantKey !== evidence.assistantKey || currentAssistantRevision !== evidence.assistantRevision) {
      return { action: 'clear', reason: 'assistant-response-changed', patch: null };
    }

    if (observation.explicitInterruption !== true && (observation.stopGenerating === true || observation.toolActivity === true)) {
      return { action: 'clear', reason: 'work-resumed', patch: null };
    }

    if (observation.rateLimited === true) return { action: 'retain', reason: 'rate-limited', patch: null };
    if (observation.authRequired === true) return { action: 'retain', reason: 'auth-required', patch: null };
    if (observation.approvalRequired === true) return { action: 'retain', reason: 'approval-required', patch: null };
    if (observation.manualStopped === true) return { action: 'retain', reason: 'manual-stop', patch: null };
    if (observation.hasDraft === true) return { action: 'retain', reason: 'draft-present', patch: null };
    if (observation.hasUpload === true) return { action: 'retain', reason: 'upload-present', patch: null };
    if (observation.online === false) return { action: 'retain', reason: 'offline', patch: null };
    if (observation.observable === false) return { action: 'retain', reason: 'page-unobservable', patch: null };
    if (observation.explicitInterruption === true) return { action: 'retain', reason: 'current-explicit-interruption', patch: null };

    const documentId = text(observation.documentId);
    if (!documentId || documentId === evidence.observedDocumentId) return { action: 'retain', reason: 'same-document', patch: null };

    return {
      action: 'patch',
      reason: 'durable-interrupted-run-evidence',
      patch: {
        explicitInterruption: true,
        interruptionKind: evidence.interruptionKind,
        interruptionAttribution: 'durable-interrupted-run',
        applicationStateIdentityMatched: true,
        applicationStateReason: 'durable-interrupted-run-evidence'
      }
    };
  }

  globalThis.ChatGPTNotifierInterruptedEvidencePolicy = Object.freeze({
    version: VERSION,
    evidenceTtlMs: EVIDENCE_TTL_MS,
    generationKey,
    normalizeEvidence,
    fromObservation,
    evaluate
  });
})();
