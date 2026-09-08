import { createReadStream, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import type { RecordedEvent } from "../backtest/replay.js";
import type { AssetRules } from "../execution/planner.js";
import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";
import { policyReserveBps } from "../research/policy-planner.js";
import type { DistributionCosts } from "./controller.js";
import { DISTRIBUTION_SPEC } from "./spec.js";

export interface HorizonResearchCliOptions {
  manifest: string; assets: string; out: string;
  trainingStartMs: number; laterStartMs: number; cutoffMs: number; includePanels: boolean;
}
export interface HorizonResearchProgress { events: number; atMs: number | null; file: string }
export type HorizonResearchRunner = (events: AsyncIterable<RecordedEvent>, costs: DistributionCosts,
  assets: Readonly<Record<string, AssetRules>>, options: Pick<HorizonResearchCliOptions,
    "trainingStartMs" | "laterStartMs" | "cutoffMs" | "includePanels">) => Promise<Record<string, unknown>>;

export function parseHorizonResearchArgs(args: readonly string[]): HorizonResearchCliOptions {
  const values = new Map<string, string>(), allowed = ["manifest", "assets", "training-start", "later-start", "cutoff", "out"];
  let includePanels = false;
  for (const arg of args) {
    if (arg === "--include-panels" && !includePanels) { includePanels = true; continue; }
    const index = arg.indexOf("="), key = arg.slice(2, index), value = arg.slice(index + 1);
    if (!arg.startsWith("--") || index < 3 || !allowed.includes(key) || !value || values.has(key))
      throw new Error(`INVALID_HORIZON_OPTION:${arg}`);
    values.set(key, value);
  }
  if (allowed.some(key => !values.has(key))) throw new Error("Usage: research:horizons --manifest=training-artifact.json --assets=rules.json --training-start=ISO --later-start=ISO --cutoff=ISO --out=new-report.json [--include-panels]");
  const timestamp = (key: string) => {
    const value = values.get(key)!;
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!parts) throw new Error(`INVALID_HORIZON_TIMESTAMP:${key}`);
    const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
    const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!
      || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59)
      throw new Error(`INVALID_HORIZON_TIMESTAMP:${key}`);
    return Date.parse(value);
  };
  const options = { manifest: values.get("manifest")!, assets: values.get("assets")!, out: values.get("out")!,
    trainingStartMs: timestamp("training-start"), laterStartMs: timestamp("later-start"),
    cutoffMs: timestamp("cutoff"), includePanels };
  validateBoundaries(options);
  return options;
}

/** Replay configuration is isolated from the running paper-trial permission.
 * The caller's environment and local .env file are never rewritten. */
export function horizonReplayCosts(env: NodeJS.ProcessEnv = process.env) {
  const cfg = loadConfig({ ...env, DISTRIBUTIONAL_PAPER_TRIAL_ENABLED: "false" }, "replay");
  const costs = Object.fromEntries(DISTRIBUTION_SPEC.symbols.map(symbol => {
    const config = cfg.symbolConfigs[symbol];
    if (!config) throw new Error(`MISSING_HORIZON_COST_CONFIGURATION:${symbol}`);
    return [symbol, { feeBps: config.cost.takerFeeBps, reserveBps: policyReserveBps(config) }];
  }));
  return { costs, configurationVersion: cfg.configurationVersion,
    source: `Replay configuration ${cfg.configurationVersion}; configured taker fees and execution/funding reserve` };
}

/** Scan compressed inputs exactly once, hashing the bytes actually replayed.
 * No output becomes visible until the whole immutable manifest is verified. */
export async function prepareHorizonResearch(options: HorizonResearchCliOptions, costs: DistributionCosts,
  dependencies: { replay?: HorizonResearchRunner; onProgress?: (progress: HorizonResearchProgress) => void;
    costSource?: string } = {}) {
  validateBoundaries(options);
  const output = resolve(options.out);
  await requireAbsent(output);
  const manifest = await readStableJson(options.manifest), instrument = await readStableJson(options.assets);
  const metadata = manifest.value as { trainingBackfill?: Record<string, unknown>; inputFiles?: unknown };
  const source = metadata?.trainingBackfill ?? metadata;
  const rawInputs = source?.inputFiles;
  if (!Array.isArray(rawInputs) || !rawInputs.length || rawInputs.length > 10_000) throw new Error("INVALID_HORIZON_MANIFEST");
  const assets = instrument.value as Record<string, AssetRules>;
  for (const symbol of DISTRIBUTION_SPEC.symbols) {
    const rules = assets?.[symbol], cost = costs[symbol];
    if (!rules || rules.symbol !== symbol || ![rules.minOrderSize, rules.minTradeIncrement, rules.priceIncrement,
      rules.maximumOrderQty].every(n => Number.isFinite(n) && n > 0) || typeof rules.shortable !== "boolean")
      throw new Error(`INVALID_HORIZON_INSTRUMENT:${symbol}`);
    if (!cost || ![cost.feeBps, cost.reserveBps].every(n => Number.isFinite(n) && n >= 0))
      throw new Error(`INVALID_HORIZON_COSTS:${symbol}`);
  }
  const inputs: Array<{ path: string; manifestPath: string; expectedBytes: number; expectedSha256: string; before: Stats }> = [];
  for (const candidate of rawInputs) {
    if (!candidate || typeof candidate.path !== "string" || !candidate.path || !Number.isSafeInteger(candidate.bytes)
      || candidate.bytes <= 0 || typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.sha256))
      throw new Error("INVALID_HORIZON_MANIFEST_INPUT");
    const path = isAbsolute(candidate.path) ? resolve(candidate.path) : resolve(dirname(manifest.path), candidate.path);
    if (inputs.some(input => input.path === path)) throw new Error("DUPLICATE_HORIZON_INPUT_PATH");
    const before = await stat(path);
    if (!before.isFile()) throw new Error(`HORIZON_INPUT_NOT_FILE:${path}`);
    if (before.size !== candidate.bytes) throw new Error(`HORIZON_INPUT_SIZE_MISMATCH:${path}`);
    if (inputs.some(input => input.before.dev === before.dev && input.before.ino === before.ino))
      throw new Error("DUPLICATE_HORIZON_INPUT_INODE");
    inputs.push({ path, manifestPath: candidate.path, expectedBytes: candidate.bytes, expectedSha256: candidate.sha256, before });
  }
  const inputFiles: Array<{ path: string; manifestPath: string; expectedBytes: number; actualBytes: number;
    expectedSha256: string; actualSha256: string; sha256Matches: boolean; modifiedMs: number; changedMs: number;
    inode: number; device: number }> = [];
  let eventsRead = 0, lastProgressMs = Date.now();
  async function* events() {
    for (const input of inputs) {
      const hash = createHash("sha256"); let actualBytes = 0;
      for await (const event of readHorizonEvents(input.path, bytes => { hash.update(bytes); actualBytes += bytes.length; })) {
        eventsRead++;
        if (dependencies.onProgress && Date.now() - lastProgressMs >= 30_000) {
          dependencies.onProgress({ events: eventsRead, atMs: recordedTimestamp(event), file: input.path });
          lastProgressMs = Date.now();
        }
        yield event;
      }
      const actualSha256 = hash.digest("hex");
      if (actualBytes !== input.expectedBytes) throw new Error(`HORIZON_INPUT_SIZE_MISMATCH:${input.path}`);
      if (actualSha256 !== input.expectedSha256) throw new Error(`HORIZON_INPUT_HASH_MISMATCH:${input.path}`);
      await unchanged(input.path, input.before);
      inputFiles.push({ path: input.path, manifestPath: input.manifestPath, expectedBytes: input.expectedBytes,
        actualBytes, expectedSha256: input.expectedSha256, actualSha256, sha256Matches: true,
        modifiedMs: input.before.mtimeMs, changedMs: input.before.ctimeMs, inode: input.before.ino, device: input.before.dev });
      dependencies.onProgress?.({ events: eventsRead, atMs: null, file: input.path });
      lastProgressMs = Date.now();
    }
  }
  const replay: HorizonResearchRunner = dependencies.replay ?? (await import("./horizon-replay.js")).replayHorizonResearch;
  const result = await replay(events(), costs, assets, { trainingStartMs: options.trainingStartMs,
    laterStartMs: options.laterStartMs, cutoffMs: options.cutoffMs, includePanels: options.includePanels });
  if (inputFiles.length !== inputs.length) throw new Error("HORIZON_REPLAY_DID_NOT_CONSUME_MANIFEST");
  for (const input of inputs) await unchanged(input.path, input.before);
  await unchanged(manifest.path, manifest.before); await unchanged(instrument.path, instrument.before);
  const report = { ...result, inputProvenance: { manifest: { path: manifest.path, sha256: manifest.sha256, bytes: manifest.before.size },
    inputFiles, eventsRead, compressedBytesRead: sum(inputFiles.map(input => input.actualBytes)),
    costs, costSource: dependencies.costSource ?? "Explicit supplied cost configuration",
    manifestCosts: "costs" in source ? source.costs : null,
    instrumentRules: { path: instrument.path, sha256: instrument.sha256, bytes: instrument.before.size, assets,
      source: "Explicit local instrument rules; historical applicability must be assessed separately" } },
    brokerOrdersSubmitted: 0, deploymentReady: false, profitabilityEstablished: false };
  const content = `${JSON.stringify(report, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2)}\n`;
  await atomicCreate(output, content);
  return { output, sha256: createHash("sha256").update(content).digest("hex"), report };
}

function validateBoundaries(options: Pick<HorizonResearchCliOptions, "trainingStartMs" | "laterStartMs" | "cutoffMs">) {
  if (![options.trainingStartMs, options.laterStartMs, options.cutoffMs].every(n => Number.isSafeInteger(n) && n >= 0)
    || options.trainingStartMs >= options.laterStartMs || options.laterStartMs >= options.cutoffMs)
    throw new Error("INVALID_HORIZON_BOUNDARIES");
}
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
function recordedTimestamp(event: RecordedEvent): number | null {
  const atMs = event?.kind === "BOOK" ? event.delta?.receiveTsMs : event?.kind === "TRADE" ? event.trade?.receiveTsMs
    : event?.kind === "DISCONNECT" || event?.kind === "RECORDER_GAP" ? event.receiveTsMs : null;
  return typeof atMs === "number" && Number.isFinite(atMs) ? atMs : null;
}
async function readStableJson(file: string) {
  const path = resolve(file), before = await stat(path);
  if (!before.isFile() || before.size > 64 * 1024 * 1024) throw new Error(`INVALID_HORIZON_METADATA_FILE:${path}`);
  const content = await readFile(path); await unchanged(path, before);
  return { path, before, value: JSON.parse(content.toString("utf8")) as unknown,
    sha256: createHash("sha256").update(content).digest("hex") };
}
async function unchanged(path: string, before: Stats) {
  const after = await stat(path);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error(`HORIZON_INPUT_CHANGED:${path}`);
}
async function* readHorizonEvents(path: string, onBytes: (bytes: Buffer) => void): AsyncGenerator<RecordedEvent> {
  const source = createReadStream(path), output = new PassThrough();
  const hashing = new Transform({ transform(bytes: Buffer, _encoding, done) { onBytes(bytes); done(null, bytes); } });
  const decoder = path.toLowerCase().endsWith(".gz") ? createGunzip() : new PassThrough();
  const lines = createInterface({ input: output, crlfDelay: Infinity });
  let failure: unknown;
  const running = pipeline(source, hashing, decoder, output).catch(error => { failure = error; });
  try {
    for await (const line of lines) if (line.trim()) yield JSON.parse(line) as RecordedEvent;
    await running;
    if (failure) throw failure;
  } finally {
    lines.close(); source.destroy(); hashing.destroy(); decoder.destroy(); output.destroy();
    await running;
  }
}
async function requireAbsent(path: string) {
  try { await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error(`HORIZON_OUTPUT_EXISTS:${path}`);
}
async function atomicCreate(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`, handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(temporary).catch(() => {}); throw error; }
  await handle.close();
  try {
    await link(temporary, path); await unlink(temporary);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  loadLocalEnv();
  const options = parseHorizonResearchArgs(process.argv.slice(2)), configured = horizonReplayCosts();
  const prepared = await prepareHorizonResearch(options, configured.costs, { costSource: configured.source,
    onProgress: ({ events, atMs, file }) => process.stderr.write(`Horizon replay: ${events} raw events${atMs === null ? "" : ` through ${new Date(atMs).toISOString()}`} (${file})\n`) });
  process.stdout.write(`${JSON.stringify({ output: prepared.output, sha256: prepared.sha256,
    events: prepared.report.inputProvenance.eventsRead, inputFiles: prepared.report.inputProvenance.inputFiles.length,
    brokerOrdersSubmitted: 0, profitabilityEstablished: false }, null, 2)}\n`);
}
