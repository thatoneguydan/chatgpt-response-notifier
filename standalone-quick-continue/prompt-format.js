'use strict';

(() => {
  if (globalThis.ChatGPTQuickContinuePrompts) return;

  const normalizeInline = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function formatTimestamp(date = new Date()) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      }).format(date);
    } catch {
      return date.toLocaleString();
    }
  }

  function timestamped(message, date = new Date()) {
    return `[${formatTimestamp(date)}] ${normalizeInline(message)}`;
  }

  function continuePrompt(date = new Date()) {
    return timestamped('Continue until you finish or need something from me.', date);
  }

  function projectContinuePrompt(projectName, date = new Date()) {
    const project = normalizeInline(projectName);
    if (!project) return '';
    return timestamped(`Continue ${project} from canonical GitHub state until you finish or need me.`, date);
  }

  globalThis.ChatGPTQuickContinuePrompts = Object.freeze({
    normalizeInline,
    formatTimestamp,
    timestamped,
    continuePrompt,
    projectContinuePrompt
  });
})();
