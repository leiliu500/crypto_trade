/** Read-only account-volume capture, inside an isolated container.
 * STAGING_REPORT CURRENT_CONTEXT; only /capture receives new snapshot files.
 */
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
const [stagePath, contextPath] = process.argv.slice(2);
if (process.argv.length !== 4 || !stagePath || !contextPath || await realpath('/capture') !== '/capture')
  throw new Error('Two input paths and separate /capture output required');
const stage = JSON.parse(await readFile(stagePath)), context = JSON.parse(await readFile(contextPath));
if (context.mode !== 'paper' || context.trainingFile !== stage.target
    || [context.paperFile, context.stateFile].some(p => typeof p !== 'string' || dirname(p) !== '/app/data'))
  throw new Error('DEPLOYED_PAPER_CONTEXT_REQUIRED');
const backup = stage.backups.find(item => item.original === context.paperFile);
if (!backup || dirname(backup.backup) !== stage.backupDirectory
    || dirname(stage.backupDirectory) !== '/app/data'
    || !basename(stage.backupDirectory).startsWith('pre-risk-training-import-'))
  throw new Error('STAGED_ACCOUNT_BACKUP_REQUIRED');
const archivePath = path => '/archive' + path.slice('/app/data'.length);
const before = await readFile(archivePath(backup.backup));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
if (sha(before) !== backup.sha256 || before.length !== backup.bytes) throw new Error('ACCOUNT_BACKUP_HASH_MISMATCH');
const after = await readFile(archivePath(context.paperFile)), bank = await readFile(archivePath(context.stateFile));
const snapshots = [['before-paper.json', before], ['after-paper.json', after], ['after-bank.json', bank]];
const files = [];
for (const [name, bytes] of snapshots) {
  JSON.parse(bytes);
  await writeFile(`/capture/${name}`, bytes, { flag: 'wx', mode: 0o600 });
  files.push({ name, bytes: bytes.length, sha256: sha(bytes) });
}
await writeFile('/capture/state-capture.json', JSON.stringify({ capturedAtUtc: new Date().toISOString(), files,
  accountVolumeMountedReadOnly: true, capturesUseSeparateFiles: true, crossFileAtomicSnapshot: false }, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ captured: files.map(file => file.name), runningStateModified: false }) + '\n');
