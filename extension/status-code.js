'use strict';

(() => {
  // Existing ChatGPT tabs can keep this isolated-world global across an
  // extension runtime reload even though the old runtime listener is gone.
  // v0.7.x's status layer set this guard but did not expose maybeAutoContinue,
  // which caused the newly installed v0.8.x status-script.js to return early
  // instead of attaching its auto-continue listener. Clear only that stale
  // pre-auto-continue guard; the service worker injects status-code.js before
  // status-script.js, so the current status layer can attach without reloading
  // or activating the tab.
  if (
    globalThis.__chatgptNotifierStatusDomInstalled &&
    typeof globalThis.__chatgptNotifierStatusDom?.maybeAutoContinue !== 'function'
  ) {
    globalThis.__chatgptNotifierStatusDomInstalled = false;
  }

  if (globalThis.ChatGPTNotifierStatusCode) return;

  // This list mirrors the canonical GitHub work-session status taxonomy in
  // DevelopmentInfrastructure/GITHUB-WORK-STATUS-POLICY.md. Unknown tokens do
  // not qualify for notifications; taxonomy changes require an intentional
  // notifier update so accidental status-looking text cannot become eligible.
  const VALID_STATUS_CODES = Object.freeze([
    'PLANNING_ACTIVE',
    'COMPLETE_APPLIED',
    'COMPLETE_NO_CHANGES',
    'BLOCKED_HUMAN',
    'INCOMPLETE_LIMIT',
    'INCOMPLETE_TOOL_FAILURE',
    'INCOMPLETE_HANDOFF'
  ]);
  const VALID_STATUS_CODE_SET = new Set(VALID_STATUS_CODES);
  const STATUS_LINE_PATTERN = /^\[GITHUB_STATUS: ([A-Z][A-Z0-9_]*)\]$/;

  function normalizeLineEndings(value) {
    return String(value || '').replace(/\r\n?/g, '\n');
  }

  function isStatusCode(value) {
    return VALID_STATUS_CODE_SET.has(String(value || ''));
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
    if (!match || !isStatusCode(match[1])) {
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
    validStatusCodes: VALID_STATUS_CODES,
    isStatusCode,
    parseTerminalStatus
  });
})();
