import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { AssetRules } from "../execution/planner.js";
import type { DistributionCosts } from "./controller.js";
import { ConditionalDistributionModel } from "./model.js";
import { DISTRIBUTION_ACTIONS as ACTIONS, DISTRIBUTION_SCENARIOS as SCENARIOS, DISTRIBUTION_SPEC as S,
  type DistributionOutcome, type DistributionSample } from "./spec.js";

export interface PredictiveAuditPaths { reportPath: string; auditPath: string; seedPath: string; protocolPath: string }
export interface ArchivedScenarioForecast {
  scenario: string; current: number | null; efficient: number | null;
  unconditionalCurrent: number | null; unconditionalEfficient: number | null;
  currentEligible: boolean; efficientEligible: boolean; currentSamples: number; efficientSamples: number;
  currentEffectiveSamples: number; efficientEffectiveSamples: number;
}
export interface PredictiveAuditProbe {
  symbol: string; atMs: number; features: number[]; eventIndex: number;
  predictions: Array<{ actionId: string; forecast: ArchivedScenarioForecast[] }>;
  outcomes: Array<{ actionId: string; outcomes: DistributionOutcome[]; eventIndex: number }>;
}
export interface PredictiveAuditData {
  source: {
    mode: "DEVELOPMENT" | "PROSPECTIVE"; startMs: number; endMs: number; untouched: false;
    costs: DistributionCosts; assets: Record<string, AssetRules>; sourceHashes: Record<string, string>;
    report: { path: string; sha256: string }; audit: { path: string; sha256: string; records: number; finalHash: string };
    seed: { path: string; sha256: string; samples: number };
    protocol: { path: string; sha256: string; createdAtMs: number };
    rawInputs: Array<{ path: string; bytes: number; sha256: string }>; rawInputsRehashed: false;
  };
  freezes: Array<{ cutoffMs: number; samples: DistributionSample[]; sha256: string }>;
  probes: PredictiveAuditProbe[];
}
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fail = (code: string): never => { throw new Error(`PREDICTIVE_AUDIT_${code}`); };
function check(value: unknown, code: string): asserts value { if (!value) fail(code); }
function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value), "OBJECT_REQUIRED");
  return value as Record<string, unknown>;
}
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const hashString = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const finiteOrNull = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function features(value: unknown): asserts value is number[] {
  check(Array.isArray(value) && value.length === S.featureDimension
    && value.every(x => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 1), "FEATURES");
}
function outcomes(value: unknown, signalAtMs: number, completedAtMs: number): asserts value is DistributionOutcome[] {
  check(Array.isArray(value) && value.length === SCENARIOS.length, "SCENARIOS");
  for (const [index, item] of value.entries()) {
    const row = object(item), scenario = SCENARIOS[index]!;
    check(row.scenario === scenario.id && ["FILLED", "UNFILLED", "INVALID"].includes(String(row.status))
      && integer(row.exitAtMs) && row.exitAtMs >= signalAtMs && row.exitAtMs <= completedAtMs
      && typeof row.reason === "string" && row.reason.length > 0
      && typeof row.filledFraction === "number" && Number.isFinite(row.filledFraction)
      && row.filledFraction >= 0 && row.filledFraction <= 1, "OUTCOME");
    check(row.entryAtMs === null || integer(row.entryAtMs) && row.entryAtMs >= signalAtMs + scenario.latencyMs
      && row.entryAtMs <= row.exitAtMs, "ENTRY_TIME");
    if (row.status === "INVALID") {
      check(row.netBps === null && row.grossBps === null
        && (row.filledFraction === 0 || row.entryAtMs !== null), "INVALID_PATH_MUST_STAY_UNKNOWN");
    } else {
      check(typeof row.netBps === "number" && Number.isFinite(row.netBps)
        && typeof row.grossBps === "number" && Number.isFinite(row.grossBps)
        && row.netBps <= row.grossBps + 1e-9 && row.exitAtMs >= signalAtMs + scenario.latencyMs, "KNOWN_OUTCOME");
      check(row.status === "FILLED" ? row.filledFraction > 0 && row.entryAtMs !== null
        : row.filledFraction === 0 && row.entryAtMs === null && row.netBps === 0 && row.grossBps === 0, "FILL_STATUS");
    }
  }
}
function sample(value: unknown, endMs: number): asserts value is DistributionSample {
  const row = object(value);
  check(S.symbols.some(s => s === row.symbol) && ACTIONS.some(a => a.id === row.actionId)
    && integer(row.signalAtMs) && integer(row.completedAtMs) && row.completedAtMs >= row.signalAtMs
    && row.completedAtMs <= endMs && row.id === `${row.symbol}:${row.actionId}:${row.signalAtMs}`, "SAMPLE");
  features(row.features); outcomes(row.outcomes, row.signalAtMs, row.completedAtMs);
}
function forecasts(value: unknown): asserts value is PredictiveAuditProbe["predictions"] {
  check(Array.isArray(value) && value.length === ACTIONS.length, "FORECAST_ACTIONS");
  const seen = new Set<string>();
  for (const item of value) {
    const prediction = object(item);
    check(typeof prediction.actionId === "string" && ACTIONS.some(a => a.id === prediction.actionId)
      && !seen.has(prediction.actionId), "FORECAST_ACTIONS");
    seen.add(prediction.actionId);
    check(Array.isArray(prediction.forecast) && prediction.forecast.length === SCENARIOS.length, "FORECAST_SCENARIOS");
    for (const [index, item] of prediction.forecast.entries()) {
      const f = object(item);
      check(f.scenario === SCENARIOS[index]!.id
        && [f.current, f.efficient, f.unconditionalCurrent, f.unconditionalEfficient].every(finiteOrNull)
        && typeof f.currentEligible === "boolean" && typeof f.efficientEligible === "boolean", "FORECAST");
      for (const name of ["current", "efficient"]) {
        const count = f[`${name}Samples`], effective = f[`${name}EffectiveSamples`];
        check(integer(count) && typeof effective === "number" && Number.isFinite(effective)
          && effective >= 0 && effective <= count + 1e-8, "FORECAST_SUPPORT");
      }
    }
  }
}
async function boundedFile(path: string, maximum: number) {
  const absolute = resolve(path), before = await stat(absolute);
  check(before.isFile() && before.size > 0 && before.size <= maximum, "FILE_SIZE");
  const bytes = await readFile(absolute), after = await stat(absolute);
  check(bytes.length <= maximum && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, "FILE_CHANGED");
  return { path: absolute, sha256: sha(bytes), bytes };
}
function admittedBank(rows: DistributionSample[], cutoffMs: number): DistributionSample[] {
  // Match EfficientDistributionTrainer.exportSamples(), then the study's stable
  // descending-origin capacity filter and final reversal exactly.
  const sorted = [...rows].sort((a, b) => a.signalAtMs - b.signalAtMs
    || a.symbol.localeCompare(b.symbol) || a.actionId.localeCompare(b.actionId));
  const counts = new Map<string, number>();
  return sorted.filter(row => row.completedAtMs < cutoffMs).sort((a, b) => b.signalAtMs - a.signalAtMs)
    .filter(row => { const key = `${row.symbol}:${row.actionId}`, n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n); return n <= S.maximumSamples; }).reverse();
}

/** Loads already inspected compact studies without re-running market execution.
 * Hashes attest to the supplied archived bytes, not untouched test data or the
 * correctness of unavailable depth. All outcome access retains audit ordering. */
export async function loadPredictiveAuditData(paths: PredictiveAuditPaths): Promise<PredictiveAuditData> {
  const [reportFile, auditFile, seedFile, protocolFile] = await Promise.all([
    boundedFile(paths.reportPath, 16 * 1024 * 1024), boundedFile(paths.auditPath, 64 * 1024 * 1024),
    boundedFile(paths.seedPath, 64 * 1024 * 1024), boundedFile(paths.protocolPath, 4 * 1024 * 1024),
  ]);
  const report = object(JSON.parse(reportFile.bytes.toString("utf8"))), manifest = object(JSON.parse(protocolFile.bytes.toString("utf8")));
  const protocol = object(manifest.protocol), result = object(report.report), seed = object(JSON.parse(seedFile.bytes.toString("utf8")));
  check(manifest.version === "conditional-study-manifest-v1" && protocol.version === "conditional-study-v1"
    && integer(protocol.startMs) && protocol.startMs > 0 && integer(protocol.endMs) && protocol.endMs > protocol.startMs
    && ["DEVELOPMENT", "PROSPECTIVE"].includes(String(protocol.mode)) && protocol.minimumTrainingDays === 3
    && integer(manifest.createdAtMs), "PROTOCOL");
  check(report.protocolSha256 === protocolFile.sha256 && canonical(report.manifest) === canonical(manifest)
    && canonical(result.protocol) === canonical(protocol), "PROTOCOL_HASH_OR_CONTENT");
  check(manifest.seedSha256 === seedFile.sha256 && manifest.seedFile === "seed.json", "SEED_HASH");
  const sourceHashes = object(manifest.sourceHashes);
  check(Object.keys(sourceHashes).length > 0 && Object.values(sourceHashes).every(hashString), "SOURCE_HASH_METADATA");
  const costs = object(protocol.costs), assets = object(protocol.assets);
  for (const symbol of S.symbols) {
    const fee = object(costs[symbol]), asset = object(assets[symbol]);
    check([fee.feeBps, fee.reserveBps].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)
      && asset.symbol === symbol && typeof asset.shortable === "boolean"
      && [asset.minOrderSize, asset.minTradeIncrement, asset.priceIncrement, asset.maximumOrderQty]
        .every(v => typeof v === "number" && Number.isFinite(v) && v > 0), "EXECUTION_CONTRACT");
  }
  const provenance = seed.trainingBackfill === undefined ? undefined : object(seed.trainingBackfill);
  check((seed.version === "conditional-study-seed-v1" || seed.version === S.version)
    && canonical(seed.costs) === canonical(costs)
    && canonical(seed.assets ?? provenance?.assets) === canonical(assets), "SEED_EXECUTION_CONTRACT");
  const source = object(report.source), terminal = object(report.audit);
  check(integer(source.firstMs) && integer(source.lastMs) && source.lastMs >= source.firstMs, "SOURCE_TIMES");
  check(Array.isArray(source.inputFiles) && source.inputFiles.length > 0, "RAW_INPUT_METADATA");
  for (const item of source.inputFiles) {
    const file = object(item);
    check(typeof file.path === "string" && file.path.length > 0 && integer(file.bytes) && file.bytes > 0
      && hashString(file.sha256), "RAW_INPUT_METADATA");
  }
  check(integer(terminal.records) && terminal.records > 0 && hashString(terminal.finalHash), "TERMINAL_ATTESTATION");
  if (terminal.sha256 !== undefined) check(terminal.sha256 === auditFile.sha256, "AUDIT_FILE_HASH");
  check(Array.isArray(seed.samples), "SEED_SAMPLES");
  const bank: DistributionSample[] = [], model = new ConditionalDistributionModel();
  for (const row of seed.samples) { sample(row, protocol.startMs); check(row.completedAtMs < source.firstMs, "SEED_INPUT_LEAKAGE"); }
  for (const row of [...seed.samples as DistributionSample[]].sort((a, b) => a.signalAtMs - b.signalAtMs)) {
    check(model.observe(row), "SEED_LABEL_OR_NONOVERLAP"); bank.push(row);
  }
  const decompressed = gunzipSync(auditFile.bytes, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8");
  check(decompressed.endsWith("\n"), "TRUNCATED_NDJSON");
  const lines = decompressed.slice(0, -1).split("\n"), probes: PredictiveAuditProbe[] = [], byOrigin = new Map<string, PredictiveAuditProbe>();
  const freezes: PredictiveAuditData["freezes"] = [], freezeRows: unknown[] = [];
  let previousHash = "0".repeat(64), eventIndex = 0, cutoff = -1;
  const lastOrigin = new Map<string, number>(), trainingIds = new Set<string>();
  const selected = new Map<string, boolean>();
  for (const line of lines) {
    const envelope = object(JSON.parse(line)), hashStart = line.lastIndexOf(',"hash":');
    check(Object.keys(envelope).join(",") === "sequence,previousHash,record,hash" && JSON.stringify(envelope) === line
      && envelope.sequence === ++eventIndex && envelope.previousHash === previousHash
      && hashStart > 0 && sha(line.slice(0, hashStart) + "}") === envelope.hash, "CHAIN");
    check(hashString(envelope.hash), "CHAIN"); previousHash = envelope.hash;
    const row = object(envelope.record);
    if (row.kind === "TRAINING") {
      check((row.trainer === "current" || row.trainer === "efficient") && typeof row.learned === "boolean", "TRAINING");
      sample(row.sample, protocol.endMs); const label = row.sample;
      const id = `${row.trainer}:${label.id}`;
      check(!trainingIds.has(id) && label.signalAtMs >= source.firstMs, "TRAINING_ID_OR_TIME"); trainingIds.add(id);
      if (row.learned) check(label.outcomes.every(o => o.status !== "INVALID"), "LEARNED_UNKNOWN_LABEL");
      if (row.trainer === "efficient") {
        check(row.learned === label.outcomes.every(o => o.status !== "INVALID"), "EFFICIENT_LEARNING_CONTRACT");
        if (row.learned) {
          check(label.completedAtMs === Math.max(...label.outcomes.map(o => o.exitAtMs)), "EFFICIENT_PUBLICATION_TIME");
          check(model.observe(label), "TRAINING_LABEL_OR_NONOVERLAP"); bank.push(label);
        }
      }
    } else if (row.kind === "DAILY_FREEZE") {
      check(integer(row.cutoffMs) && row.cutoffMs >= protocol.startMs && row.cutoffMs < protocol.endMs
        && row.cutoffMs > cutoff && (cutoff >= 0 || row.cutoffMs === protocol.startMs), "FREEZE_CUTOFF");
      cutoff = row.cutoffMs; const recorded = object(row.efficient), samples = admittedBank(bank, cutoff);
      const digest = sha(JSON.stringify(samples)), latest = samples.length ? Math.max(...samples.map(s => s.completedAtMs)) : null;
      check(recorded.sha256 === digest && recorded.samples === samples.length && recorded.latestCompletedMs === latest, "FREEZE_BANK_HASH");
      freezes.push({ cutoffMs: cutoff, samples, sha256: digest });
      const { kind: _kind, ...detail } = row; freezeRows.push(detail);
    } else if (row.kind === "PROBE_FORECAST") {
      check(S.symbols.some(s => s === row.symbol) && integer(row.atMs) && row.atMs >= protocol.startMs
        && row.atMs < protocol.endMs - 31 * 60_000 && cutoff >= 0 && row.atMs >= cutoff
        && cutoff === Math.max(protocol.startMs, Math.floor(row.atMs / 86_400_000) * 86_400_000)
        && row.bucket === Math.floor((row.atMs - protocol.startMs) / (31 * 60_000)), "PROBE_TIME");
      const symbol = row.symbol as string, key = `${symbol}:${row.atMs}`;
      check(!byOrigin.has(key) && row.atMs >= (lastOrigin.get(symbol) ?? -Infinity) + 31 * 60_000, "PROBE_ORIGIN");
      lastOrigin.set(symbol, row.atMs); features(row.features); forecasts(row.predictions);
      const probe = { symbol, atMs: row.atMs, features: row.features, eventIndex, predictions: row.predictions, outcomes: [] };
      probes.push(probe); byOrigin.set(key, probe);
    } else if (row.kind === "PROBE_OUTCOME") {
      const probe = byOrigin.get(`${row.symbol}:${row.atMs}`);
      check(probe && probe.eventIndex < eventIndex && typeof row.actionId === "string"
        && ACTIONS.some(a => a.id === row.actionId) && !probe.outcomes.some(o => o.actionId === row.actionId), "OUTCOME_WITHOUT_UNIQUE_PRIOR_FORECAST");
      outcomes(row.outcomes, probe.atMs, protocol.endMs);
      probe.outcomes.push({ actionId: row.actionId, outcomes: row.outcomes, eventIndex });
    } else if (row.kind === "SELECTION" || row.kind === "SELECTED_OUTCOME") {
      check(integer(row.atMs) && row.atMs <= protocol.endMs, "AUXILIARY_EVENT_TIME");
      check(["current", "efficient", "flat", "long-15m", "short-15m", "momentum-15m"].includes(String(row.policy))
        && S.symbols.some(s => s === row.symbol) && ACTIONS.some(a => a.id === row.actionId), "SELECTED_PATH");
      const key = `${row.policy}:${row.symbol}:${row.atMs}:${row.actionId}`;
      if (row.kind === "SELECTION") {
        check(!selected.has(key) && row.atMs >= protocol.startMs, "DUPLICATE_SELECTION"); features(row.features);
        check(typeof row.requestedQty === "number" && Number.isFinite(row.requestedQty) && row.requestedQty > 0
          && typeof row.quoteSequence === "string" && /^\d+$/.test(row.quoteSequence)
          && typeof row.referenceBid === "number" && Number.isFinite(row.referenceBid) && row.referenceBid > 0
          && typeof row.referenceAsk === "number" && Number.isFinite(row.referenceAsk)
          && row.referenceAsk >= row.referenceBid, "SELECTION_CONTEXT");
        selected.set(key, false);
      } else {
        check(selected.get(key) === false, "SELECTED_OUTCOME_WITHOUT_UNIQUE_PRIOR_SELECTION");
        outcomes(row.outcomes, row.atMs, protocol.endMs); selected.set(key, true);
      }
    } else if (row.kind === "INVALIDATION") {
      check(integer(row.atMs) && row.atMs <= protocol.endMs && typeof row.reason === "string"
        && row.reason.length > 0, "INVALIDATION");
    } else fail("UNKNOWN_RECORD_KIND");
  }
  check(eventIndex === terminal.records && previousHash === terminal.finalHash, "TERMINAL_CHAIN_MISMATCH");
  check(freezes.length > 0 && probes.length > 0 && probes.every(p => p.outcomes.length === ACTIONS.length), "INCOMPLETE_PROBES_OR_FREEZES");
  check([...selected.values()].every(Boolean), "INCOMPLETE_SELECTED_PATHS");
  check(canonical(result.freezes) === canonical(freezeRows), "REPORT_FREEZE_MISMATCH");
  return { source: { mode: protocol.mode as "DEVELOPMENT" | "PROSPECTIVE", startMs: protocol.startMs, endMs: protocol.endMs,
    untouched: false, costs: costs as DistributionCosts, assets: assets as Record<string, AssetRules>,
    sourceHashes: sourceHashes as Record<string, string>, report: { path: reportFile.path, sha256: reportFile.sha256 },
    audit: { path: auditFile.path, sha256: auditFile.sha256, records: eventIndex, finalHash: previousHash },
    seed: { path: seedFile.path, sha256: seedFile.sha256, samples: seed.samples.length },
    protocol: { path: protocolFile.path, sha256: protocolFile.sha256, createdAtMs: manifest.createdAtMs },
    rawInputs: source.inputFiles as PredictiveAuditData["source"]["rawInputs"], rawInputsRehashed: false }, freezes, probes };
}
