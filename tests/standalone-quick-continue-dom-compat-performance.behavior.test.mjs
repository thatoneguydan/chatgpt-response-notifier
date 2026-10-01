import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const repoRoot = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(repoRoot, 'standalone-quick-continue', 'dom-compat.js'), 'utf8');

test('Quick Continue DOM compatibility filters document-wide composer typing mutations', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /const RUNTIME_VERSION = 2;/);
  assert.match(source, /const nativeMutationObserver = globalThis\.MutationObserver;/);
  assert.match(source, /const composerMutationRoots = new WeakMap\(\);/);
  assert.match(source, /function composerForTypingMutation\(record\)/);
  assert.match(source, /const cached = composerMutationRoots\.get\(element\);\s+if \(cached\) \{/);
  assert.match(source, /if \(cached\.isConnected !== false\) return cached;/);
  assert.doesNotMatch(source, /cached\?\.isConnected !== false/);
  assert.match(source, /function shouldFilterComposerTyping\(target, options\)/);
  assert.match(source, /class QuickContinueFilteredMutationObserver/);
  assert.match(source, /Array\.from\(records \|\| \[\]\)\.filter\(\(record\) => !composerForTypingMutation\(record\)\)/);
  assert.match(source, /globalThis\.MutationObserver = QuickContinueFilteredMutationObserver;/);
  assert.match(source, /if \(globalThis\.MutationObserver === QuickContinueFilteredMutationObserver\) globalThis\.MutationObserver = nativeMutationObserver;/);
});

test('Quick Continue mutation filter is scoped to broad structural observers and leaves focused waiters intact', () => {
  assert.match(source, /\(target === root \|\| target === body\)/);
  assert.match(source, /options\?\.childList === true/);
  assert.match(source, /options\?\.subtree === true/);
  assert.match(source, /options\?\.attributes !== true/);
  assert.match(source, /options\?\.characterData !== true/);
  assert.match(source, /this\.filterComposerTyping = shouldFilterComposerTyping\(target, options\);/);
});