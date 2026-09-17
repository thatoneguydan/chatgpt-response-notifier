import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readText = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

function chromeWindowsPathId(value) {
  let normalized = String(value);
  if (/^[a-z]:/.test(normalized)) normalized = normalized[0].toUpperCase() + normalized.slice(1);
  const hash = createHash('sha256').update(Buffer.from(normalized, 'utf16le')).digest();
  const alphabet = 'abcdefghijklmnop';
  let result = '';
  for (let index = 0; index < 16; index += 1) {
    result += alphabet[hash[index] >> 4];
    result += alphabet[hash[index] & 0x0f];
  }
  return result;
}

test('Chromium Windows unpacked path identity fixture remains stable', () => {
  assert.equal(chromeWindowsPathId('C:\\test\\Extension'), 'cahfmfkmccngkbfgkogjdaoeaghkkfaa');
  assert.equal(chromeWindowsPathId('c:\\test\\Extension'), 'cahfmfkmccngkbfgkogjdaoeaghkkfaa');
  assert.notEqual(chromeWindowsPathId('C:\\test\\extension'), chromeWindowsPathId('C:\\test\\Extension'));
});

test('unpacked path identity evidence stays read-only and path-sanitized', () => {
  const publisher = readText('src/ChatGPTResponseNotifier.Host/ChromeUnpackedPathIdentityEvidencePublisher.cs');
  const collector = readText('tools/Collect-ChromeUnpackedPathIdentity.ps1');
  const workflow = readText('.github/workflows/chrome-unpacked-path-identity.yml');

  assert.match(publisher, /chrome-unpacked-path-identity-readonly-helper-v1/);
  assert.match(publisher, /ExtensionIdFromWindowsPath/);
  assert.match(publisher, /Encoding\.Unicode\.GetBytes\(normalized\)/);
  assert.match(publisher, /char\.ToUpperInvariant\(normalized\[0\]\)/);
  assert.match(publisher, /KnownStaleLegacyExtensionId = "pbbmmjcakamllfpcglbhcpmbpegapgih"/);
  assert.match(publisher, /pathDerivedExtensionId = record\.PathDerivedExtensionId/);
  assert.match(publisher, /pathDerivedIdMatchesRegistration = record\.PathDerivedIdMatchesRegistration/);
  assert.doesNotMatch(publisher, /Registry\.SetValue|Process\.Start|chrome\.exe/i);

  assert.match(collector, /chrome-unpacked-path-identity-readonly-helper-v1/);
  assert.match(collector, /chrome-unpacked-path-identity-readonly-v1/);
  assert.match(collector, /helper-snapshot-unavailable/);
  assert.match(collector, /'pathDerivedExtensionId','pathDerivedIdMatchesRegistration'/);
  assert.doesNotMatch(collector, /Set-Content[^\n]*(?:Preferences|Secure Preferences)/i);

  assert.ok(workflow.includes("'C:\\Users\\dan'"));
  assert.match(workflow, /'AppData'/);
  assert.match(workflow, /'rawPath'/);
  assert.match(workflow, /'preferencePath'/);
  assert.match(workflow, /'profilePath'/);
  assert.match(workflow, /'extensionRoot'/);
  assert.match(workflow, /-ExecutionPolicy Bypass/);
});
