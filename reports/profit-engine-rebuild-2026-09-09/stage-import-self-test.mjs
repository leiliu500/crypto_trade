/** In-memory filesystem audit. No application imports, mounts or account I/O.
 * node --experimental-vm-modules stage-import-self-test.mjs NEW_REPORT
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

const source = await readFile(new URL('./stage-import.mjs', import.meta.url), 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clock = Date.parse('2026-09-09T23:30:00.000Z');
const sourceSha = 'c57475ab04ce281cbd83f86f95f0099d56d24ef5edcee758e293be197f8d036b';
const policy = '827a3c64f88eb32848104dc94f37b416f185a057441576e12cc16a4144ba7c02';
const json = value => Buffer.from(JSON.stringify(value));
const contextValue = { mode: 'paper', paperTrial: true, efficientTraining: true,
  regimeModel: false, paperFile: '/app/data/paper.json', stateFile: '/app/data/bank.json',
  historyFile: '/app/data/history.json', trainingFile: null };
const artifactBytes = json({ syntheticArtifact: true });
const artifactSha = sha(artifactBytes);
const target = `/app/data/distributional-training-risk-v2-20260909T201636-${artifactSha.slice(0, 16)}.json`;
const cases = [];
async function scenario(name, options = {}) {
  const files = new Map(), modes = new Map(), writes = [];
  const fixtureContext = { ...contextValue, ...options.context };
  const contextBytes = json(fixtureContext);
  const audit = { artifactSha256: artifactSha, artifactBytes: artifactBytes.length, sourceCodeSha256: sourceSha,
    fullFrozenSourceVerified: true, inputFiles: 34, isolatedImport: { repeatedAddedSamples: 0 }, ...options.audit };
  const preflight = { verifiedAtUtc: new Date(clock - 10_000).toISOString(), artifact: { sha256: artifactSha },
    sourceCodeSha256: sourceSha, repeatedImportAddedSamples: 0, import: { addedSamples: 1 },
    sizingPolicyId: policy, runtimeContextSha256: sha(contextBytes), ...options.preflight };
  files.set('/inputs/artifact.json', artifactBytes);
  files.set('/inputs/audit.json', json(audit)); files.set('/inputs/preflight.json', json(preflight));
  files.set('/inputs/context.json', contextBytes);
  files.set('/app/data/paper.json', json({ schemaVersion: 4, initialEquity: 100000,
    cashEquity: 99987.5, funding: { state: { syntheticOnly: true } } }));
  files.set('/app/data/bank.json', json({ untouchedBank: true }));
  files.set('/app/data/history.json', json({ untouchedHistory: true }));
  if (options.pending) files.set('/app/data/bank.json.pending', json({ untouchedPending: true }));
  if (options.existingTarget) files.set(target, Buffer.from('existing target must stay untouched'));
  const activeBefore = new Map([...files].filter(([p]) => p.startsWith('/app/data/'))
    .map(([p, b]) => [p, Buffer.from(b)]));
  const ioError = code => Object.assign(new Error(code), { code });
  const fs = {
    async readFile(p) {
      if (!files.has(p)) throw ioError('ENOENT');
      const bytes = Buffer.from(files.get(p));
      if (options.replaceInputAfterRead && p === '/inputs/artifact.json')
        files.set(p, Buffer.from('later input bytes must never be staged'));
      return bytes;
    },
    async writeFile(p, bytes, flags) {
      assert.equal(flags.flag, 'wx', 'Every file creation must be exclusive');
      if (files.has(p)) throw ioError('EEXIST');
      files.set(p, Buffer.from(bytes)); modes.set(p, flags.mode); writes.push(p);
    },
    async mkdir(p) { if (files.has(p)) throw ioError('EEXIST'); files.set(p, null); },
    async lstat(p) { if (!files.has(p)) throw ioError('ENOENT'); return { isFile: () => p !== options.stateSymlink }; },
    async realpath(p) { return options.reportParentSymlink && p === '/checks-out' ? '/app/data' : p; },
  };
  const sandbox = createContext({ Buffer, Date: class extends Date { static now() { return clock; } },
    process: { argv: ['node', 'stage', '/inputs/artifact.json', '/inputs/audit.json',
      '/inputs/preflight.json', '/inputs/context.json', options.reportPath ?? '/checks-out/result.json'],
    stdout: { write() {} } } });
  const dependencies = { 'node:fs/promises': fs, 'node:crypto': { createHash }, 'node:path': path };
  const module = new SourceTextModule(source, { context: sandbox });
  await module.link(specifier => {
    const exports = dependencies[specifier]; assert.ok(exports, `Unreviewed import: ${specifier}`);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context: sandbox });
  });
  let error;
  try { await module.evaluate(); } catch (e) { error = e.message; }
  if (options.error) assert.equal(error, options.error, name); else assert.equal(error, undefined, name);
  for (const [p, bytes] of activeBefore) assert.deepEqual(files.get(p), bytes, `${name}: active file mutation`);
  if (options.noWrites) assert.equal(writes.length, 0, name);
  if (!options.error) {
    assert.deepEqual(files.get(target), artifactBytes, 'Staged exact audited buffer');
    assert.equal(modes.get(target), 0o444);
    const report = JSON.parse(files.get('/checks-out/result.json'));
    assert.equal(report.artifactSha256, artifactSha);
    for (const backup of report.backups) {
      assert.equal(sha(files.get(backup.backup)), sha(activeBefore.get(backup.original)));
      assert.equal(backup.sha256, sha(activeBefore.get(backup.original)));
      assert.equal(modes.get(backup.backup), 0o600);
    }
    assert.equal(report.backups.length, options.pending ? 4 : 3);
  }
  cases.push({ name, passed: true, writes: writes.length, expectedRejection: options.error ?? null });
}
await scenario('valid audit stages immutable bytes and exact recovery copies');
await scenario('pending journal is backed up when present', { pending: true });
await scenario('input replacement after initial read cannot alter staged bytes', { replaceInputAfterRead: true });
await scenario('reject report in absent active pending journal', {
  reportPath: '/app/data/bank.json.pending', error: 'STAGING_SEPARATE_REPORT_OUTPUT_REQUIRED', noWrites: true });
await scenario('reject output parent symlink into active storage', {
  reportParentSymlink: true, error: 'STAGING_SEPARATE_REPORT_OUTPUT_REQUIRED', noWrites: true });
await scenario('reject output traversal into active storage', {
  reportPath: '/checks-out/../app/data/bank.json.pending', error: 'STAGING_SEPARATE_REPORT_OUTPUT_REQUIRED', noWrites: true });
await scenario('reject artifact evidence mismatch before writes', {
  audit: { artifactSha256: '0'.repeat(64) }, error: 'STAGING_VERIFIED_CURRENT_IMPORT_REQUIRED', noWrites: true });
await scenario('reject stale preflight before writes', {
  preflight: { verifiedAtUtc: new Date(clock - 300_001).toISOString() }, error: 'STAGING_VERIFIED_CURRENT_IMPORT_REQUIRED', noWrites: true });
await scenario('reject future preflight before writes', {
  preflight: { verifiedAtUtc: new Date(clock + 1).toISOString() }, error: 'STAGING_VERIFIED_CURRENT_IMPORT_REQUIRED', noWrites: true });
await scenario('reject state symlink before writes', {
  stateSymlink: '/app/data/bank.json', error: 'STAGING_STATE_MUST_BE_REGULAR_FILE', noWrites: true });
await scenario('existing staged target remains unchanged', { existingTarget: true, error: 'EEXIST' });
const report = { version: 'stage-import-in-memory-filesystem-audit-v1', verified: true,
  stageScriptSha256: sha(Buffer.from(source)), cases, actualAccountFilesAccessed: false,
  applicationModulesImported: false, ordersSubmitted: 0 };
assert.equal(process.argv.length, 3, 'Supply one new JSON report path');
await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ verified: true, cases: cases.length }) + '\n');
