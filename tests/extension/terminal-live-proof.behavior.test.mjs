import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const proofSource = fs.readFileSync(new URL('../../extension/terminal-live-proof-background.js', import.meta.url), 'utf8');
const bootstrapSource = fs.readFileSync(new URL('../../extension/diagnostics-bootstrap.js', import.meta.url), 'utf8');

test('production worker loads bounded live terminal proof after terminal authority', () => {
  const authority = bootstrapSource.indexOf("importScripts('terminal-watchdog-authority-background.js')");
  const proof = bootstrapSource.indexOf("importScripts('terminal-live-proof-background.js')");
  assert.ok(authority >= 0, 'terminal authority import is missing');
  assert.ok(proof > authority, 'live proof must load after terminal authority');
});

test('live terminal proof observes real terminal messages and persisted watchdog state without response content', () => {
  assert.match(proofSource, /CHATGPT_RENDERED_TERMINAL_STATUS/);
  assert.match(proofSource, /CHATGPT_RESPONSE_STREAM_TERMINAL_STATUS/);
  assert.match(proofSource, /terminal-message-received/);
  assert.match(proofSource, /terminal-watchdog-stopped-observed/);
  assert.match(proofSource, /terminal-watchdog-not-stopped-observed/);
  assert.match(proofSource, /monitorOverview\(target\)/);
  assert.match(proofSource, /source:\s*'terminal-live-proof'/);
  assert.match(proofSource, /__chatgptNotifierBuildIdentity\?\.sourceCommit/);
  assert.match(proofSource, /buildCommitSuffix/);
  assert.match(proofSource, /reason:\s*`build=\$\{commitSuffix/);

  for (const forbidden of [
    'responseText:',
    'responseBody:',
    'promptText:',
    'conversationUrl:',
    'notificationPreview:',
    'sender?.tab?.title'
  ]) {
    assert.equal(proofSource.includes(forbidden), false, `live proof must not persist ${forbidden}`);
  }
});
