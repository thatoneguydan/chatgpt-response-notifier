import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const worker = readFileSync(new URL('../../extension/service-worker.js', import.meta.url), 'utf8');

function loadVersionSync(currentVersion) {
  const start = worker.indexOf('function parseVersion(value)');
  const end = worker.indexOf('function conversationFromUrl(rawUrl)', start);
  assert.ok(start >= 0 && end > start, 'version-sync functions were not found in service-worker.js');

  const timers = [];
  let reloads = 0;
  const context = vm.createContext({
    chrome: {
      runtime: {
        getManifest: () => ({ version: currentVersion }),
        reload: () => { reloads += 1; }
      }
    },
    setTimeout: (fn, delay) => {
      timers.push({ fn, delay });
      return timers.length;
    }
  });
  vm.runInContext(worker.slice(start, end), context);
  return {
    maybeReload: context.maybeReloadForInstalledVersion,
    timers,
    reloads: () => reloads
  };
}

test('installed extension version mismatch self-activates both upgrades and rollbacks', () => {
  for (const installedVersion of ['1.0.0', '0.9.7']) {
    const runtime = loadVersionSync('0.9.9');
    assert.equal(runtime.maybeReload(installedVersion), true);
    assert.equal(runtime.timers.length, 1);
    assert.equal(runtime.timers[0].delay, 250);
    assert.equal(runtime.reloads(), 0);
    runtime.timers[0].fn();
    assert.equal(runtime.reloads(), 1);
  }
});

test('same or invalid installed version does not reload the extension runtime', () => {
  for (const installedVersion of ['0.9.9', 'invalid']) {
    const runtime = loadVersionSync('0.9.9');
    assert.equal(runtime.maybeReload(installedVersion), false);
    assert.equal(runtime.timers.length, 0);
    assert.equal(runtime.reloads(), 0);
  }
});
