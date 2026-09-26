import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('standalone-quick-continue/send-transaction.js', root), 'utf8');

test('shared send transaction prefers the live form submit path used by Enter', async () => {
  let currentText = '';
  let requestSubmits = 0;
  let clicks = 0;

  class Element {}
  const form = {
    querySelector: () => button,
    requestSubmit: (submitter) => {
      assert.equal(submitter, button);
      requestSubmits += 1;
    }
  };
  const button = {
    disabled: false,
    form,
    isConnected: true,
    getAttribute: () => null,
    closest: () => form,
    click: () => { clicks += 1; }
  };
  const composer = {
    isConnected: true,
    isContentEditable: true,
    disabled: false,
    getAttribute: () => null,
    closest: () => form
  };
  const composerApi = {
    normalize: (value) => String(value ?? '').replace(/\r\n?/g, '\n'),
    read: () => currentText,
    replace: (_node, value) => {
      currentText = String(value ?? '').replace(/\r\n?/g, '\n');
      return true;
    }
  };
  const context = {
    globalThis: null,
    Element,
    Promise,
    Number,
    String,
    Object,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => callback(),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    document: {
      visibilityState: 'visible',
      body: form,
      documentElement: form,
      querySelector: (selector) => selector.includes('prompt-textarea') ? composer : button
    },
    ChatGPTQuickContinueComposer: composerApi
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);

  const result = await context.ChatGPTQuickContinueSend.submit(composer, 'timestamped message');
  assert.equal(result.ok, true);
  assert.equal(result.activation, 'request-submit');
  assert.equal(requestSubmits, 1);
  assert.equal(clicks, 0, 'form-backed composers must not rely on HTMLElement.click()');
});
