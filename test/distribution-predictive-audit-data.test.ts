import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { loadPredictiveAuditData } from "../src/distribution/predictive-audit-data.js";
import { DISTRIBUTION_ACTIONS as ACTIONS, DISTRIBUTION_SCENARIOS as SCENARIOS,
  type DistributionSample } from "../src/distribution/spec.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const startMs = 4_000_000, endMs = 8_000_000;
const costs = { "BTC/USD": { feeBps: 5, reserveBps: 3 }, "ETH/USD": { feeBps: 5, reserveBps: 3 } };
const assets = Object.fromEntries(Object.keys(costs).map(symbol => [symbol,
  { symbol, minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .1, maximumOrderQty: 100, shortable: true }]));
function sample(actionId: string, signalAtMs: number): DistributionSample {
  return { id: `BTC/USD:${actionId}:${signalAtMs}`, symbol: "BTC/USD", actionId, signalAtMs,
    completedAtMs: signalAtMs + 1_000, features: Array(12).fill(.1),
    outcomes: SCENARIOS.map(s => ({ scenario: s.id, status: "UNFILLED", netBps: 0, grossBps: 0,
      filledFraction: 0, entryAtMs: null, exitAtMs: signalAtMs + 1_000, reason: "IOC_UNFILLED" })) };
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "predictive-audit-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = { reportPath: join(dir, "report.json"), auditPath: join(dir, "audit.gz"),
    seedPath: join(dir, "seed.json"), protocolPath: join(dir, "protocol.json") };
  const seed = { version: "conditional-study-seed-v1", costs, assets,
    samples: ACTIONS.map(a => sample(a.id, 1_000_000)) };
  const added = sample("long-5m", 3_000_000);
  const frozen = [...seed.samples, added].sort((a,b) => a.signalAtMs-b.signalAtMs
    || a.symbol.localeCompare(b.symbol) || a.actionId.localeCompare(b.actionId))
    .sort((a,b) => b.signalAtMs-a.signalAtMs).reverse();
  const detail = { cutoffMs: startMs, current: { samples: 6, latestCompletedMs: 1_001_000, sha256: sha("current") },
    efficient: { samples: frozen.length, latestCompletedMs: 3_001_000, sha256: sha(JSON.stringify(frozen)) } };
  const atMs = startMs + 1_000;
  const probe = { kind: "PROBE_FORECAST", symbol: "BTC/USD", atMs, bucket: 0, features: Array(12).fill(.2),
    predictions: ACTIONS.map(a => ({ actionId: a.id, forecast: SCENARIOS.map(s => ({ scenario: s.id,
      current: -10, efficient: -11, unconditionalCurrent: -12, unconditionalEfficient: -13,
      currentEligible: false, efficientEligible: false, currentSamples: 1, efficientSamples: 2,
      currentEffectiveSamples: 1, efficientEffectiveSamples: 2 })) })) };
  const records: Array<Record<string, unknown>> = [
    { kind: "TRAINING", trainer: "efficient", learned: true, sample: added },
    { kind: "DAILY_FREEZE", ...detail }, probe,
    ...ACTIONS.map(a => ({ kind: "PROBE_OUTCOME", symbol: "BTC/USD", atMs, actionId: a.id,
      outcomes: sample(a.id, atMs).outcomes.map(o => a.id === "short-15m"
        ? { ...o, status: "INVALID", netBps: null, grossBps: null, reason: "DISCONNECT" } : o) })),
  ];
  const manifest = { version: "conditional-study-manifest-v1", protocol: { version: "conditional-study-v1",
    startMs, endMs, costs, assets, minimumTrainingDays: 3, mode: "DEVELOPMENT" }, createdAtMs: endMs + 1_000,
    seedFile: "seed.json", seedSha256: "", sourceHashes: { "src/distribution/study.ts": sha("source") } };
  async function seal() {
    const seedBytes = JSON.stringify(seed); manifest.seedSha256 = sha(seedBytes); const protocolBytes = JSON.stringify(manifest);
    let previousHash = "0".repeat(64);
    const lines = records.map((record, index) => { const row = { sequence: index + 1, previousHash, record };
      const hash = sha(JSON.stringify(row)); previousHash = hash; return JSON.stringify({ ...row, hash }); });
    const report = { manifest, protocolSha256: sha(protocolBytes), report: { protocol: manifest.protocol,
      freezes: records.filter(r => r.kind === "DAILY_FREEZE").map(({kind: _kind, ...detail}) => detail) },
      source: { firstMs: 2_000_000, lastMs: endMs - 1, inputFiles: [{ path: "raw.gz", bytes: 1, sha256: sha("raw") }] },
      audit: { records: records.length, finalHash: previousHash } };
    await Promise.all([writeFile(paths.seedPath, seedBytes), writeFile(paths.protocolPath, protocolBytes),
      writeFile(paths.auditPath, gzipSync(lines.join("\n") + "\n")), writeFile(paths.reportPath, JSON.stringify(report))]);
  }
  await seal(); return { paths, seed, records, manifest, seal, frozen };
}

test("compact loader reconstructs the exact frozen bank and preserves unknown outcomes and audit event ordering", async t => {
  const f = await fixture(t), data = await loadPredictiveAuditData(f.paths);
  assert.deepEqual(data.freezes[0]!.samples, f.frozen);
  assert.equal(data.freezes[0]!.sha256, sha(JSON.stringify(f.frozen)));
  assert.equal(data.source.untouched, false); assert.equal(data.source.rawInputsRehashed, false);
  assert.equal(data.probes[0]!.eventIndex, 3);
  assert.deepEqual(data.probes[0]!.outcomes.map(o => o.eventIndex), [4,5,6,7,8,9]);
  const unknown = data.probes[0]!.outcomes.find(o => o.actionId === "short-15m")!.outcomes;
  assert.ok(unknown.every(o => o.status === "INVALID" && o.netBps === null));
});

test("compact loader rejects mutated seed and protocol bytes against their sealed hashes", async t => {
  const f = await fixture(t);
  await writeFile(f.paths.seedPath, JSON.stringify({ ...f.seed, samples: [] }));
  await assert.rejects(loadPredictiveAuditData(f.paths), /SEED_HASH/);
  await f.seal(); await writeFile(f.paths.protocolPath, JSON.stringify({ ...f.manifest, createdAtMs: 1 }));
  await assert.rejects(loadPredictiveAuditData(f.paths), /PROTOCOL_HASH_OR_CONTENT/);
});

test("compact loader rejects changed records, reordered envelopes, and truncated terminal chains", async t => {
  const f = await fixture(t);
  const bytes = gunzipSync(await readFile(f.paths.auditPath)).toString();
  await writeFile(f.paths.auditPath, gzipSync(bytes.replace('"efficient":-11', '"efficient":-1')));
  await assert.rejects(loadPredictiveAuditData(f.paths), /CHAIN/);
  const lines = bytes.trim().split("\n"); [lines[0], lines[1]] = [lines[1]!, lines[0]!];
  await writeFile(f.paths.auditPath, gzipSync(lines.join("\n") + "\n"));
  await assert.rejects(loadPredictiveAuditData(f.paths), /CHAIN/);
  await writeFile(f.paths.auditPath, gzipSync(bytes.trim().split("\n").slice(0,-1).join("\n") + "\n"));
  await assert.rejects(loadPredictiveAuditData(f.paths), /TERMINAL_CHAIN_MISMATCH/);
});

test("compact loader rejects seed input leakage and a future-completed label advertised as admitted at freeze", async t => {
  const f = await fixture(t);
  f.seed.samples[0]!.completedAtMs = 2_000_000; await f.seal();
  await assert.rejects(loadPredictiveAuditData(f.paths), /SEED_INPUT_LEAKAGE/);
  f.seed.samples[0]!.completedAtMs = 1_001_000;
  const label = f.records[0]!.sample as DistributionSample; label.completedAtMs = startMs;
  for (const outcome of label.outcomes) outcome.exitAtMs = startMs;
  await f.seal(); await assert.rejects(loadPredictiveAuditData(f.paths), /FREEZE_BANK_HASH/);
});

test("compact loader rejects complete-chain re-seals with missing actions or an outcome before its forecast", async t => {
  const f = await fixture(t), last = f.records.pop()!; await f.seal();
  await assert.rejects(loadPredictiveAuditData(f.paths), /INCOMPLETE_PROBES_OR_FREEZES/);
  f.records.push(last); [f.records[2], f.records[3]] = [f.records[3]!, f.records[2]!]; await f.seal();
  await assert.rejects(loadPredictiveAuditData(f.paths), /OUTCOME_WITHOUT_UNIQUE_PRIOR_FORECAST/);
});

test("compact loader rejects conflicting duplicate action outcomes and converting unknown outcomes to zero", async t => {
  const f = await fixture(t); f.records.push(structuredClone(f.records[3]!)); await f.seal();
  await assert.rejects(loadPredictiveAuditData(f.paths), /OUTCOME_WITHOUT_UNIQUE_PRIOR_FORECAST/);
  f.records.pop(); const unknown = f.records.find(r => r.kind === "PROBE_OUTCOME" && r.actionId === "short-15m")!;
  (unknown.outcomes as Array<{netBps: number | null}>)[0]!.netBps = 0; await f.seal();
  await assert.rejects(loadPredictiveAuditData(f.paths), /INVALID_PATH_MUST_STAY_UNKNOWN/);
});

test("compact loader rejects overlapping learned labels even if the envelope chain was rebuilt", async t => {
  const f = await fixture(t), duplicate = structuredClone(f.records[0]!);
  f.records.splice(1,0,duplicate); await f.seal();
  await assert.rejects(loadPredictiveAuditData(f.paths), /TRAINING_ID_OR_TIME/);
  const overlapping = duplicate.sample as DistributionSample;
  overlapping.signalAtMs += 500; overlapping.id = `${overlapping.symbol}:${overlapping.actionId}:${overlapping.signalAtMs}`;
  overlapping.completedAtMs += 500;
  for (const o of overlapping.outcomes) o.exitAtMs += 500;
  await f.seal(); await assert.rejects(loadPredictiveAuditData(f.paths), /TRAINING_LABEL_OR_NONOVERLAP/);
});

test("compact loader rejects duplicate JSON keys after the hashed record", async t => {
  const f = await fixture(t), bytes = gunzipSync(await readFile(f.paths.auditPath)).toString();
  const lines = bytes.trim().split("\n"), original = JSON.parse(lines[0]!);
  const replacement = { ...original.record, learned: false };
  lines[0] = lines[0]!.slice(0,-1) + ',"record":' + JSON.stringify(replacement) + '}';
  await writeFile(f.paths.auditPath, gzipSync(lines.join("\n") + "\n"));
  await assert.rejects(loadPredictiveAuditData(f.paths), /CHAIN/);
});
