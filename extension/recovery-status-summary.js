'use strict';

(() => {
  if (globalThis.ChatGPTNotifierRecoveryStatusSummary?.version === 1) return;

  const number = (value) => Math.max(0, Number(value || 0));
  const text = (value) => String(value || '');

  function summarize(overview = {}, now = Date.now()) {
    const recovery = overview?.recovery || null;
    const incident = recovery?.incident || null;
    const humanRun = recovery?.humanRun || null;
    const profile = recovery?.profile || null;
    const budget = incident?.budget || {};
    const reloads = number(budget.reloads);
    const continuations = number(budget.continuations);
    const generationActions = number(humanRun?.generationActions);
    const nextDueAt = number(incident?.nextEligibleAt);
    const governorAt = number(profile?.nextProfileActionAt);
    const breakerOpen = profile?.breakerOpen === true;
    const uncertain = budget.uncertainAction === true;

    let blockedReason = '';
    if (breakerOpen) blockedReason = text(profile?.breakerReason || 'profile-breaker-open');
    else if (uncertain) blockedReason = 'prior-action-uncertain';
    else if (generationActions >= 12) blockedReason = 'run-action-cap-reached';
    else if (incident?.state === 'attention') blockedReason = text(incident.reason || 'recovery-needs-attention');

    return Object.freeze({
      active: Boolean(incident || humanRun),
      incidentState: text(incident?.state),
      incidentReason: text(incident?.reason),
      reloads,
      continuations,
      attempts: reloads + continuations,
      generationActions,
      nextDueAt,
      nextDuePending: nextDueAt > Number(now),
      governorAt,
      governorHeld: governorAt > Number(now),
      breakerOpen,
      uncertain,
      blockedReason
    });
  }

  globalThis.ChatGPTNotifierRecoveryStatusSummary = Object.freeze({ version: 1, summarize });
})();
