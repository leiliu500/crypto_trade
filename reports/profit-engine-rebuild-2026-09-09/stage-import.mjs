/** Stage one verified immutable training artifact and make recovery snapshots.
 * Run in the reviewed image with the paper volume mounted at /app/data.
 * Does not change configuration, account state, model state or submit orders.
 * ARTIFACT FULL_AUDIT PREFLIGHT CONTEXT /checks-out/NEW_REPORT
 */
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
const args = process.argv.slice(2);
if (args.length !== 5 || args.some(arg => !arg.trim())) throw new Error('Exactly five paths required');
const [artifactPath, auditPath, preflightPath, contextPath, reportPath] = args;
// Reports use a separate output mount; neither spelling nor a parent symlink
// may redirect a new report into an absent active account/journal file.
if (dirname(resolve(reportPath)) !== '/checks-out'
    || await realpath(dirname(resolve(reportPath))) !== '/checks-out')
  throw new Error('STAGING_SEPARATE_REPORT_OUTPUT_REQUIRED');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const [artifactBytes, auditBytes, preflightBytes, contextBytes] = await Promise.all(
  [artifactPath, auditPath, preflightPath, contextPath].map(path => readFile(path)));
const audit = JSON.parse(auditBytes), preflight = JSON.parse(preflightBytes), context = JSON.parse(contextBytes);
const artifactSha256 = sha(artifactBytes), source = 'c57475ab04ce281cbd83f86f95f0099d56d24ef5edcee758e293be197f8d036b';
const policy = '827a3c64f88eb32848104dc94f37b416f185a057441576e12cc16a4144ba7c02';
const verifiedAt = Date.parse(preflight.verifiedAtUtc), now = Date.now();
if (audit.artifactSha256 !== artifactSha256 || preflight.artifact?.sha256 !== artifactSha256
    || audit.artifactBytes !== artifactBytes.length || audit.sourceCodeSha256 !== source
    || preflight.sourceCodeSha256 !== source || audit.fullFrozenSourceVerified !== true
    || audit.inputFiles !== 34 || audit.isolatedImport?.repeatedAddedSamples !== 0
    || preflight.repeatedImportAddedSamples !== 0 || !(preflight.import?.addedSamples > 0)
    || preflight.sizingPolicyId !== policy || preflight.runtimeContextSha256 !== sha(contextBytes)
    || context.mode !== 'paper' || context.paperTrial !== true || context.efficientTraining !== true
    || context.regimeModel !== false || !Number.isSafeInteger(verifiedAt)
    || verifiedAt > now || now - verifiedAt > 300_000)
  throw new Error('STAGING_VERIFIED_CURRENT_IMPORT_REQUIRED');
const required = [context.paperFile, context.stateFile, context.historyFile];
if (required.some(path => typeof path !== 'string' || dirname(path) !== '/app/data')
    || new Set(required).size !== required.length)
  throw new Error('STAGING_UNEXPECTED_STATE_PATHS');
const snapshots = [...required, `${context.stateFile}.pending`];
const snapshotBytes = [];
for (const path of snapshots) {
  try {
    if (!(await lstat(path)).isFile()) throw new Error('STAGING_STATE_MUST_BE_REGULAR_FILE');
    const bytes = await readFile(path);
    JSON.parse(bytes);
    snapshotBytes.push({ path, bytes });
  } catch (error) {
    if (path.endsWith('.pending') && error.code === 'ENOENT') continue;
    throw error;
  }
}
const paper = JSON.parse(snapshotBytes.find(item => item.path === context.paperFile).bytes);
if (paper.schemaVersion !== 4 || paper.initialEquity !== 100000
    || !Number.isFinite(paper.cashEquity) || !paper.funding?.state)
  throw new Error('STAGING_EXISTING_PAPER_ACCOUNT_REQUIRED');
const timestamp = new Date(now).toISOString().replaceAll(':', '-');
const backupDirectory = `/app/data/pre-risk-training-import-${timestamp}`;
await mkdir(backupDirectory, { mode: 0o700 });
const backups = [];
for (const item of snapshotBytes) {
  const backup = `${backupDirectory}/${basename(item.path)}`;
  await writeFile(backup, item.bytes, { flag: 'wx', mode: 0o600 });
  if (sha(await readFile(backup)) !== sha(item.bytes)) throw new Error('STAGING_BACKUP_HASH_MISMATCH');
  backups.push({ original: item.path, backup, bytes: item.bytes.length, sha256: sha(item.bytes) });
}
const target = `/app/data/distributional-training-risk-v2-20260909T201636-${artifactSha256.slice(0, 16)}.json`;
// Stage the exact bytes already bound to the audit, without reopening the input.
// Exclusive creation preserves an existing target; read-only mode discourages
// accidental changes while startup also validates the artifact contents.
await writeFile(target, artifactBytes, { flag: 'wx', mode: 0o444 });
if (sha(await readFile(target)) !== artifactSha256) throw new Error('STAGING_ARTIFACT_HASH_MISMATCH');
const report = { stagedAtUtc: new Date(now).toISOString(), target, artifactSha256,
  artifactBytes: artifactBytes.length, sourceCodeSha256: source, previousTrainingFile: context.trainingFile,
  fullAuditSha256: sha(auditBytes), preflightSha256: sha(preflightBytes), backupDirectory, backups,
  paperCashEquity: paper.cashEquity, configurationChanged: false, runningStateChanged: false,
  brokerOrdersSubmitted: 0, snapshotsTakenWhileExistingEngineRunning: true };
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ staged: true, target, artifactSha256, backupDirectory }) + '\n');
