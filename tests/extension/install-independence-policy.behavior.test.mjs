import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const project = readFileSync(new URL('../../PROJECT.md', import.meta.url), 'utf8');

test('notifier and Quick Continue installs are never gated on human proof', () => {
  assert.match(project, /Permanent install-independence policy/);
  assert.match(project, /ChatGPT Response Notifier and ChatGPT Quick Continue are deployed independently/);
  assert.match(project, /Never hold either extension's requested install or update for human\/user testing, live proof, acceptance evidence, or unresolved acceptance work for either extension/);
  assert.match(project, /Human testing may inform follow-up debugging after installation, but it is not an installation prerequisite/);
});
