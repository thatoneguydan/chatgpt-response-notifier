'use strict';

(() => {
  if (globalThis.ChatGPTNotifierStatusCode) return;

  // Keep the notifier coupled to the stable footer shape, not to a duplicated
  // project-local list of policy codes. Any canonical uppercase status code can
  // be consumed without requiring a notifier release just to extend the taxonomy.
  const STATUS_LINE_PATTERN = /^\[GITHUB_STATUS: ([A-Z][A-Z0-9_]*)\]$/;
  const STATUS_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

  function normalizeLineEndings(value) {
    return String(value || '').replace(/\r\n?/g, '\n');
  }

  function isStatusCode(value) {
    return STATUS_CODE_PATTERN.test(String(value || ''));
  }

  function parseTerminalStatus(value) {
    const text = normalizeLineEndings(value);
    const lines = text.split('\n');
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

    if (lines.length === 0) {
      return { statusCode: '', statusLine: '', body: '' };
    }

    const statusLine = lines[lines.length - 1].trim();
    const match = statusLine.match(STATUS_LINE_PATTERN);
    if (!match) {
      return { statusCode: '', statusLine: '', body: text.trim() };
    }

    const bodyLines = lines.slice(0, -1);
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();

    return {
      statusCode: match[1],
      statusLine,
      body: bodyLines.join('\n').trim()
    };
  }

  globalThis.ChatGPTNotifierStatusCode = Object.freeze({
    isStatusCode,
    parseTerminalStatus
  });
})();
