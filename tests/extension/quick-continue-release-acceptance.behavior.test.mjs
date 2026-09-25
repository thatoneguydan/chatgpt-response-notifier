import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const workflowSource = fs.readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'quick-continue-release.yml'),
  'utf8'
);

test('Quick Continue release waits for the public raw feed before asking Glass to update', () => {
  const rawFeed = 'https://raw.githubusercontent.com/thatoneguydan/chatgpt-response-notifier/main/standalone-quick-continue/update/manifest.json';
  const rawFeedIndex = workflowSource.indexOf(rawFeed);
  const helperEndpointIndex = workflowSource.indexOf('http://127.0.0.1:38473/quick-continue/update');

  assert.ok(rawFeedIndex >= 0, 'release acceptance must probe the same public feed consumed by the helper');
  assert.ok(helperEndpointIndex > rawFeedIndex, 'public-feed propagation must be verified before the helper update request');
  assert.match(workflowSource, /\$publicFeedVisible = \$false/);
  assert.match(workflowSource, /for \(\$attempt = 1; \$attempt -le 24; \$attempt \+= 1\)/);
  assert.match(workflowSource, /cacheBust=\$cacheBust/);
  assert.match(workflowSource, /'Cache-Control' = 'no-cache'/);
  assert.match(workflowSource, /if \(\$lastPublicVersion -eq \$expectedVersion\)/);
  assert.match(workflowSource, /if \(-not \$publicFeedVisible\) \{/);
  assert.match(workflowSource, /did not propagate to the public raw feed/);
});
