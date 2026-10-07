import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const observer = readFileSync(new URL('extension/terminal-status-live-observer.js', root), 'utf8');
const conversation = readFileSync(new URL('standalone-quick-continue/conversation-state.js', root), 'utf8');
const background = readFileSync(new URL('standalone-quick-continue/background.js', root), 'utf8');

test('rendered definitive status has an explicit notifier-to-Simple terminal route', () => {
  assert.match(observer, /TERMINAL_BRIDGE_MARKER = 'chatgpt-notifier-terminal-status-v1'/);
  assert.match(observer, /terminalStatusClass/);
  assert.match(observer, /window\.postMessage\(\{ marker: TERMINAL_BRIDGE_MARKER, terminal \}/);
  assert.match(conversation, /handleNotifierTerminalMessage/);
  assert.match(conversation, /applyTerminalSignal/);
  assert.match(conversation, /SIMPLE_STATUS_MESSAGE/);
  assert.match(background, /statusClass === 'stop'/);
  assert.match(background, /return clearSimpleState\(tabId, \{ reason: 'status-stop'/);
});
