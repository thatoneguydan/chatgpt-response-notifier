import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const text = (relative) => readFileSync(new URL(relative, root), 'utf8');

const quickContinueBackground = text('standalone-quick-continue/background.js');
const legacyQuickPromptsAttachment = text('extension/quick-prompts-attachment-background.js');

test('MV3 service-worker cold starts never rebuild the canonical Quick Continue page runtime', () => {
  const reinjectionCalls = Array.from(
    quickContinueBackground.matchAll(/injectCurrentRuntimeIntoOpenTabs\(\)\.catch\(\(\) => \{\}\);/g)
  );

  assert.equal(
    reinjectionCalls.length,
    1,
    'runtime reinjection must exist only for the real install/update lifecycle'
  );

  const startupBlock = quickContinueBackground.match(
    /chrome\.runtime\.onStartup\.addListener\(\(\) => \{([\s\S]*?)\n\}\);/
  )?.[1] || '';
  assert.ok(startupBlock, 'startup lifecycle block must remain explicit');
  assert.doesNotMatch(startupBlock, /injectCurrentRuntimeIntoOpenTabs/);

  const installedBlock = quickContinueBackground.match(
    /chrome\.runtime\.onInstalled\.addListener\(\(\) => \{([\s\S]*?)\n\}\);/
  )?.[1] || '';
  assert.match(installedBlock, /injectCurrentRuntimeIntoOpenTabs\(\)/);

  const coldStartTail = quickContinueBackground.slice(
    quickContinueBackground.lastIndexOf('// MV3 service workers')
  );
  assert.ok(coldStartTail.length > 0, 'cold-start policy comment must be present');
  assert.doesNotMatch(coldStartTail, /injectCurrentRuntimeIntoOpenTabs/);
  assert.match(coldStartTail, /ensureUpdateAlarm\(\);/);
  assert.match(coldStartTail, /checkManagedUpdate\(\)\.catch/);
});

test('retired notifier Quick Prompts cannot execute a competing toolbar injection path', () => {
  assert.match(legacyQuickPromptsAttachment, /superseded by the standalone/);
  assert.doesNotMatch(legacyQuickPromptsAttachment, /chrome\.scripting\.executeScript/);
  assert.doesNotMatch(legacyQuickPromptsAttachment, /chrome\.tabs\.query/);

  const context = vm.createContext({});
  context.globalThis = context;
  assert.doesNotThrow(() => vm.runInContext(legacyQuickPromptsAttachment, context));
  assert.equal(context.__chatgptNotifierQuickPromptAttachmentInstalled, true);
});
