'use strict';

(() => {
  if (globalThis.ChatGPTNotifierContinuationPolicy) return;

  function identityMatches(current, expected) {
    return Boolean(
      current && expected &&
      current.statusCode === 'INCOMPLETE_LIMIT' &&
      current.conversationId === expected.conversationId &&
      current.documentId === expected.documentId &&
      current.promptKey === expected.promptKey &&
      current.assistantKey === expected.assistantKey &&
      current.revision === expected.revision
    );
  }

  function userInteractionBlockReason({
    composerText = '',
    documentFocused = false,
    documentVisible = false,
    lastTrustedInteractionAt = 0,
    now = Date.now(),
    guardMs = 3000
  } = {}) {
    if (String(composerText || '').trim()) return 'composer-not-empty';
    if (!documentFocused || !documentVisible) return '';
    const interactedAt = Number(lastTrustedInteractionAt || 0);
    if (interactedAt > 0 && Number(now) - interactedAt <= Number(guardMs)) return 'active-user-interaction';
    return '';
  }

  function continuationOutcome({ pageTurnConfirmed = false, requestAccepted = false, sameConversation = false } = {}) {
    if (!sameConversation) return { accepted: false, reason: 'conversation-changed-after-action' };
    if (!pageTurnConfirmed) return { accepted: false, reason: 'continuation-user-turn-not-confirmed' };
    if (!requestAccepted) return { accepted: false, reason: 'request-unconfirmed' };
    return { accepted: true, reason: 'continuation-confirmed' };
  }

  globalThis.ChatGPTNotifierContinuationPolicy = Object.freeze({
    identityMatches,
    userInteractionBlockReason,
    continuationOutcome
  });
})();
