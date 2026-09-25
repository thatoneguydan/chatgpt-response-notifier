import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const mainSource = readFileSync(new URL('extension/response-stream-status-main.js', root), 'utf8');
const recoverySource = readFileSync(new URL('extension/terminal-stop-post-update-recovery-background.js', root), 'utf8');
const bootstrapSource = readFileSync(new URL('extension/diagnostics-bootstrap.js', root), 'utf8');

async function settle() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test('a cloned response read error cannot erase an already-observed terminal footer', async () => {
  const posted = [];
  let readCount = 0;
  const response = {
    clone() {
      return {
        body: {
          getReader() {
            return {
              async read() {
                readCount += 1;
                if (readCount === 1) {
                  return {
                    done: false,
                    value: new TextEncoder().encode('data: {"text":"done\\n[GITHUB_STATUS: COMPLETE_APPLIED]"}\\n\\n')
                  };
                }
                throw new Error('clone stream aborted at EOF');
              },
              releaseLock() {}
            };
          }
        }
      };
    }
  };
  const window = {
    fetch: async () => response,
    postMessage(message, origin) { posted.push({ message, origin }); }
  };
  const context = vm.createContext({
    window,
    globalThis: window,
    location: { href: 'https://chatgpt.com/c/conversation-1', origin: 'https://chatgpt.com' },
    URL,
    TextDecoder,
    TextEncoder,
    Request: undefined,
    XMLHttpRequest: undefined,
    Symbol,
    Promise
  });

  vm.runInContext(mainSource, context);
  await window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST' });
  await settle();

  const kinds = posted.map((entry) => entry.message?.kind);
  assert.ok(kinds.includes('terminal-status'));
  assert.ok(kinds.includes('stream-read-error'));
  const terminal = posted.find((entry) => entry.message?.kind === 'terminal-status');
  assert.equal(terminal?.message?.statusCode, 'COMPLETE_APPLIED');
  assert.ok(kinds.indexOf('terminal-status') < kinds.indexOf('stream-read-error'));
});

test('service-worker update recovery refreshes current status parsing and terminal authority in open chats', () => {
  assert.match(bootstrapSource, /importScripts\('watchdog-authority-v3-background\.js'\)[\s\S]*importScripts\('terminal-stop-post-update-recovery-background\.js'\)/);
  assert.match(recoverySource, /'status-code\.js'/);
  assert.match(recoverySource, /'status-policy\.js'/);
  assert.match(recoverySource, /'status-script\.js'/);
  assert.match(recoverySource, /'watchdog-page-authority-v3\.js'/);
  assert.match(recoverySource, /CHATGPT_RESPONSE_STREAM_DIAGNOSTIC/);
  assert.match(recoverySource, /stream-read-error/);
  assert.match(recoverySource, /ensureExistingTabs\(\)/);
  assert.match(recoverySource, /REFRESH_DELAYS_MS = Object\.freeze\(\[0, 250, 1000, 3000\]\)/);
  assert.doesNotMatch(recoverySource, /\bfetch\s*\(|XMLHttpRequest|backend-api/);
  assert.doesNotThrow(() => new vm.Script(recoverySource));
});
