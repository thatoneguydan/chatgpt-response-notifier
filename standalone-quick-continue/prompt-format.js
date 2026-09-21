'use strict';

(() => {
  const RUNTIME_VERSION = 2;
  if (Number(globalThis.ChatGPTQuickContinuePrompts?.runtimeVersion || 0) === RUNTIME_VERSION) return;

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

  function continuePrompt(continueText, date = new Date()) {
    return timestamped(continueText, date);
  }

  function renderProjectText(projectText, projectName) {
    const project = normalizeInline(projectName);
    const template = normalizeInline(projectText);
    if (!project || !template || !template.includes('{project}')) return '';
    return template.split('{project}').join(project);
  }

  function projectContinuePrompt(projectName, projectText, date = new Date()) {
    const message = renderProjectText(projectText, projectName);
    return message ? timestamped(message, date) : '';
  }

  globalThis.ChatGPTQuickContinuePrompts = Object.freeze({
    runtimeVersion: RUNTIME_VERSION,
    normalizeInline,
    formatTimestamp,
    timestamped,
    continuePrompt,
    renderProjectText,
    projectContinuePrompt
  });
})();
