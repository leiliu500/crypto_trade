import { createReadStream, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";
import { createGunzip, gzipSync } from "node:zlib";
import type { EventEmitter } from "node:events";
import type { RecordedEvent } from "../backtest/replay.js";
import type { BookDelta } from "../core/order-book.js";
import type { MarketTrade } from "../core/market.js";
import type { AssetRules } from "../execution/planner.js";
import { KrakenFuturesMarketStream, type KrakenFuturesMarketStreamConfig } from "../kraken/market-stream.js";
import { DistributionController, type DistributionCosts } from "./controller.js";
import { ConditionalDistributionModel } from "./model.js";
import { mergeDistributionTraining } from "./training-import.js";
import { DISTRIBUTION_SPEC, type DistributionSample } from "./spec.js";
import type { StudyProtocol } from "./study.js";

const DAY_MS = 86_400_000, STUDY_DAYS = 14, MAX_AUDIT_BUFFER_BYTES = 4 * 1024 * 1024;
const manifestVersion = "conditional-study-manifest-v1";
const publicSource: KrakenFuturesMarketStreamConfig = Object.freeze({
  websocketUrl: "wss://futures.kraken.com/ws/v1",
  productsBySymbol: Object.freeze({ "BTC/USD": "PF_XBTUSD", "ETH/USD": "PF_ETHUSD" }),
  bookBatchMs: 25, bookDepth: 200,
});
const stringify = (value: unknown, pretty = false) => JSON.stringify(value,
  (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item, pretty ? 2 : undefined);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export interface StudyManifest {
  version: typeof manifestVersion; protocol: StudyProtocol; createdAtMs: number;
  seedFile: "seed.json"; seedSha256: string; sourceHashes: Record<string, string>;
  source: KrakenFuturesMarketStreamConfig;
  reproducibility: { rawEventsRetained: false; auditHashChain: true; limitations: string[] };
}
export type StudyCliOptions =
  | { command: "freeze" | "prepare-development"; out: string; seed: string; startMs: number; endMs: number }
  | { command: "replay"; protocol: string; inputs: string[]; out: string }
  | { command: "live"; protocol: string; out: string };
export interface StudyRunner {
  onEvent(event: RecordedEvent): void; finish(atMs: number, reason: string): void;
  report(): unknown; drainAudit(): unknown[];
}
type RunnerFactory = (protocol: StudyProtocol, seed: DistributionSample[]) => StudyRunner | Promise<StudyRunner>;
interface FileDependencies { nowMs?: number; sourceRoot?: string }
interface RunDependencies extends FileDependencies { engineFactory?: RunnerFactory }

/** Command parsing never loads account credentials, the application environment,
 * a broker, or production configuration. */
export function parseStudyArgs(args: readonly string[]): StudyCliOptions {
  const command = args[0];
  if (!["freeze", "prepare-development", "replay", "live"].includes(command ?? "")) throw new Error("INVALID_STUDY_COMMAND");
  const values = new Map<string, string>(), inputs: string[] = [];
  const allowed = command === "freeze" || command === "prepare-development" ? ["out", "seed", "start", "end"]
    : command === "replay" ? ["protocol", "input", "out"] : ["protocol", "out"];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!, equal = arg.indexOf("=");
    const key = arg.slice(2, equal < 0 ? undefined : equal);
    const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
    if (!arg.startsWith("--") || !allowed.includes(key) || !value || value.startsWith("--")
      || (key !== "input" && values.has(key))) throw new Error(`INVALID_STUDY_OPTION:${arg}`);
    if (key === "input") inputs.push(value); else values.set(key, value);
  }
  if (allowed.some(key => key === "input" ? !inputs.length : !values.has(key))) throw new Error("MISSING_STUDY_OPTIONS");
  if (command === "freeze" || command === "prepare-development") return { command, out: values.get("out")!,
    seed: values.get("seed")!, startMs: timestamp(values.get("start")!), endMs: timestamp(values.get("end")!) };
  if (command === "replay") return { command, protocol: values.get("protocol")!, inputs, out: values.get("out")! };
  return { command: "live", protocol: values.get("protocol")!, out: values.get("out")! };
}

function timestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new Error("INVALID_STUDY_TIMESTAMP");
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0
    || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error("INVALID_STUDY_TIMESTAMP");
  return parsed;
}
function validProtocol(protocol: StudyProtocol): void {
  if (!protocol || protocol.version !== "conditional-study-v1" || !["DEVELOPMENT", "PROSPECTIVE"].includes(protocol.mode)
    || protocol.minimumTrainingDays !== 3 || ![protocol.startMs, protocol.endMs].every(n => Number.isSafeInteger(n) && n >= 0)
    || protocol.startMs <= 0 || protocol.endMs <= protocol.startMs) throw new Error("INVALID_STUDY_PROTOCOL");
  if (protocol.mode === "PROSPECTIVE" && (protocol.startMs % DAY_MS !== 0
    || protocol.endMs - protocol.startMs !== STUDY_DAYS * DAY_MS)) throw new Error("STUDY_REQUIRES_FOURTEEN_UTC_DAYS");
  for (const symbol of DISTRIBUTION_SPEC.symbols) {
    const rules = protocol.assets?.[symbol], cost = protocol.costs?.[symbol];
    if (!rules || rules.symbol !== symbol || ![rules.minOrderSize, rules.minTradeIncrement,
      rules.priceIncrement, rules.maximumOrderQty].every(n => Number.isFinite(n) && n > 0)
      || typeof rules.shortable !== "boolean") throw new Error("INVALID_STUDY_ASSETS");
    if (!cost || ![cost.feeBps, cost.reserveBps].every(n => Number.isFinite(n) && n >= 0)) throw new Error("INVALID_STUDY_COSTS");
  }
}

/** A development seed may be a research-only bank. Prospective seeds must be
 * verified historical artifacts; their validation/order evidence is discarded. */
function validateSeed(value: unknown, mode: StudyProtocol["mode"], cutoffMs: number) {
  const document = value as { version?: string; samples?: DistributionSample[];
    costs?: DistributionCosts; assets?: Record<string, AssetRules>;
    trainingBackfill?: { costs?: DistributionCosts; assets?: Record<string, AssetRules> } };
  const costs = document?.trainingBackfill?.costs ?? document?.costs;
  const assets = document?.trainingBackfill?.assets ?? document?.assets;
  if (!costs || !assets || !Array.isArray(document?.samples) || document.samples.length > 12 * DISTRIBUTION_SPEC.maximumSamples)
    throw new Error("INVALID_STUDY_SEED");
  validProtocol({ version: "conditional-study-v1", mode: "DEVELOPMENT", costs, assets,
    startMs: Math.max(1, cutoffMs + 1), endMs: Math.max(2, cutoffMs + 2), minimumTrainingDays: 3 });
  if (document.trainingBackfill) {
    const empty = new DistributionController(costs, structuredClone(assets)).exportState();
    mergeDistributionTraining(empty, value, costs, assets, cutoffMs);
  } else if (mode !== "DEVELOPMENT" || document.version !== "conditional-study-seed-v1") {
    throw new Error("STUDY_REQUIRES_VERIFIED_TRAINING_ARTIFACT");
  }
  const model = new ConditionalDistributionModel();
  for (const sample of document.samples) {
    if (sample.completedAtMs > cutoffMs || !model.observe(sample)) throw new Error("INVALID_OR_FUTURE_STUDY_SEED_SAMPLE");
  }
  return { costs, assets, samples: structuredClone(document.samples),
    latestCompletedAtMs: document.samples.reduce((last, sample) => Math.max(last, sample.completedAtMs), -1) };
}

/** Only a new directory is created. The copied seed and sealed manifest are
 * written exclusively and made read-only; no production state is touched. */
export async function freezeStudy(options: Extract<StudyCliOptions, { command: "freeze" | "prepare-development" }>,
  dependencies: FileDependencies = {}) {
  const createdAtMs = dependencies.nowMs ?? Date.now(), root = dependencies.sourceRoot ?? defaultSourceRoot();
  const mode = options.command === "freeze" ? "PROSPECTIVE" : "DEVELOPMENT";
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) throw new Error("INVALID_STUDY_CREATION_TIME");
  if (mode === "PROSPECTIVE" && options.startMs <= createdAtMs) throw new Error("STUDY_START_MUST_BE_FUTURE");
  if (mode === "DEVELOPMENT" && options.endMs > createdAtMs) throw new Error("DEVELOPMENT_STUDY_MUST_BE_HISTORICAL");
  const seed = await stableJson(options.seed);
  const verified = validateSeed(seed.value, mode, Math.min(createdAtMs, options.startMs - 1));
  const protocol: StudyProtocol = { version: "conditional-study-v1", startMs: options.startMs,
    endMs: options.endMs, costs: verified.costs, assets: verified.assets, minimumTrainingDays: 3, mode };
  validProtocol(protocol);
  const sourceHashes = await hashStudySources(root);
  const manifest: StudyManifest = { version: manifestVersion, protocol, createdAtMs, seedFile: "seed.json",
    seedSha256: seed.sha256, sourceHashes, source: structuredClone(publicSource),
    reproducibility: { rawEventsRetained: false, auditHashChain: true, limitations: [
      "Prospective runs retain hashed source-event identity and compact learning/forecast/outcome audit, not full raw depth events",
      "The independent public connection can differ from production recorder streams; compact audit alone cannot fully replay source events",
      "A process interruption ends this run; the CLI refuses silent resume or replacement of its output directory",
    ] } };
  const directory = resolve(options.out);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory, { mode: 0o700 });
  await syncDirectory(dirname(directory));
  await exclusiveWrite(join(directory, "seed.json"), seed.bytes, 0o400);
  const content = `${stringify(manifest, true)}\n`;
  await exclusiveWrite(join(directory, "protocol.json"), content, 0o400);
  await syncDirectory(directory);
  return { directory, protocolPath: join(directory, "protocol.json"), sha256: sha(content), manifest };
}

export async function readStudyManifest(path: string, dependencies: FileDependencies = {}) {
  const file = await stableJson(path), manifest = file.value as StudyManifest;
  if (!manifest || manifest.version !== manifestVersion || manifest.seedFile !== "seed.json"
    || !Number.isSafeInteger(manifest.createdAtMs) || manifest.createdAtMs < 0
    || !/^[a-f0-9]{64}$/.test(manifest.seedSha256 ?? "")
    || stringify(manifest.source) !== stringify(publicSource)
    || !manifest.sourceHashes || typeof manifest.sourceHashes !== "object"
    || manifest.reproducibility?.rawEventsRetained !== false || manifest.reproducibility.auditHashChain !== true)
    throw new Error("INVALID_STUDY_MANIFEST");
  validProtocol(manifest.protocol);
  const nowMs = dependencies.nowMs ?? Date.now();
  if (manifest.createdAtMs > nowMs || (manifest.protocol.mode === "PROSPECTIVE"
    && manifest.createdAtMs >= manifest.protocol.startMs)) throw new Error("INVALID_STUDY_SEAL_TIME");
  const actual = await hashStudySources(dependencies.sourceRoot ?? defaultSourceRoot());
  if (stringify(actual) !== stringify(manifest.sourceHashes)) throw new Error("STUDY_SOURCE_HASH_MISMATCH");
  const seed = await stableJson(join(dirname(file.path), manifest.seedFile));
  if (seed.sha256 !== manifest.seedSha256) throw new Error("STUDY_SEED_HASH_MISMATCH");
  const verified = validateSeed(seed.value, manifest.protocol.mode, Math.min(manifest.createdAtMs, manifest.protocol.startMs - 1));
  if (stringify(verified.costs) !== stringify(manifest.protocol.costs) || stringify(verified.assets) !== stringify(manifest.protocol.assets))
    throw new Error("STUDY_SEED_CONFIGURATION_MISMATCH");
  return { manifest, samples: verified.samples, latestSeedCompletionMs: verified.latestCompletedAtMs,
    protocolSha256: file.sha256, protocolPath: file.path };
}

export async function hashStudySources(root: string): Promise<Record<string, string>> {
  const relativePaths: string[] = [];
  async function walk(relative: string): Promise<void> {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) relativePaths.push(path);
      else if (entry.isSymbolicLink()) throw new Error("STUDY_SOURCE_SYMLINK");
    }
  }
  await walk("src");
  if (!relativePaths.length) throw new Error("STUDY_SOURCES_REQUIRED");
  relativePaths.push("package.json", "package-lock.json"); relativePaths.sort();
  const hashes: Record<string, string> = {};
  for (const relative of relativePaths) {
    const before = await stat(join(root, relative)), bytes = await readFile(join(root, relative));
    await unchanged(join(root, relative), before); hashes[relative] = sha(bytes);
  }
  return hashes;
}
function defaultSourceRoot(): string {
  const candidate = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  return candidate.endsWith("/dist") ? dirname(candidate) : candidate;
}
async function defaultEngine(protocol: StudyProtocol, samples: DistributionSample[]): Promise<StudyRunner> {
  const { StudyEngine } = await import("./study.js"); return new StudyEngine(protocol, samples);
}

export async function replayStudy(options: Extract<StudyCliOptions, { command: "replay" }>, dependencies: RunDependencies = {}) {
  const nowMs = dependencies.nowMs ?? Date.now(), loaded = await readStudyManifest(options.protocol, dependencies);
  const { protocol } = loaded.manifest;
  if (protocol.mode === "PROSPECTIVE" && nowMs < protocol.endMs) throw new Error("PROSPECTIVE_REPLAY_REQUIRES_CLOSED_ENDPOINT");
  if (!options.inputs.length) throw new Error("STUDY_REPLAY_INPUT_REQUIRED");
  const output = resolve(options.out), auditOutput = `${output}.audit.jsonl.gz`, auditPartial = `${auditOutput}.partial`;
  await requireAbsent(output); await requireAbsent(auditOutput); await requireAbsent(auditPartial);
  const inputs: Array<{ path: string; before: Stats }> = [];
  for (const source of options.inputs) {
    const path = resolve(source), before = await stat(path);
    if (!before.isFile() || !before.size) throw new Error("INVALID_STUDY_INPUT_FILE");
    if (inputs.some(input => input.path === path || (input.before.dev === before.dev && input.before.ino === before.ino)))
      throw new Error("DUPLICATE_STUDY_INPUT");
    inputs.push({ path, before });
  }
  const engine = await (dependencies.engineFactory ?? defaultEngine)(protocol, loaded.samples);
  const inputFiles: Array<{ path: string; bytes: number; sha256: string }> = [];
  await mkdir(dirname(output), { recursive: true });
  const auditFile = await open(auditPartial, "wx", 0o600);
  let auditBuffer = "", auditBytes = 0, auditRecords = 0, auditHash = "0".repeat(64);
  const flushAudit = async () => {
    if (!auditBuffer) return;
    await auditFile.writeFile(gzipSync(auditBuffer)); auditBuffer = ""; auditBytes = 0;
  };
  const drainAudit = async () => {
    for (const record of engine.drainAudit()) {
      const payload = { sequence: ++auditRecords, previousHash: auditHash, record };
      auditHash = sha(stringify(payload));
      const line = `${stringify({ ...payload, hash: auditHash })}\n`, bytes = Buffer.byteLength(line);
      if (bytes > MAX_AUDIT_BUFFER_BYTES) throw new Error("STUDY_AUDIT_RECORD_LIMIT");
      auditBuffer += line; auditBytes += bytes;
      if (auditBytes >= 512 * 1024) await flushAudit();
    }
  };
  let eventsRead = 0, excludedAfterEnd = 0, firstMs: number | null = null, lastMs: number | null = null;
  try {
    for (const input of inputs) {
      const hash = createHash("sha256"); let bytes = 0;
      for await (const event of readEvents(input.path, chunk => { hash.update(chunk); bytes += chunk.length; })) {
        eventsRead++;
        if (event.kind === "PRIVATE" || (event.kind === "DISCONNECT" && event.stream === "private")) continue;
        const atMs = eventTimestamp(event);
        if (atMs > nowMs) throw new Error("STUDY_FUTURE_SOURCE_EVENT");
        if (protocol.mode === "PROSPECTIVE" && atMs < loaded.manifest.createdAtMs) throw new Error("STUDY_SOURCE_PREDATES_SEAL");
        if (atMs <= loaded.latestSeedCompletionMs) throw new Error("STUDY_SEED_OVERLAPS_SOURCE_EVENTS");
        if (atMs >= protocol.endMs) { excludedAfterEnd++; continue; }
        firstMs ??= atMs; lastMs = Math.max(lastMs ?? atMs, atMs);
        engine.onEvent(event); await drainAudit();
      }
      await unchanged(input.path, input.before);
      if (bytes !== input.before.size) throw new Error("STUDY_INPUT_SIZE_CHANGED");
      inputFiles.push({ path: input.path, bytes, sha256: hash.digest("hex") });
    }
    if (lastMs === null) throw new Error("STUDY_PUBLIC_SOURCE_EVENTS_REQUIRED");
    engine.finish(protocol.endMs, "REPLAY_END"); await drainAudit();
    for (const input of inputs) await unchanged(input.path, input.before);
    await readStudyManifest(options.protocol, dependencies);
    await flushAudit();
    if (!auditRecords) await auditFile.writeFile(gzipSync(""));
    await auditFile.sync();
  } finally { await auditFile.close(); }
  await link(auditPartial, auditOutput); await unlink(auditPartial); await syncDirectory(dirname(auditOutput));
  const report = { manifest: loaded.manifest, protocolSha256: loaded.protocolSha256,
    execution: "RECORDED_EVENT_REPLAY", source: { inputFiles, eventsRead, firstMs, lastMs, excludedAfterEnd },
    report: engine.report(), audit: { records: auditRecords, finalHash: auditHash, file: auditOutput,
      format: "CONCATENATED_GZIP_HASH_CHAIN_NDJSON" }, brokerOrdersSubmitted: 0, profitabilityEstablished: false };
  const content = `${stringify(report, true)}\n`; await atomicCreate(output, content);
  return { output, sha256: sha(content), report };
}

interface PublicStream extends EventEmitter { connect(): void; close(): void }
interface LiveDependencies extends Omit<RunDependencies, "nowMs"> {
  now?: () => number; streamFactory?: (source: KrakenFuturesMarketStreamConfig) => PublicStream;
  tickMs?: number; abortSignal?: AbortSignal; installSignalHandlers?: boolean;
}

/** This process owns an independent PUBLIC connection and no order interface.
 * It refuses late starts and existing run directories. Recovery cannot quietly
 * replace missing forward observations with a replay of inspected outcomes. */
export async function runLiveStudy(options: Extract<StudyCliOptions, { command: "live" }>, dependencies: LiveDependencies = {}) {
  const now = dependencies.now ?? Date.now, startedAtMs = now();
  const fileDependencies: FileDependencies = { nowMs: startedAtMs,
    ...(dependencies.sourceRoot ? { sourceRoot: dependencies.sourceRoot } : {}) };
  const loaded = await readStudyManifest(options.protocol, fileDependencies), { protocol } = loaded.manifest;
  if (protocol.mode !== "PROSPECTIVE") throw new Error("LIVE_REQUIRES_PROSPECTIVE_STUDY");
  if (startedAtMs >= protocol.startMs) throw new Error("STUDY_LIVE_START_MUST_PRECEDE_ENDPOINT_START");
  if (loaded.latestSeedCompletionMs >= startedAtMs) throw new Error("STUDY_SEED_OVERLAPS_LIVE_START");
  const engine = await (dependencies.engineFactory ?? defaultEngine)(protocol, loaded.samples);
  const output = resolve(options.out);
  await mkdir(dirname(output), { recursive: true }); await mkdir(output, { mode: 0o700 });
  await syncDirectory(dirname(output));
  await exclusiveWrite(join(output, "run.started.json"), `${stringify({ version: manifestVersion,
    protocolSha256: loaded.protocolSha256, protocolPath: loaded.protocolPath, startedAtMs, pid: process.pid,
    automaticResumePermitted: false, brokerOrdersSubmitted: 0 }, true)}\n`, 0o400);
  const auditFile = await open(join(output, "audit.jsonl.gz"), "wx", 0o600);
  await syncDirectory(output);
  const stream = (dependencies.streamFactory ?? (config => new KrakenFuturesMarketStream(config)))(loaded.manifest.source);
  let stopped = false, stopReason: string | null = null, failure: string | null = null;
  let sequence = 0, chain = "0".repeat(64), buffer = "", bufferedBytes = 0, queuedBytes = 0;
  let persistedSequence = 0, persistedChain = chain, lastSaveAtMs = startedAtMs;
  let queue: Promise<void> = Promise.resolve();
  const auditRow = (record: unknown) => {
    const payload = { sequence: ++sequence, previousHash: chain, record };
    chain = sha(stringify(payload));
    const line = `${stringify({ ...payload, hash: chain })}\n`;
    buffer += line; bufferedBytes += Buffer.byteLength(line);
    if (bufferedBytes + queuedBytes > MAX_AUDIT_BUFFER_BYTES) throw new Error("STUDY_AUDIT_BUFFER_LIMIT");
  };
  const drain = () => { for (const row of engine.drainAudit()) auditRow(row); };
  const snapshot = (state: string) => ({ version: manifestVersion, state, protocolSha256: loaded.protocolSha256,
    protocol: loaded.manifest.protocol, source: loaded.manifest.source, reproducibility: loaded.manifest.reproducibility,
    startedAtMs, updatedAtMs: now(), stopReason, failure,
    audit: { records: persistedSequence, finalHash: persistedChain, file: "audit.jsonl.gz" },
    report: engine.report(), brokerOrdersSubmitted: 0, profitabilityEstablished: false });
  let requestStop: (reason: string, error?: unknown) => void = () => {};
  const persist = (state: string) => {
    drain();
    const bytes = buffer, bytesLength = bufferedBytes, through = sequence, throughHash = chain;
    buffer = ""; bufferedBytes = 0; queuedBytes += bytesLength;
    // Serialize the engine snapshot now, before subsequent events can mutate it.
    const report = snapshot(state);
    report.audit = { records: through, finalHash: throughHash, file: "audit.jsonl.gz" };
    const content = `${stringify(report, true)}\n`;
    const next = queue.then(async () => {
      try {
        if (bytes) { await auditFile.writeFile(gzipSync(bytes)); await auditFile.sync(); }
        persistedSequence = through; persistedChain = throughHash;
        await atomicReplace(join(output, "report.json"), content);
      } finally { queuedBytes -= bytesLength; }
    });
    queue = next;
    void next.catch(error => requestStop("AUDIT_OR_REPORT_WRITE_FAILED", error));
    return next;
  };
  await new Promise<void>((resolveRun, rejectRun) => {
    const cleanSignals = () => {
      if (dependencies.installSignalHandlers !== false) { process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted); }
      dependencies.abortSignal?.removeEventListener("abort", aborted);
    };
    const timer = setInterval(() => {
      try {
        if (now() >= protocol.endMs) { requestStop("STUDY_ENDPOINT"); return; }
        if (now() - lastSaveAtMs >= 60_000) { lastSaveAtMs = now(); void persist("RUNNING"); }
      } catch (error) { requestStop("RUNNER_ERROR", error); }
    }, dependencies.tickMs ?? 1_000);
    requestStop = (reason, error) => {
      if (stopped) return;
      stopped = true; stopReason = reason; failure = error instanceof Error ? error.message : error === undefined ? null : String(error);
      clearInterval(timer); cleanSignals(); stream.close();
      const state = error !== undefined ? "FAILED" : reason === "STUDY_ENDPOINT" ? "FINISHED" : "INTERRUPTED";
      try { engine.finish(Math.min(now(), protocol.endMs), reason === "STUDY_ENDPOINT" ? "STUDY_END" : reason); }
      catch (finishError) { failure ??= finishError instanceof Error ? finishError.message : String(finishError); }
      void (async () => {
        try { auditRow({ kind: "RUN_STOP", atMs: now(), reason, failure }); await persist(failure ? "FAILED" : state); }
        catch (writeError) {
          // A failed append cannot be hidden by publishing a complete study.
          failure ??= writeError instanceof Error ? writeError.message : String(writeError);
          try { await atomicReplace(join(output, "report.json"), `${stringify(snapshot("FAILED"), true)}\n`); } catch { /* disk failure remains fatal */ }
        } finally { await auditFile.close().catch(() => {}); }
        if (failure) rejectRun(new Error(failure)); else resolveRun();
      })();
    };
    const interrupted = () => requestStop("PROCESS_INTERRUPTED");
    const aborted = () => requestStop("PROCESS_INTERRUPTED");
    if (dependencies.installSignalHandlers !== false) { process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted); }
    dependencies.abortSignal?.addEventListener("abort", aborted, { once: true });
    const consume = (event: RecordedEvent) => {
      if (stopped) return;
      try {
        if (now() >= protocol.endMs) { requestStop("STUDY_ENDPOINT"); return; }
        const atMs = eventTimestamp(event);
        if (atMs > now()) throw new Error("STUDY_FUTURE_SOURCE_EVENT");
        if (atMs <= loaded.latestSeedCompletionMs) throw new Error("STUDY_SEED_OVERLAPS_SOURCE_EVENTS");
        engine.onEvent(event); drain();
        if (bufferedBytes >= 512 * 1024) void persist("RUNNING");
      } catch (error) { requestStop("SOURCE_OR_ENGINE_ERROR", error); }
    };
    stream.on("book", (delta: BookDelta) => consume({ kind: "BOOK", delta }));
    stream.on("trade", (trade: MarketTrade) => consume({ kind: "TRADE", trade }));
    stream.on("disconnect", () => consume({ kind: "DISCONNECT", receiveTsMs: now(), stream: "public" }));
    stream.on("streamError", (error: unknown) => {
      if (stopped) return;
      try { auditRow({ kind: "PUBLIC_STREAM_ERROR", atMs: now(), error: error instanceof Error ? error.message : String(error) }); }
      catch (auditError) { requestStop("AUDIT_BUFFER_ERROR", auditError); }
    });
    try {
      auditRow({ kind: "RUN_START", atMs: startedAtMs, protocolSha256: loaded.protocolSha256 });
      void persist("RUNNING");
      if (dependencies.abortSignal?.aborted) aborted(); else stream.connect();
    } catch (error) { requestStop("STARTUP_ERROR", error); }
  });
  return { output, reportPath: join(output, "report.json"), stopReason, auditRecords: persistedSequence, auditFinalHash: persistedChain };
}

function eventTimestamp(event: RecordedEvent): number {
  const value = event?.kind === "BOOK" ? event.delta?.receiveTsMs : event?.kind === "TRADE" ? event.trade?.receiveTsMs
    : event?.kind === "DISCONNECT" || event?.kind === "RECORDER_GAP" ? event.receiveTsMs : null;
  if (!Number.isSafeInteger(value) || value === null || value < 0) throw new Error("INVALID_STUDY_EVENT_TIMESTAMP");
  return value;
}
async function stableJson(source: string) {
  const path = resolve(source), before = await stat(path);
  if (!before.isFile() || before.size > 64 * 1024 * 1024) throw new Error("INVALID_STUDY_METADATA_FILE");
  const bytes = await readFile(path); await unchanged(path, before);
  return { path, value: JSON.parse(bytes.toString("utf8")) as unknown, sha256: sha(bytes), bytes };
}
async function unchanged(path: string, before: Stats) {
  const after = await stat(path);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error(`STUDY_INPUT_CHANGED:${path}`);
}
async function requireAbsent(path: string) {
  try { await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error("STUDY_OUTPUT_EXISTS");
}
async function exclusiveWrite(path: string, bytes: string | Buffer, mode: number) {
  const file = await open(path, "wx", mode);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function atomicCreate(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await exclusiveWrite(temporary, content, 0o600);
  try { await link(temporary, path); } finally { await unlink(temporary); }
  await syncDirectory(dirname(path));
}
async function atomicReplace(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await exclusiveWrite(temporary, content, 0o600);
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  await syncDirectory(dirname(path));
}
async function syncDirectory(path: string) {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function* readEvents(path: string, onBytes: (bytes: Buffer) => void): AsyncGenerator<RecordedEvent> {
  const source = createReadStream(path), output = new PassThrough();
  const hashing = new Transform({ transform(bytes: Buffer, _encoding, done) { onBytes(bytes); done(null, bytes); } });
  const decoder = path.toLowerCase().endsWith(".gz") ? createGunzip() : new PassThrough();
  const lines = createInterface({ input: output, crlfDelay: Infinity });
  let failure: unknown;
  const running = pipeline(source, hashing, decoder, output).catch(error => { failure = error; });
  try {
    for await (const line of lines) if (line.trim()) yield JSON.parse(line) as RecordedEvent;
    await running; if (failure) throw failure;
  } finally {
    lines.close(); source.destroy(); hashing.destroy(); decoder.destroy(); output.destroy(); await running;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const options = parseStudyArgs(process.argv.slice(2));
  const result = options.command === "freeze" || options.command === "prepare-development" ? await freezeStudy(options)
    : options.command === "replay" ? await replayStudy(options)
      : options.command === "live" ? await runLiveStudy(options) : null;
  if (!result) throw new Error("INVALID_STUDY_COMMAND");
  process.stdout.write(`${stringify({ ...result, ...("report" in result ? { report: undefined } : {}),
    ...("manifest" in result ? { manifest: undefined } : {}) }, true)}\n`);
}
