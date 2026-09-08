import { createReadStream, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import type { RecordedEvent } from "../backtest/replay.js";
import type { AssetRules } from "../execution/planner.js";
import { DistributionController, type DistributionCosts } from "./controller.js";
import { replayDistribution } from "./replay.js";
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SPEC } from "./spec.js";

export interface DistributionTrainingOptions {
  cutoffMs: number;
  initialState?: unknown;
}
export interface DistributionTrainingFileOptions {
  cutoffMs: number;
  stateIn?: string;
  instrumentRuleSource?: string;
  onProgress?: (progress: { events: number; atMs: number | null; file: string }) => void;
}

/** History supplies training labels only. It can never supply prospective live
 * validation, pending selections, proposal clocks or broker permissions. */
export function distributionTrainingOnlyState(value: unknown) {
  const input = value as ReturnType<DistributionController["exportState"]>;
  if (!input || typeof input !== "object") throw new Error("INVALID_DISTRIBUTION_TRAINING_STATE");
  return structuredClone({ version: input.version, selectionPolicyVersion: DISTRIBUTION_SPEC.selectionPolicyVersion,
    costs: input.costs, samples: input.samples,
    validationSelections: [], pendingSelections: [], nextProposals: {}, nextEvaluations: {}, selectedSlotUntilMs: null,
    counters: { evaluations: 0, proposals: 0, selected: 0, completePanels: 0, invalidPanels: 0, invalidSelected: 0 } });
}

/** Causal training from the same raw-event controller as the running engine.
 * No candles, synthetic depth, downsampling, parameter search or order API. */
export async function buildDistributionTraining(
  events: AsyncIterable<RecordedEvent> | Iterable<RecordedEvent>, costs: DistributionCosts,
  assets: Readonly<Record<string, AssetRules>>, options: DistributionTrainingOptions,
) {
  const { cutoffMs } = options;
  if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0 || cutoffMs > Number.MAX_SAFE_INTEGER - 2)
    throw new Error("INVALID_TRAINING_CUTOFF");
  for (const symbol of DISTRIBUTION_SPEC.symbols) {
    const rules = assets[symbol];
    if (!rules || rules.symbol !== symbol || ![rules.minOrderSize, rules.minTradeIncrement,
      rules.priceIncrement, rules.maximumOrderQty].every(n => Number.isFinite(n) && n > 0)
      || typeof rules.shortable !== "boolean") throw new Error(`INVALID_TRAINING_INSTRUMENT:${symbol}`);
  }
  const controller = new DistributionController(costs, structuredClone(assets));
  const initial = options.initialState === undefined ? undefined : distributionTrainingOnlyState(options.initialState);
  const restoredSamples = initial ? controller.restoreState(initial, cutoffMs) : 0;
  const initialCompletedMs = initial?.samples.reduce((last, sample) => Math.max(last, sample.completedAtMs), -Infinity) ?? -Infinity;
  let started = false, publicEvents = 0, futureEventsExcluded = 0, ignoredPrivateEvents = 0;
  async function* causalEvents() {
    for await (const event of events) {
      if (!event || typeof event !== "object") throw new Error("INVALID_RECORDED_EVENT");
      if (event.kind === "PRIVATE") { ignoredPrivateEvents++; continue; }
      if (!["BOOK", "TRADE", "DISCONNECT", "RECORDER_GAP"].includes(event.kind))
        throw new Error("INVALID_RECORDED_EVENT_KIND");
      const now = event.kind === "BOOK" ? event.delta?.receiveTsMs
        : event.kind === "TRADE" ? event.trade?.receiveTsMs : event.receiveTsMs;
      if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_RECORDED_TIMESTAMP");
      if (now > cutoffMs) { futureEventsExcluded++; continue; }
      if (event.kind === "DISCONNECT") {
        if (event.stream === "private") { ignoredPrivateEvents++; continue; }
        if (event.stream !== "public") throw new Error("INVALID_RECORDED_DISCONNECT_STREAM");
      }
      // Buffered public streams can interleave, so enforce this against every
      // timestamp, not just the first line or the supplied deployment cutoff.
      if (initialCompletedMs > now) throw new Error("TRAINING_STATE_OVERLAPS_REPLAY_HISTORY");
      if (!started) {
        if (initial) controller.restoreState(initial, now);
        started = true;
      }
      publicEvents++;
      yield event;
    }
  }
  // The generic replay's reporting boundaries are beyond all admitted events.
  // This command makes no validation-period or untouched-holdout assessment.
  const replay = await replayDistribution(causalEvents(), costs, assets,
    { validationStartMs: cutoffMs + 1, laterStartMs: cutoffMs + 2 }, controller);
  if (!publicEvents) throw new Error("TRAINING_PUBLIC_HISTORY_REQUIRED");
  const historicalSelectionsDiscarded = controller.exportState().validationSelections.length;
  const state = distributionTrainingOnlyState(controller.exportState());
  const verified = new DistributionController(costs, structuredClone(assets));
  verified.restoreState(state, cutoffMs);
  const learning = verified.stats(cutoffMs);
  const retainedDays = [...new Set(state.samples.map(s => new Date(s.signalAtMs).toISOString().slice(0, 10)))].sort();
  const report = { version: `${DISTRIBUTION_SPEC.version}:training-backfill-v1`, cutoffMs,
    trainingOnly: true, prospectiveSelectionsCreated: 0, historicalSelectionsDiscarded,
    brokerOrdersSubmitted: 0, deploymentReady: false, profitabilityEstablished: false,
    restoredSamples, retainedSamples: state.samples.length,
    rawCompletePanels: replay.completeCommonOpportunities, rawExcludedPanels: replay.incompleteOrInvalidOpportunities,
    retainedPanels: state.samples.length / DISTRIBUTION_ACTIONS.length, retainedDays,
    futureEventsExcluded, ignoredPrivateEvents, quality: replay.quality,
    decisionReasons: replay.decisionReasons, sampleInvalidReasons: replay.sampleInvalidReasons,
    learning: learning.learning, validation: learning.validation,
    costs, assets, spec: DISTRIBUTION_SPEC,
    assumptions: [
      "Only full recorded order books and trades drive the unchanged causal controller; every execution update is retained",
      "Each admitted training panel has all six prespecified actions and all three execution scenarios; missing paths exclude the whole panel",
      "A resumed model contains only outcomes completed before every event in the new input; overlapping or reversed archive order cannot be used to preload future labels",
      "Replay selections are discarded; historical training is not prospective live validation and cannot grant order permission",
      "Configured fees, execution reserve and supplied instrument rules apply; instrument rules are not automatically historical snapshots",
      "The bounded training state still requires adequate conditional sample support, UTC dates, fresh data and independent prospective validation",
      "No live model installation, broker calls or profit claims are made by preparation",
    ] };
  return { state, report };
}

/** Write a new immutable checkpoint-compatible artifact, never replacing inputs
 * or the running model. Hash compressed bytes during their actual replay. */
export async function prepareDistributionTraining(files: readonly string[], out: string,
  costs: DistributionCosts, assets: Readonly<Record<string, AssetRules>>, options: DistributionTrainingFileOptions) {
  if (!files.length) throw new Error("TRAINING_INPUT_REQUIRED");
  const paths = files.map(path => resolve(path)), output = resolve(out);
  if (new Set(paths).size !== paths.length || paths.includes(output) || (options.stateIn && resolve(options.stateIn) === output))
    throw new Error("TRAINING_INPUT_OUTPUT_COLLISION");
  await requireAbsent(output);
  const inputStats = new Map<string, Stats>();
  for (const path of paths) {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`TRAINING_INPUT_NOT_FILE:${path}`);
    if ([...inputStats.values()].some(other => other.dev === info.dev && other.ino === info.ino))
      throw new Error("TRAINING_DUPLICATE_INPUT_INODE");
    inputStats.set(path, info);
  }
  let initialState: unknown;
  let stateInput: { path: string; sha256: string; bytes: number } | null = null;
  if (options.stateIn) {
    const path = resolve(options.stateIn), content = await readFile(path);
    initialState = JSON.parse(content.toString("utf8"));
    stateInput = { path, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length };
  }
  const inputFiles: Array<{ path: string; bytes: number; modifiedMs: number; inode: number; sha256: string }> = [];
  let count = 0, lastProgressMs = Date.now();
  async function* events() {
    for (const path of paths) {
      const hash = createHash("sha256");
      for await (const event of readTrainingEvents(path, chunk => { hash.update(chunk); })) {
        count++;
        if (options.onProgress && Date.now() - lastProgressMs >= 30_000) {
          const atMs = event?.kind === "BOOK" ? event.delta?.receiveTsMs : event?.kind === "TRADE" ? event.trade?.receiveTsMs
            : event?.kind === "PRIVATE" ? null : event?.receiveTsMs;
          options.onProgress({ events: count, atMs: typeof atMs === "number" && Number.isFinite(atMs) ? atMs : null, file: path });
          lastProgressMs = Date.now();
        }
        yield event;
      }
      const info = inputStats.get(path)!;
      inputFiles.push({ path, bytes: info.size, modifiedMs: info.mtimeMs, inode: info.ino, sha256: hash.digest("hex") });
      options.onProgress?.({ events: count, atMs: null, file: path });
      lastProgressMs = Date.now();
    }
  }
  const built = await buildDistributionTraining(events(), costs, assets,
    { cutoffMs: options.cutoffMs, ...(initialState === undefined ? {} : { initialState }) });
  for (const [path, before] of inputStats) {
    const after = await stat(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || after.ino !== before.ino || after.dev !== before.dev) throw new Error(`TRAINING_INPUT_CHANGED:${path}`);
  }
  const provenance = { ...built.report, inputFiles, stateInput,
    instrumentRuleSource: options.instrumentRuleSource ?? "Explicit supplied rules; verify historical applicability",
    instrumentRulesSha256: createHash("sha256").update(JSON.stringify(assets)).digest("hex") };
  const artifact = { ...built.state, trainingBackfill: provenance };
  const content = `${JSON.stringify(artifact)}\n`;
  await atomicCreate(output, content);
  return { state: built.state, artifact, output, report: { ...provenance, stateFile: output,
    stateSha256: createHash("sha256").update(content).digest("hex") } };
}

async function* readTrainingEvents(path: string, onBytes: (chunk: Buffer) => void): AsyncGenerator<RecordedEvent> {
  const source = createReadStream(path), output = new PassThrough();
  const hashing = new Transform({ transform(chunk: Buffer, _encoding, done) { onBytes(chunk); done(null, chunk); } });
  const decoder = path.toLowerCase().endsWith(".gz") ? createGunzip() : new PassThrough();
  const lines = createInterface({ input: output, crlfDelay: Infinity });
  let streamError: unknown;
  const running = pipeline(source, hashing, decoder, output).catch(error => { streamError = error; });
  try {
    for await (const line of lines) if (line.trim()) yield JSON.parse(line) as RecordedEvent;
    await running;
    if (streamError) throw streamError;
  } finally {
    lines.close(); source.destroy(); hashing.destroy(); decoder.destroy(); output.destroy();
    await running;
  }
}

async function requireAbsent(path: string) {
  try { await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error(`TRAINING_OUTPUT_EXISTS:${path}`);
}
async function atomicCreate(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(temporary).catch(() => {}); throw error; }
  await handle.close();
  try {
    // link is atomic and fails if the destination exists, including a symlink.
    await link(temporary, path);
    await unlink(temporary);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
