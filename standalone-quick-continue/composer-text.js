'use strict';

(() => {
  const VERSION = 1;
  if (globalThis.ChatGPTQuickContinueComposer?.version === VERSION) return;

  const normalize = (value) => String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');

  function read(node) {
    if (!node) return '';
    try {
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
        return normalize(node.value);
      }
      return normalize(node.innerText ?? node.textContent ?? '');
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
        // Let the browser's editing transaction notify Lexical. Directly
        // replacing children and then dispatching a synthetic input event can
        // leave its editor model out of sync and duplicate paragraph breaks.
        try { node.focus({ preventScroll: true }); } catch { node.focus(); }
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
        if (document.execCommand('insertText', false, value) !== true) return false;
      } else return false;
      // Never approve a send by collapsing whitespace: line breaks and blank
      // lines must match the requested prompt exactly.
      return read(node) === value;
    } catch { return false; }
  }

  globalThis.ChatGPTQuickContinueComposer = Object.freeze({ version: VERSION, normalize, read, replace });
})();
