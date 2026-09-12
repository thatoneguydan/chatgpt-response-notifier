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

  // This list is checked against the generated grammar fixture bundled with
  // the extension. The canonical meanings remain in DevelopmentInfrastructure.
  const CONTRACT_ID = 'github-work-status/v1';
  const CONTRACT_SEMANTIC_SHA256 = 'a3174936b76fb05bd9c6bfb78754fb7fa0dfc14d1320ca5e8e952eb44ee36fe2';
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
  const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;

  function normalizeLineEndings(value) {
    return String(value || '').replace(/\r\n?/g, '\n');
  }

  function isStatusCode(value) {
    return VALID_STATUS_CODE_SET.has(String(value || ''));
  }

  function outsideFenceFlags(lines) {
    let fence = '';
    return lines.map((line) => {
      const marker = String(line || '').match(FENCE_PATTERN)?.[1] || '';
      if (marker) {
        const family = marker[0];
        if (!fence) fence = family;
        else if (fence === family) fence = '';
        return false;
      }
      return !fence;
    });
  }

  function parseTerminalStatus(value) {
    const text = normalizeLineEndings(value);
    const lines = text.split('\n');
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

    if (lines.length === 0) {
      return { statusCode: '', statusLine: '', body: '' };
    }

    const outsideFence = outsideFenceFlags(lines);
    const finalIndex = lines.length - 1;
    const statusLine = lines[finalIndex];
    const match = outsideFence[finalIndex] ? statusLine.match(STATUS_LINE_PATTERN) : null;
    if (!match || !isStatusCode(match[1])) {
      return { statusCode: '', statusLine: '', body: text.trim() };
    }

    let validOutsideStatusCount = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (!outsideFence[index]) continue;
      const candidate = lines[index].match(STATUS_LINE_PATTERN);
      if (candidate && isStatusCode(candidate[1])) validOutsideStatusCount += 1;
    }
    if (validOutsideStatusCount !== 1) {
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
    contractId: CONTRACT_ID,
    contractSemanticSha256: CONTRACT_SEMANTIC_SHA256,
    validStatusCodes: VALID_STATUS_CODES,
    isStatusCode,
    parseTerminalStatus
  });
})();
