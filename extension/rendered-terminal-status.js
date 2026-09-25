'use strict';

(() => {
  const RUNTIME_VERSION = 1;
  const BLOCK_SELECTOR = 'p, div, section, article';
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

  function detect(turn) {
    const root = assistantRoot(turn);
    if (!root) return '';
    return liveTerminalLine(root) || terminalLeafBlock(root) || terminalTextNode(root) || '';
  }

  globalThis.ChatGPTNotifierRenderedTerminalStatus = Object.freeze({
    version: RUNTIME_VERSION,
    exactStatusCode,
    detect
  });
})();
