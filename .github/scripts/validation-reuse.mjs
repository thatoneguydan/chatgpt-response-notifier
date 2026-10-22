// Shared source-proof selection. Deployment and package delivery are never reused here.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sha = /^[a-f0-9]{40}$/;
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validCheckout(source, event, workflowSha) {
  return sha.test(source || '') && [workflowSha, event.pull_request?.head?.sha].some(s => sha.test(s || '') && s === source);
}
export function documented(path, patterns = []) {
  return patterns.some(p => p.endsWith('/**') ? path.startsWith(p.slice(0, -2)) : path === p);
}
export function fingerprint(entries, profile) {
  const machinery = new Set(['.github/scripts/validation-reuse.mjs', '.github/scripts/validation-reuse.test.mjs',
    '.github/validation-profiles.json', 'Shared/Validation/validation-reuse.mjs',
    'Shared/Validation/validation-reuse.test.mjs', 'Shared/Validation/projects.json']);
  const inputs = entries.filter(e => !documented(e.path, profile.documentation) && !machinery.has(e.path));
  if (!inputs.length || inputs.some(e => !sha.test(e.sha) || !e.path || !e.mode)) throw Error('Incomplete committed inputs');
  // The current selector/fixtures are always checked separately. The complete
  // effective profile and application/test/workflow bytes bind application proof.
  return digest({ inputs: inputs.map(e => `${e.mode} ${e.sha} ${e.path}`).sort(), profile });
}
export function legacyFingerprint(entries, profile) {
  return digest(entries.filter(e => !documented(e.path, profile.documentation))
    .map(e => `${e.mode} ${e.sha} ${e.path}`).sort());
}
export function documentationOnly(paths, profile) {
  return paths.length > 0 && paths.every(p => documented(p, profile.documentation));
}
export function trusted(run, repository, canonicalRef) {
  const owner = repository.split('/')[0];
  return run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
    run.actor?.login === owner && (!run.triggering_actor || run.triggering_actor.login === owner) &&
    sha.test(run.head_sha || '') && (run.event === 'pull_request' ||
      (run.event === 'push' && run.head_branch === canonicalRef));
}

// The first matching attempt decides refusal. A later green skip can only be
// traversed to a real execution; failed, pending or inaccessible checks cannot.
export async function select({ runs, profile, repository, canonicalRef, input, receipt,
  currentRun, treeAt, jobsAt, artifactsAt, legacyReceiptFor, now = Date.now() }) {
  for (const run of runs) {
    if (String(run.id) === String(currentRun) || !trusted(run, repository, canonicalRef)) continue;
    let prior, entries;
    try { entries = await treeAt(run.head_sha); prior = fingerprint(entries, profile); } catch { continue; }
    if (prior !== input) continue;
    if (run.status !== 'completed') return { execute: true, reason: 'Latest matching attempt is pending.' };
    const jobs = await jobsAt(run);
    const job = jobs.find(j => j.name === profile.job);
    if (!job || job.status !== 'completed' || job.conclusion !== 'success') {
      return { execute: true, reason: 'Latest matching source job failed, skipped or is missing.' };
    }
    const previousReceipt = legacyReceiptFor ? await legacyReceiptFor(entries, run, job) : null;
    const expected = [receipt, ...(previousReceipt ? [previousReceipt] : [])];
    if (!job.steps?.some(s => expected.includes(s.name) && s.conclusion === 'success')) continue;
    if (!profile.steps.every(name => job.steps.some(s => s.name === name && s.conclusion === 'success'))) {
      return { execute: true, reason: 'Receipt does not include all executed source checks.' };
    }
    const age = now - Date.parse(job.completed_at);
    if (!Number.isFinite(age) || age < 0 || age > 7 * 86400000) {
      return { execute: true, reason: 'Executed source proof is older than seven days or has no trustworthy date.' };
    }
    if (profile.artifacts?.length) {
      const artifacts = await artifactsAt(run);
      if (!profile.artifacts.every(name => artifacts.some(a => a.name === name && a.expired === false))) {
        return { execute: true, reason: 'Required original visual evidence is missing or expired.' };
      }
    }
    return { execute: false, reason: 'Complete inputs and observed environment match an executed source proof.',
      source: run.head_sha, run: run.id, attempt: run.run_attempt, job: job.id, url: job.html_url };
  }
  return { execute: true, reason: 'No observable executed proof with matching complete inputs and environment.' };
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
function localTree(ref) {
  if (!sha.test(ref)) throw Error('Expected exact committed source');
  return git('ls-tree', '-r', '-z', ref).split('\0').filter(Boolean).map(line => {
    const m = /^(\d+) (?:blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(line);
    if (!m) throw Error('Unknown committed tree entry');
    return { mode: m[1], sha: m[2], path: m[3] };
  });
}
const toolArgs = { pwsh: ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
  powershell: ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
  dotnet: ['--list-sdks'], python: ['--version'], 'python-packages': ['-m', 'pip', 'freeze', '--all'], java: ['-version'], git: ['--version'] };
function environment(tools) {
  const result = { node: process.version, platform: process.platform, arch: process.arch,
    runner: process.env.RUNNER_NAME, runnerOS: process.env.RUNNER_OS,
    account: process.env.USERNAME, os: process.env.OS };
  for (const name of tools) {
    if (!toolArgs[name]) throw Error('Undeclared tool observation');
    const r = spawnSync(name === 'python-packages' ? 'python' : name, toolArgs[name], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const value = `${r.stdout || ''}${r.stderr || ''}`.trim();
    result[name] = r.status === 0 ? (name === 'python-packages' ? digest(value) : value) : '<unavailable>';
  }
  return result;
}

async function main() {
  const name = process.argv[2];
  const config = JSON.parse(readFileSync('.github/validation-profiles.json', 'utf8'));
  const profile = config.profiles[name];
  if (config.schemaVersion !== 1 || config.repository !== process.env.GITHUB_REPOSITORY || !profile) throw Error('Unknown repository/profile');
  const implementationHash = createHash('sha256').update(readFileSync(new URL(import.meta.url), 'utf8').replaceAll('\r\n', '\n')).digest('hex');
  if (config.implementation?.sha256 !== implementationHash) throw Error('Shared implementation pin does not match');
  if (!profile.steps?.length || !profile.workflow || !profile.job) throw Error('Incomplete source proof declaration');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const source = git('rev-parse', 'HEAD').trim();
  // GitHub records a synthetic PR merge in GITHUB_SHA; the payload's optional
  // merge_commit_sha can be stale/null while that synthetic merge is generated.
  if (!validCheckout(source, event, process.env.GITHUB_SHA)) throw Error('Unexpected checkout identity');
  const input = fingerprint(localTree(source), profile);
  const observed = environment(profile.tools || []);
  for (const path of profile.environmentFiles || []) {
    if (!/^(?:[\w.-]+\/)*node_modules\/\.package-lock\.json$/.test(path)) throw Error('Unsupported dependency inventory path');
    try { observed[path] = digest(JSON.parse(readFileSync(path, 'utf8'))); }
    catch { observed[path] = '<unavailable>'; }
  }
  const receipt = `Executed source proof ${name} ${digest({ input, observed })}`;
  const base = event.pull_request?.base?.sha || event.before;
  let paths = ['<unknown-base>'];
  if (sha.test(base || '') && !/^0+$/.test(base)) {
    try { paths = git('diff', '--no-renames', '--name-only', '-z', base, source).split('\0').filter(Boolean); } catch { /* Resolve bounded exact comparison below. */ }
  }
  const api = async path => {
    const response = await fetch(`https://api.github.com/repos/${config.repository}/${path}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GH_TOKEN}` },
      signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error(`Evidence unavailable (${response.status})`);
    return response.json();
  };
  if (paths[0] === '<unknown-base>' && sha.test(base || '') && !/^0+$/.test(base)) try {
    const diff = await api(`compare/${base}...${source}`);
    if (Array.isArray(diff.files) && diff.files.length < 300) paths = diff.files.flatMap(f => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]);
  } catch { /* Missing exact comparison is never documentation-only. */ }
  const docsOnly = documentationOnly(paths, profile);
  let accepted = { execute: true, reason: 'Source proof has not been inspected.' };
  if (docsOnly) accepted = { execute: false, reason: 'Only explicitly declared non-runtime documentation changed.' };
  else if (profile.deliversPackage) accepted.reason = 'Exact-source package production remains current; source reuse never substitutes package delivery.';
  else if (Object.values(observed).includes('<unavailable>')) accepted.reason = 'Required tool environment is unobservable; execute affected checks.';
  else if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') try {
    const all = await api(`actions/workflows/${profile.workflow}/runs?per_page=30`);
    accepted = await select({ runs: all.workflow_runs, profile, repository: config.repository,
      canonicalRef: config.canonicalRef, input, receipt, currentRun: process.env.GITHUB_RUN_ID,
      legacyReceiptFor: async (entries, run, job) => {
        if (!job.steps?.some(s => s.name.startsWith(`Executed source proof ${name} `) && s.conclusion === 'success')) return null;
        const configEntry = entries.find(e => e.path === '.github/validation-profiles.json');
        if (!configEntry) return null;
        let old;
        try { old = JSON.parse(git('show', `${run.head_sha}:.github/validation-profiles.json`)); }
        catch { const blob = await api(`git/blobs/${configEntry.sha}`); old = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8')); }
        if (old.repository !== config.repository || old.schemaVersion !== 1 || !old.profiles?.[name]) return null;
        return `Executed source proof ${name} ${digest({ input: legacyFingerprint(entries, old.profiles[name]), observed })}`;
      },
      treeAt: async ref => { try { return localTree(ref); } catch {
        const data = await api(`git/trees/${ref}?recursive=1`);
        if (data.truncated) throw Error('Truncated evidence tree');
        return data.tree.filter(e => e.type === 'blob' || e.type === 'commit');
      } },
      jobsAt: async run => (await api(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`)).jobs,
      artifactsAt: async run => (await api(`actions/runs/${run.id}/artifacts?per_page=100`)).artifacts });
  } catch { accepted = { execute: true, reason: 'Source evidence is incomplete or inaccessible; execute affected checks.' }; }
  else accepted.reason = 'Explicit manual validation executes current checks.';
  for (const [key, value] of Object.entries({ execute: accepted.execute, receipt, documentation_only: docsOnly })) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  const plan = { schemaVersion: 2, profile: name, source, input, observed, accepted, documentationOnly: docsOnly,
    sourceBuildStepsPlanned: accepted.execute ? (profile.buildSteps || 0) : 0,
    alwaysCurrent: profile.alwaysCurrent || [],
    continuation: 'Inspect this run/attempt and referenced executed job before any retry. No package or live authority is reused.' };
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Affected source validation\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\nActual queue/job/step times remain in this Actions run.\n`);
  console.log(JSON.stringify(plan));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
