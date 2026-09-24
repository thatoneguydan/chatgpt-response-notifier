'use strict';

(() => {
  const RUNTIME_VERSION = 4;
  if (Number(globalThis.ChatGPTQuickContinuePrompts?.runtimeVersion || 0) === RUNTIME_VERSION) return;

  const normalizeInline = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const normalizeTemplate = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim();

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

  function renderTimeText(template, date = new Date()) {
    const text = normalizeTemplate(template);
    if (!text) return '';
    const time = formatTimestamp(date);
    if (!text.includes('{time}')) return `[${time}] ${text}`;
    return text.split('{time}').join(time);
  }

  function timestamped(message, date = new Date()) {
    return renderTimeText(`[{time}] ${normalizeTemplate(message)}`, date);
  }

  function continuePrompt(continueText, date = new Date()) {
    return renderTimeText(continueText, date);
  }

  function renderProjectText(projectText, projectName) {
    const project = normalizeInline(projectName);
    const template = normalizeTemplate(projectText);
    if (!project || !template || !template.includes('{project}')) return '';
    return template.split('{project}').join(project);
  }

  function projectContinuePrompt(projectName, projectText, date = new Date()) {
    const message = renderProjectText(projectText, projectName);
    return message ? renderTimeText(message, date) : '';
  }

  globalThis.ChatGPTQuickContinuePrompts = Object.freeze({
    runtimeVersion: RUNTIME_VERSION,
    normalizeInline,
    normalizeTemplate,
    formatTimestamp,
    renderTimeText,
    timestamped,
    continuePrompt,
    renderProjectText,
    projectContinuePrompt
  });
})();
