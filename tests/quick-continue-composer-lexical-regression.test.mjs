import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const repoRoot = path.resolve(import.meta.dirname, '..');
const composerSource = fs.readFileSync(path.join(repoRoot, 'standalone-quick-continue', 'composer-text.js'), 'utf8');

test('Lexical paragraph DOM verifies logical newlines even when execCommand reports false', () => {
  class Textarea {}
  class Input extends Textarea {}
  const textNode = (value) => ({ nodeType: 3, nodeValue: value, textContent: value });
  const brNode = () => ({ nodeType: 1, tagName: 'BR', childNodes: [], textContent: '' });
  const paragraph = (value) => ({
    nodeType: 1,
    tagName: 'P',
    childNodes: value === '' ? [brNode()] : [textNode(value)],
    textContent: value
  });

  class Editable {
    constructor() {
      this.isContentEditable = true;
      this.childNodes = [];
      this.textContent = '';
    }
    focus() {}
  }

  const element = new Editable();
  let distort = false;
  const context = {
    globalThis: null,
    HTMLTextAreaElement: Textarea,
    HTMLInputElement: Input,
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    document: {
      createRange: () => ({ selectNodeContents() {} }),
      execCommand(command, ui, value) {
        assert.equal(command, 'insertText');
        assert.equal(ui, false);
        const lines = value.split('\n');
        const rendered = distort
          ? lines.flatMap((line, index) => index === 0 ? [line, ''] : [line])
          : lines;
        element.childNodes = rendered.map(paragraph);
        element.textContent = rendered.join('');
        return false;
      }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(composerSource, context);
  const api = context.ChatGPTQuickContinueComposer;

  for (const expected of ['one\ntwo', 'one\n\ntwo', 'one\n', '\none']) {
    distort = false;
    assert.equal(api.replace(element, expected), true, `verified Lexical write: ${JSON.stringify(expected)}`);
    assert.equal(api.read(element), expected);
  }

  distort = true;
  assert.equal(api.replace(element, 'one\ntwo'), false, 'a real extra blank line still blocks send');
});
