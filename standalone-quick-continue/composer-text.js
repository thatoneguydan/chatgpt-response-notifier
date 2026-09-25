'use strict';

(() => {
  const VERSION = 2;
  if (globalThis.ChatGPTQuickContinueComposer?.version === VERSION) return;

  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET',
    'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5',
    'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
    'TABLE', 'UL'
  ]);

  const normalize = (value) => String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');

  function tagName(node) {
    return String(node?.tagName || '').toUpperCase();
  }

  function isTextNode(node) {
    return Number(node?.nodeType) === 3;
  }

  function isElementNode(node) {
    return Number(node?.nodeType) === 1 || Boolean(node?.tagName);
  }

  function isBlock(node) {
    return isElementNode(node) && BLOCK_TAGS.has(tagName(node));
  }

  function childNodes(node) {
    try { return Array.from(node?.childNodes || []); } catch { return []; }
  }

  function descendantText(node) {
    if (!node) return '';
    if (isTextNode(node)) return String(node.nodeValue ?? node.textContent ?? '');
    if (tagName(node) === 'BR') return '\n';

    const children = childNodes(node);
    if (!children.length) return String(node.textContent ?? '');
    return children.map(descendantText).join('');
  }

  function isEmptyPlaceholderBlock(node, text) {
    if (!isBlock(node)) return false;
    if (normalize(node?.textContent ?? '').length) return false;
    if (!text) return true;
    return /^\n+$/.test(text);
  }

  function readEditable(node) {
    const children = childNodes(node);
    if (!children.length) return normalize(node?.textContent ?? node?.innerText ?? '');

    let output = '';
    let previousWasBlock = false;
    for (const child of children) {
      const childIsBlock = isBlock(child);
      let text = descendantText(child);
      if (isEmptyPlaceholderBlock(child, text)) text = '';

      if (childIsBlock && output && !output.endsWith('\n')) output += '\n';
      else if (childIsBlock && previousWasBlock && !output.endsWith('\n')) output += '\n';

      output += text;
      previousWasBlock = childIsBlock;
    }

    // Sibling block elements are logical paragraphs. Chromium's innerText can
    // serialize those same paragraphs with extra separator newlines, so read
    // them structurally instead of trusting presentation-oriented innerText.
    if (children.some(isBlock)) {
      let structured = '';
      let firstBlock = true;
      for (const child of children) {
        const childIsBlock = isBlock(child);
        let text = descendantText(child);
        if (isEmptyPlaceholderBlock(child, text)) text = '';

        if (childIsBlock) {
          if (!firstBlock) structured += '\n';
          structured += text;
          firstBlock = false;
        } else {
          structured += text;
        }
      }
      output = structured;
    }

    return normalize(output);
  }

  function read(node) {
    if (!node) return '';
    try {
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
        return normalize(node.value);
      }
      if (node.isContentEditable) return readEditable(node);
      return normalize(node.textContent ?? node.innerText ?? '');
    } catch { return ''; }
  }

  function replace(node, text) {
    if (!node) return false;
    const value = normalize(text);
    try {
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
        const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(node, value);
        else node.value = value;
        try {
          node.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: value ? 'insertText' : 'deleteContentBackward',
            data: value || null
          }));
        } catch { node.dispatchEvent(new Event('input', { bubbles: true })); }
      } else if (node.isContentEditable) {
        // Use a real browser editing transaction so Lexical receives the same
        // mutation path as user editing. execCommand's boolean return is not a
        // reliable success signal in Chromium; the editor contents below are.
        try { node.focus({ preventScroll: true }); } catch { node.focus(); }
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('insertText', false, value);
      } else return false;

      // Keep this exact. The structural reader converts editor paragraph DOM to
      // logical newlines but never collapses real blank lines or other spacing.
      return read(node) === value;
    } catch { return false; }
  }

  globalThis.ChatGPTQuickContinueComposer = Object.freeze({ version: VERSION, normalize, read, replace });
})();
