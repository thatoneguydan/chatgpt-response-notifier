'use strict';

(() => {
  const RUNTIME_VERSION = 4;
  const BLOCK_SELECTOR = 'p, div, section, article';
  const ROLE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"], [data-turn="user"], [data-turn="assistant"]';
  const EXCLUDED_SELECTOR = 'pre, code, blockquote, ul, ol, li, button, svg, [role="button"], [aria-hidden="true"], [hidden], [inert], [data-message-author-role="tool"], [data-tool]';

  function normalize(value) {
    return String(value || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\r\n?/g, '\n')
      .trim();
  }

  function exactStatusCode(value) {
    const text = normalize(value);
    const match = text.match(/^\[GITHUB_STATUS:\s*([A-Z][A-Z0-9_]*)\]$/);
    const code = String(match?.[1] || '');
    return globalThis.ChatGPTNotifierStatusCode?.isStatusCode?.(code) === true ? code : '';
  }

  function statusCodesFromLines(value) {
    const codes = [];
    for (const line of normalize(value).split('\n').map((entry) => entry.trim()).filter(Boolean)) {
      const code = exactStatusCode(line);
      if (code) codes.push(code);
    }
    return codes;
  }

  function isExcluded(node, root) {
    try {
      const excluded = node?.closest?.(EXCLUDED_SELECTOR);
      return Boolean(excluded && excluded !== root && root?.contains?.(excluded));
    } catch {
      return false;
    }
  }

  function safeElementText(node) {
    if (!node) return '';
    try {
      const clone = node.cloneNode(true);
      for (const excluded of clone.querySelectorAll?.(EXCLUDED_SELECTOR) || []) excluded.remove?.();
      return normalize(clone.textContent || '');
    } catch {
      return normalize(node?.textContent || '');
    }
  }

  function liveTerminalLine(root) {
    let text = '';
    try { text = normalize(root?.innerText || ''); } catch {}
    if (!text) return '';
    const lines = text.split('\n').map((entry) => entry.trim()).filter(Boolean);
    if (!lines.length) return '';
    const finalCode = exactStatusCode(lines[lines.length - 1]);
    if (!finalCode) return '';
    const codes = statusCodesFromLines(text);
    return new Set(codes).size === 1 ? finalCode : '';
  }

  function terminalLeafBlock(root) {
    const blocks = [];
    try { blocks.push(root, ...Array.from(root?.querySelectorAll?.(BLOCK_SELECTOR) || [])); } catch {}
    const leaves = [];
    for (const block of blocks) {
      if (!block || isExcluded(block, root)) continue;
      const text = safeElementText(block);
      if (!text) continue;
      let hasMeaningfulBlockChild = false;
      try {
        for (const child of block.querySelectorAll?.(BLOCK_SELECTOR) || []) {
          if (child === block || isExcluded(child, root)) continue;
          if (safeElementText(child)) {
            hasMeaningfulBlockChild = true;
            break;
          }
        }
      } catch {}
      if (!hasMeaningfulBlockChild) leaves.push({ block, text });
    }
    if (!leaves.length) return '';
    const codes = leaves.map((entry) => exactStatusCode(entry.text)).filter(Boolean);
    if (new Set(codes).size > 1) return '';
    return exactStatusCode(leaves[leaves.length - 1].text);
  }

  function terminalTextNode(root) {
    if (!root || typeof document?.createTreeWalker !== 'function' || typeof NodeFilter === 'undefined') return '';
    const chunks = [];
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const parent = node.parentElement || null;
        if (!isExcluded(parent, root)) {
          const text = normalize(node.nodeValue || '');
          if (text) chunks.push(text);
        }
        node = walker.nextNode();
      }
    } catch {
      return '';
    }
    if (!chunks.length) return '';
    const codes = chunks.map(exactStatusCode).filter(Boolean);
    if (new Set(codes).size > 1) return '';
    return exactStatusCode(chunks[chunks.length - 1]);
  }

  function assistantRoot(turn) {
    if (!turn) return null;
    try {
      const selector = '[data-message-author-role="assistant"], [data-turn="assistant"]';
      return turn.matches?.(selector) ? turn : (turn.querySelector?.(selector) || turn);
    } catch {
      return turn;
    }
  }

  function semanticRole(node) {
    try {
      const role = String(node?.getAttribute?.('data-message-author-role') || node?.getAttribute?.('data-turn') || '').toLowerCase();
      return role === 'user' || role === 'assistant' ? role : '';
    } catch {
      return '';
    }
  }

  function sameAssistantTurnRole(node, assistant) {
    if (!node || !assistant) return false;
    if (node === assistant) return true;
    try {
      return assistant.contains?.(node) === true || node.contains?.(assistant) === true;
    } catch {
      return false;
    }
  }

  function follows(reference, candidate) {
    if (!reference || !candidate || reference === candidate) return false;
    try {
      const position = reference.compareDocumentPosition(candidate);
      const following = typeof Node === 'function' ? Node.DOCUMENT_POSITION_FOLLOWING : 4;
      return Boolean(position & following);
    } catch {
      return false;
    }
  }

  function roleBoundary(root, assistant) {
    const result = {
      precedingUserCount: 0,
      followingUserCount: 0,
      foreignAssistantCount: 0,
      unsafe: false,
      reason: ''
    };
    try {
      const roles = Array.from(root?.querySelectorAll?.(ROLE_SELECTOR) || []);
      for (const node of roles) {
        if (sameAssistantTurnRole(node, assistant)) continue;
        const role = semanticRole(node);
        if (role === 'assistant') {
          result.foreignAssistantCount += 1;
          continue;
        }
        if (role !== 'user') continue;
        if (follows(assistant, node)) result.followingUserCount += 1;
        else result.precedingUserCount += 1;
      }
    } catch {}
    result.unsafe = result.foreignAssistantCount > 0 || result.followingUserCount > 0;
    if (result.foreignAssistantCount > 0) result.reason = 'foreign-assistant';
    else if (result.followingUserCount > 0) result.reason = 'following-user';
    return result;
  }

  function traverseDetectionRoots(turn) {
    const assistant = assistantRoot(turn);
    if (!assistant) {
      return {
        roots: [],
        shape: { rootCount: 0, precedingUserCount: 0, followingUserCount: 0, foreignAssistantCount: 0, boundaryReason: 'assistant-missing' }
      };
    }
    const roots = [];
    const add = (node) => {
      if (node && !roots.includes(node)) roots.push(node);
    };
    add(assistant);
    add(turn);

    let precedingUserCount = 0;
    let followingUserCount = 0;
    let foreignAssistantCount = 0;
    let boundaryReason = '';

    // Current ChatGPT can group the prompt and its assistant response under one
    // presentation wrapper while rendering footer/actions as siblings of the
    // semantic assistant marker. A preceding user role is therefore part of the
    // current response group, not a neighboring-turn boundary. A second assistant
    // or any user role following this assistant still closes the safe scan region.
    let current = turn?.parentElement || assistant?.parentElement || null;
    while (current) {
      const boundary = roleBoundary(current, assistant);
      precedingUserCount = Math.max(precedingUserCount, boundary.precedingUserCount);
      followingUserCount = Math.max(followingUserCount, boundary.followingUserCount);
      foreignAssistantCount = Math.max(foreignAssistantCount, boundary.foreignAssistantCount);
      if (boundary.unsafe) {
        boundaryReason = boundary.reason;
        break;
      }
      add(current);
      current = current.parentElement || null;
    }

    return {
      roots,
      shape: {
        rootCount: roots.length,
        precedingUserCount,
        followingUserCount,
        foreignAssistantCount,
        boundaryReason: boundaryReason || 'root-exhausted'
      }
    };
  }

  function detectionRoots(turn) {
    return traverseDetectionRoots(turn).roots;
  }

  function detect(turn) {
    const codes = [];
    for (const root of detectionRoots(turn)) {
      const code = liveTerminalLine(root) || terminalLeafBlock(root) || terminalTextNode(root) || '';
      if (code) codes.push(code);
    }
    const distinct = new Set(codes);
    return distinct.size === 1 ? String(codes[codes.length - 1] || '') : '';
  }

  function inspect(turn) {
    const traversal = traverseDetectionRoots(turn);
    return Object.freeze({ ...traversal.shape });
  }

  globalThis.ChatGPTNotifierRenderedTerminalStatus = Object.freeze({
    version: RUNTIME_VERSION,
    exactStatusCode,
    detect,
    inspect
  });
})();
