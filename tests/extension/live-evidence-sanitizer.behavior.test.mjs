import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../tools/Add-NotifierSafeEvidence.ps1', import.meta.url), 'utf8');

test('safe evidence preserves terminal status without admitting response content', () => {
  assert.match(source, /'statusCode'/);
  assert.match(source, /\(\?:\^\|;\)status=\(\[A-Z\]\[A-Z0-9_\]\*\)\(\?:;\|\$\)/);
  assert.match(source, /stopReason=status:/);
  assert.match(source, /\$safe\['statusCode'\] = \$match\.Groups\[1\]\.Value/);

  const safeCopyStart = source.indexOf('function Copy-SafeDiagnostic');
  const safeCopyEnd = source.indexOf('function Copy-SafeIncidentTransition', safeCopyStart);
  assert.ok(safeCopyStart >= 0 && safeCopyEnd > safeCopyStart);
  const safeCopy = source.slice(safeCopyStart, safeCopyEnd);
  for (const forbidden of ['responseText', 'responseBody', 'promptText', 'conversationUrl', 'sessionTitle', 'commandLine']) {
    assert.equal(safeCopy.includes(`'${forbidden}'`), false, `safe diagnostic copier must not admit ${forbidden}`);
  }
});
