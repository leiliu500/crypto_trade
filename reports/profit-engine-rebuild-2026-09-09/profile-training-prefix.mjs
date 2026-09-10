/** Run only in the bounded network-none profiling container. Frozen /work
 * source and /archive are read-only. This writes timing/provenance, not labels. */
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { loadConfig } from '/work/src/config.ts';
import { policyReserveBps } from '/work/src/research/policy-planner.ts';
import { buildDistributionTraining } from '/work/src/distribution/training-backfill.ts';
import { createRiskBoundedTrainingContext, trainingContextHash } from '/work/src/distribution/risk-training-context.ts';
import { readRiskTrainingSourceHashes } from '/work/src/distribution/risk-training-source.ts';
const config = loadConfig(process.env, 'replay');
const riskContext = createRiskBoundedTrainingContext(config.symbolConfigs, config.distributionalSizingPolicy, 100000, 100000);
const assets = JSON.parse(readFileSync('/work/assets.json', 'utf8'));
const costs = Object.fromEntries(['BTC/USD', 'ETH/USD'].map(symbol => [symbol,
  { feeBps: config.symbolConfigs[symbol].cost.takerFeeBps, reserveBps: policyReserveBps(config.symbolConfigs[symbol]) }]));
const sourceHashes = readRiskTrainingSourceHashes(), sourceCodeSha256 = trainingContextHash(sourceHashes);
if (sourceCodeSha256 !== 'ea201bae84aaa6e02a4b992a629b0593d3f5ce4089297ccab9e6719ec15fa51a'
  || riskContext.sizingPolicyId !== '827a3c64f88eb32848104dc94f37b416f185a057441576e12cc16a4144ba7c02'
  || trainingContextHash(riskContext) !== 'f6059c3c699f9c6bffc06209c5c41a0b3484d24effaa30b34af5237c46ca62c5')
  throw new Error('PROFILE_FROZEN_CONFIGURATION_MISMATCH');
const sourceFile = '/archive/continuous-events.20260905T045958Z.jsonl.gz';
const cpuStart = process.cpuUsage(), wallStart = performance.now();
const hash = createHash('sha256');
let inputEvents = 0, stopReason = 'SOURCE_END', compressedBytesRead = 0;
function decodeRecordedEvent(line) { return JSON.parse(line); }
async function* prefix() {
  const file = createReadStream(sourceFile), decoder = createGunzip();
  const observeCompressed = chunk => { compressedBytesRead += chunk.length; hash.update(chunk); };
  file.on('data', observeCompressed);
  file.pipe(decoder);
  const lines = createInterface({ input: decoder, crlfDelay: Infinity });
  let streamError;
  file.on('error', error => { streamError = error; decoder.destroy(error); });
  decoder.on('error', error => { streamError = error; lines.close(); });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (inputEvents >= 100_000) { stopReason = '100000_EVENT_PREFIX'; break; }
      if (inputEvents % 256 === 0) {
        const cpu = process.cpuUsage(cpuStart);
        if (cpu.user + cpu.system >= 30_000_000) { stopReason = '30_CPU_SECONDS'; break; }
        if (performance.now() - wallStart >= 45_000) { stopReason = '45_WALL_SECONDS'; break; }
      }
      inputEvents++;
      yield decodeRecordedEvent(line);
    }
    if (streamError) throw streamError;
  } finally {
    lines.close(); file.removeListener('data', observeCompressed); file.unpipe(decoder); file.destroy(); decoder.destroy();
  }
}
const result = await buildDistributionTraining(prefix(), costs, assets,
  { cutoffMs: Date.parse('2026-09-05T05:00:00.000Z'), riskContext });
const wallMs = performance.now() - wallStart, cpu = process.cpuUsage(cpuStart);
const summary = { generatedAtUtc: new Date().toISOString(), purpose: 'CPU profiling only; no training artifact or economic outcome report produced',
  sourceFile, sourceCodeSha256, sizingPolicyId: riskContext.sizingPolicyId, riskContextSha256: trainingContextHash(riskContext),
  network: 'none', cpuLimit: 1, memoryLimitBytes: 2147483648, stopReason, inputEvents,
  compressedBytesRead, compressedReadPrefixSha256: hash.digest('hex'), readAheadMayExceedConsumedRecords: true, wallMs,
  cpuMs: (cpu.user + cpu.system) / 1000, eventsPerWallSecond: inputEvents / wallMs * 1000,
  publicMarketEvents: result.report.quality.events, firstMarketMs: result.report.quality.firstMs,
  lastMarketMs: result.report.quality.lastMs, eventDownsampling: false, labelsWritten: false,
  modelImported: false, ordersSubmitted: 0 };
writeFileSync('/out/prefix-summary.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
