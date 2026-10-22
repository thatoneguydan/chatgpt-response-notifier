import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { digest, documented, fingerprint, legacyFingerprint, documentationOnly, trusted, select, validCheckout } from './validation-reuse.mjs';

const repository = 'thatoneguydan/example';
const entry = (path, c = 'a') => ({ path, mode: '100644', sha: c.repeat(40) });
const tree = [entry('src/style.css'), entry('package-lock.json'), entry('.github/workflows/test.yml'), entry('HANDOFF.md')];
const profile = { workflow: 'test.yml', job: 'source', steps: ['Model tests', 'Browser tests'], documentation: ['HANDOFF.md', 'docs/handoff/**'], artifacts: ['frames'] };
const input = fingerprint(tree, profile);
const receipt = 'Executed source proof fixture ' + digest({ input, observed: 'environment-A' });
const now = Date.parse('2026-10-21T20:00:00Z');
const run = (id = 11) => ({ id, repository: { full_name: repository }, head_repository: { full_name: repository },
  actor: { login: 'thatoneguydan' }, head_sha: '1'.repeat(40), event: 'pull_request', status: 'completed', run_attempt: 1 });
const job = () => ({ id: 101, name: 'source', status: 'completed', conclusion: 'success', completed_at: '2026-10-21T19:00:00Z',
  steps: ['Model tests', 'Browser tests', receipt].map(name => ({ name, conclusion: 'success' })) });
const options = overrides => ({ repository, canonicalRef: 'main', profile, input, receipt, now, currentRun: 99,
  runs: [run()], treeAt: async () => tree, jobsAt: async () => [job()],
  artifactsAt: async () => [{ name: 'frames', expired: false }], ...overrides });

test('recorded PR merge checkout is valid even when payload merge metadata is null or stale', () => {
  const merge = '2'.repeat(40), head = '3'.repeat(40);
  for (const metadata of [null, '4'.repeat(40)]) {
    assert.equal(validCheckout(merge, { pull_request: { head: { sha: head }, merge_commit_sha: metadata } }, merge), true);
  }
});
test('explicit PR head and canonical push checkouts retain exact event identity', () => {
  assert.equal(validCheckout('3'.repeat(40), { pull_request: { head: { sha: '3'.repeat(40) } } }, '2'.repeat(40)), true);
  assert.equal(validCheckout('2'.repeat(40), {}, '2'.repeat(40)), true);
});
test('unrelated checkout or malformed recorded identity refuses', () => {
  assert.equal(validCheckout('4'.repeat(40), { pull_request: { head: { sha: '3'.repeat(40) }, merge_commit_sha: '4'.repeat(40) } }, '2'.repeat(40)), false);
  assert.equal(validCheckout('bad', {}, 'bad'), false);
});

test('accepted candidate proof is reused after a merge with identical complete inputs', async () => {
  const r = await select(options()); assert.equal(r.execute, false); assert.equal(r.job, 101); assert.equal(r.attempt, 1);
});
test('continuation keeps the accepted execution identity without retriggering it', async () => {
  const a = await select(options()); const b = await select(options({ currentRun: 100 }));
  assert.deepEqual(a, b);
});
test('documentation has no application proof requirement only for explicitly declared paths', () => {
  assert.equal(documentationOnly(['HANDOFF.md', 'docs/handoff/CURRENT.md'], profile), true);
  for (const path of ['docs/installer-contract.md', 'README.md', '<unknown-base>', 'src/style.css']) {
    assert.equal(documentationOnly([path], profile), false);
  }
  assert.equal(documentationOnly([], profile), false);
});
test('a UI edit invalidates full affected browser evidence', () => {
  assert.notEqual(input, fingerprint([entry('src/style.css', 'b'), ...tree.slice(1)], profile));
});
test('dependency, recipe, schema and unknown files invalidate source proof', () => {
  for (const path of ['package-lock.json', '.github/workflows/test.yml', 'schema.json', 'unknown-config']) {
    assert.notEqual(input, fingerprint([...tree.filter(e => e.path !== path), entry(path, 'b')], profile));
  }
});
test('declared documentation does not invalidate unchanged runtime proof', () => {
  assert.equal(input, fingerprint([...tree.filter(e => e.path !== 'HANDOFF.md'), entry('HANDOFF.md', 'b')], profile));
});
test('ordering is stable; empty or malformed committed input is rejected', () => {
  assert.equal(input, fingerprint([...tree].reverse(), profile));
  assert.throws(() => fingerprint([], profile)); assert.throws(() => fingerprint([{ path: 'bad' }], profile));
  assert.equal(documented('docs/handoff-other/x', profile.documentation), false);
});
test('changed selector fixtures do not invalidate unchanged application proof', () => {
  assert.equal(fingerprint([...tree, entry('.github/scripts/validation-reuse.mjs')], profile),
    fingerprint([...tree, entry('.github/scripts/validation-reuse.mjs', 'b')], profile));
  assert.notEqual(input, fingerprint(tree, { ...profile, steps: ['Different proof'] }));
});
test('the previous receipt format is reusable only through matching full inputs, environment and executed steps', async () => {
  const previous = 'Executed source proof fixture ' + digest({ input: legacyFingerprint(tree, profile), observed: 'same' });
  const old = job();old.steps[2].name = previous;
  const r = await select(options({ jobsAt: async () => [old], legacyReceiptFor: () => previous }));
  assert.equal(r.execute, false);
  const changed = await select(options({ input: 'different-inputs', jobsAt: async () => [old], legacyReceiptFor: () => previous }));
  assert.equal(changed.execute, true);
  old.steps[1].conclusion = 'skipped';
  assert.equal((await select(options({ jobsAt: async () => [old], legacyReceiptFor: () => previous }))).execute, true);
});
for (const state of ['queued', 'in_progress']) test(`a ${state} latest matching attempt executes`, async () => {
  assert.equal((await select(options({ runs: [{ ...run(), status: state }] }))).execute, true);
});
for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out', null]) test(`${conclusion} job cannot reuse an older green result`, async () => {
  assert.equal((await select(options({ runs: [run(12), run(11)], jobsAt: async () => [{ ...job(), conclusion }] }))).execute, true);
});
test('a green reuse job is followed back to a real executed proof', async () => {
  const skipped = { ...job(), steps: job().steps.filter(s => s.name !== receipt) };
  const r = await select(options({ runs: [run(12), run(11)], jobsAt: async r => [r.id === 12 ? skipped : job()] }));
  assert.equal(r.run, 11);
});
test('green skips alone cannot manufacture executed proof', async () => {
  assert.equal((await select(options({ jobsAt: async () => [{ ...job(), steps: [] }] }))).execute, true);
});
test('partial checks cannot use a receipt marker', async () => {
  const j = job();j.steps[1].conclusion = 'skipped';
  assert.equal((await select(options({ jobsAt: async () => [j] }))).execute, true);
});
test('environment changes invalidate the execution receipt', async () => {
  assert.equal((await select(options({ receipt: receipt.replace(/.$/, 'f') + 'different-environment' }))).execute, true);
});
for (const artifacts of [[], [{ name: 'frames', expired: true }]]) test('missing or expired original visual evidence executes', async () => {
  assert.equal((await select(options({ artifactsAt: async () => artifacts }))).execute, true);
});
test('proof expires after seven days', async () => {
  assert.equal((await select(options({ now: now + 8 * 86400000 }))).execute, true);
});
test('wrong provider, actor, fork and unsupported trigger cannot donate evidence', async () => {
  for (const patch of [{ repository: { full_name: 'attacker/other' } }, { actor: { login: 'attacker' } },
    { head_repository: { full_name: 'attacker/fork' } }, { event: 'workflow_dispatch' },
    { triggering_actor: { login: 'attacker' } }, { head_sha: 'bad' }]) {
    const r = { ...run(), ...patch }; assert.equal(trusted(r, repository, 'main'), false);
    assert.equal((await select(options({ runs: [r] }))).execute, true);
  }
});
test('canonical branch is repository-specific', () => {
  const r = { ...run(), event: 'push', head_branch: 'custom-player' };
  assert.equal(trusted(r, repository, 'main'), false); assert.equal(trusted(r, repository, 'custom-player'), true);
});
test('inaccessible job evidence refuses instead of claiming success', async () => {
  await assert.rejects(select(options({ jobsAt: async () => { throw Error('API unavailable'); } })));
});
test('inaccessible historical input cannot authorize a skip', async () => {
  assert.equal((await select(options({ treeAt: async () => { throw Error('missing'); } }))).execute, true);
});
test('current in-flight operation is never reused as its own evidence', async () => {
  assert.equal((await select(options({ currentRun: 11 }))).execute, true);
});

test('renaming runtime source into documentation still requires affected checks', () => {
  assert.equal(documentationOnly(['src/style.css', 'HANDOFF.md'], profile), false);
});

test('installed profile wiring and shared implementation pin match current source', () => {
  if (!existsSync('.github/validation-profiles.json')) return;
  const config = JSON.parse(readFileSync('.github/validation-profiles.json', 'utf8'));
  assert.equal(config.schemaVersion, 1);
  const source = readFileSync(new URL('./validation-reuse.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  assert.equal(config.implementation.sha256, createHash('sha256').update(source).digest('hex'));
  for (const [id, p] of Object.entries(config.profiles)) {
    const workflow = readFileSync('.github/workflows/' + p.workflow, 'utf8');
    assert.ok(p.steps.length > 0, id);
    assert.ok(workflow.includes('node .github/scripts/validation-reuse.mjs ' + id), id);
    assert.ok(workflow.includes('steps.validation_plan.outputs.execute'), id);
    assert.ok(workflow.includes('steps.validation_plan.outputs.receipt'), id);
    for (const step of p.steps) assert.ok(workflow.includes(step), `${id}: missing ${step}`);
  }
});
