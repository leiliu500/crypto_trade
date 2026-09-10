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
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SPEC, DISTRIBUTION_ENTRY_PROFILES } from "./spec.js";
import { EFFICIENT_TRAINING_SPEC } from "./efficient-trainer.js";
import { assertRiskBoundedTrainingContext, RISK_TRAINING_VERSION, RiskTrainingFeaturePath,
  trainingContextHash, type RiskBoundedTrainingContext } from "./risk-training-context.js";
import type { DistributionSizingContext } from "./sizing.js";
import type { BookState } from "../core/market.js";
import { readRiskTrainingSourceHashes, type RiskTrainingSourceHash } from "./risk-training-source.js";
import { packRiskTrainingOrigins, readRiskTrainingOrigins } from "./risk-training-origins.js";

export interface RiskTrainingOrigin {
  symbol: string; signalAtMs: number; requestedQty: number; referenceBid: number; referenceAsk: number;
  sizingPolicyId: string; quoteSequence: string; book: Omit<BookState, "sequence"> & { sequence: string };
  features: number[]; sizingContext: DistributionSizingContext; originSha256: string;
}

export interface DistributionTrainingOptions {
  cutoffMs: number;
  initialState?: unknown;
  riskContext?: RiskBoundedTrainingContext;
}
export interface DistributionTrainingFileOptions {
  cutoffMs: number;
  stateIn?: string;
  instrumentRuleSource?: string;
  onProgress?: (progress: { events: number; atMs: number | null; file: string }) => void;
  riskContext?: RiskBoundedTrainingContext;
  sourceCodeHashes?: readonly RiskTrainingSourceHash[];
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

/** Preserve size and independent-action identities while removing all selection
 * claims and unresolved paths. Unlike v1, this must never strip sizing metadata. */
export function riskBoundedTrainingOnlyState(value: unknown) {
  const input = value as ReturnType<DistributionController["exportState"]>;
  if (!input?.sizingPolicy || !input.sizingPolicyId || input.trainingPolicyVersion !== EFFICIENT_TRAINING_SPEC.version
    || !input.efficientTraining || input.efficientTraining.pendingOrigins.length)
    throw new Error("INVALID_RISK_TRAINING_STATE");
  return structuredClone({ ...input, validationSelections: [], pendingSelections: [], nextProposals: {}, nextEvaluations: {},
    selectedSlotUntilMs: null, counters: { evaluations: 0, proposals: 0, selected: 0,
      completePanels: 0, invalidPanels: 0, invalidSelected: 0 } });
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
  const riskContext = options.riskContext;
  if (riskContext) assertRiskBoundedTrainingContext(riskContext);
  const profile = riskContext ? DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL_EFFICIENT : undefined;
  const controller = new DistributionController(costs, structuredClone(assets), profile,
    riskContext ? { efficientTraining: true, sizingPolicy: riskContext.sizingPolicy } : {});
  if (!riskContext && (options.initialState as { sizingPolicy?: unknown } | undefined)?.sizingPolicy)
    throw new Error("LEGACY_TRAINING_CANNOT_STRIP_RISK_SIZING");
  const initial = options.initialState === undefined ? undefined : riskContext
    ? riskBoundedTrainingOnlyState(options.initialState) : distributionTrainingOnlyState(options.initialState);
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
  const featurePath = riskContext ? new RiskTrainingFeaturePath(riskContext) : undefined;
  const origins = new Map<string, RiskTrainingOrigin>();
  // Resumed v2 labels retain their original authenticated sizing contexts.
  if (riskContext && options.initialState) {
    const provenance = (options.initialState as { trainingBackfill?: Record<string, unknown> & { origins?: RiskTrainingOrigin[] } }).trainingBackfill;
    if (!provenance || trainingContextHash(provenance.riskContext) !== trainingContextHash(riskContext)
      || provenance.riskContextSha256 !== trainingContextHash(riskContext)
      || provenance.version !== RISK_TRAINING_VERSION || provenance.trainingOnly !== true
      || provenance.prospectiveSelectionsCreated !== 0 || provenance.brokerOrdersSubmitted !== 0
      || provenance.profitabilityEstablished !== false || provenance.deploymentReady !== false
      || provenance.observedFundingCashIncluded !== false
      || trainingContextHash(provenance.spec) !== trainingContextHash(DISTRIBUTION_SPEC)
      || trainingContextHash(provenance.trainingSpec) !== trainingContextHash(EFFICIENT_TRAINING_SPEC)
      || trainingContextHash(provenance.costs) !== trainingContextHash(costs)
      || trainingContextHash(provenance.assets) !== trainingContextHash(assets)
      || trainingContextHash(provenance.sourceCodeHashes) !== trainingContextHash(readRiskTrainingSourceHashes())
      || provenance.sourceCodeSha256 !== trainingContextHash(provenance.sourceCodeHashes))
      throw new Error("RISK_TRAINING_RESUME_PROVENANCE_MISMATCH");
    const resumedOrigins = readRiskTrainingOrigins(provenance);
    if (provenance.originsSha256 !== trainingContextHash(resumedOrigins)) throw new Error("RISK_TRAINING_RESUME_PROVENANCE_MISMATCH");
    for (const origin of resumedOrigins) origins.set(`${origin.symbol}:${origin.signalAtMs}`, structuredClone(origin));
  }
  const replayController = riskContext ? {
    onTrade: controller.onTrade.bind(controller), invalidate: controller.invalidate.bind(controller),
    stats: controller.stats.bind(controller), drainSelections: controller.drainSelections.bind(controller),
    onBook: (book: BookState, asset?: AssetRules, sizingContext?: DistributionSizingContext) => {
      const result = controller.onBook(book, asset, sizingContext), d = result.trainingDecision;
      if (d) {
        if (!sizingContext) throw new Error("RISK_TRAINING_ORIGIN_CONTEXT_MISSING");
        const body = { symbol: d.symbol, signalAtMs: d.atMs, requestedQty: d.requestedQty,
          referenceBid: d.referenceBid, referenceAsk: d.referenceAsk, sizingPolicyId: riskContext.sizingPolicyId,
          quoteSequence: d.quoteSequence, features: [...d.features], book: { ...book, sequence: String(book.sequence) },
          sizingContext: structuredClone(sizingContext) };
        origins.set(`${d.symbol}:${d.atMs}`, { ...structuredClone(body), originSha256: trainingContextHash(body) });
      }
      return result;
    },
  } : controller;
  const replay = await replayDistribution(causalEvents(), costs, assets,
    { validationStartMs: cutoffMs + 1, laterStartMs: cutoffMs + 2,
      ...(featurePath ? { sizingContext: featurePath, independentTrainingActions: true } : {}) }, replayController);
  if (!publicEvents) throw new Error("TRAINING_PUBLIC_HISTORY_REQUIRED");
  const historicalSelectionsDiscarded = controller.exportState().validationSelections.length;
  const state = riskContext ? riskBoundedTrainingOnlyState(controller.exportState()) : distributionTrainingOnlyState(controller.exportState());
  const verified = new DistributionController(costs, structuredClone(assets), profile,
    riskContext ? { efficientTraining: true, sizingPolicy: riskContext.sizingPolicy } : {});
  verified.restoreState(state, cutoffMs);
  const learning = verified.stats(cutoffMs);
  const retainedDays = [...new Set(state.samples.map(s => new Date(s.signalAtMs).toISOString().slice(0, 10)))].sort();
  const originIds = new Set(state.samples.map(s => `${s.symbol}:${s.signalAtMs}`));
  const retainedOrigins = [...origins.values()].filter(origin => originIds.has(`${origin.symbol}:${origin.signalAtMs}`))
    .sort((a, b) => a.signalAtMs - b.signalAtMs || a.symbol.localeCompare(b.symbol));
  if (riskContext && retainedOrigins.length !== originIds.size) throw new Error("RISK_TRAINING_ORIGIN_AUDIT_MISSING");
  const report = { version: riskContext ? RISK_TRAINING_VERSION : `${DISTRIBUTION_SPEC.version}:training-backfill-v1`, cutoffMs,
    trainingOnly: true, prospectiveSelectionsCreated: 0, historicalSelectionsDiscarded,
    brokerOrdersSubmitted: 0, deploymentReady: false, profitabilityEstablished: false,
    restoredSamples, retainedSamples: state.samples.length,
    rawCompletePanels: riskContext ? null : replay.completeCommonOpportunities,
    rawExcludedPanels: riskContext ? null : replay.incompleteOrInvalidOpportunities,
    retainedPanels: riskContext ? null : state.samples.length / DISTRIBUTION_ACTIONS.length, retainedDays,
    futureEventsExcluded, ignoredPrivateEvents, quality: replay.quality,
    decisionReasons: replay.decisionReasons, sampleInvalidReasons: replay.sampleInvalidReasons,
    learning: learning.learning, validation: learning.validation,
    costs, assets, spec: DISTRIBUTION_SPEC,
    ...(riskContext ? { riskContext: structuredClone(riskContext), riskContextSha256: trainingContextHash(riskContext),
      sizingPolicyId: riskContext.sizingPolicyId, trainingSpec: EFFICIENT_TRAINING_SPEC,
      retainedActionLabels: state.samples.length, origins: retainedOrigins,
      rawCompleteActions: replay.independentCompleteActions, rawExcludedActions: replay.independentInvalidActions,
      originsSha256: trainingContextHash(retainedOrigins), originCount: retainedOrigins.length,
      accountContext: "FIXED_DECLARED_COUNTERFACTUAL_REFERENCE_NOT_HISTORICAL_ACCOUNT_EQUITY",
      observedFundingCashIncluded: false, liveMarketHistoryRestored: false,
      labelInterpretation: "RAW_BOOK_COUNTERFACTUAL_EXECUTION_AFTER_FEES_AND_FIXED_RESERVE;NOT_REAL_FILLS_OR_PROFIT_EVIDENCE" } : {}),
    assumptions: [
      "Only full recorded order books and trades drive the unchanged causal controller; every execution update is retained",
      riskContext ? "Each independent 5/15/30-minute action requires all three execution scenarios; incomplete paths are excluded under the unchanged efficient trainer"
        : "Each admitted training panel has all six prespecified actions and all three execution scenarios; missing paths exclude the whole panel",
      "A resumed model contains only outcomes completed before every event in the new input; overlapping or reversed archive order cannot be used to preload future labels",
      "Replay selections are discarded; historical training is not prospective live validation and cannot grant order permission",
      "Configured fees, execution reserve and supplied instrument rules apply; instrument rules are not automatically historical snapshots",
      "The bounded training state still requires adequate conditional sample support, UTC dates, fresh data, a positive robust score and the configured profile's validation rules",
      "No live model installation, broker calls or profit claims are made by preparation",
    ] };
  return { state, report };
}

/** Write a new immutable checkpoint-compatible artifact, never replacing inputs
 * or the running model. Hash compressed bytes during their actual replay. */
export async function prepareDistributionTraining(files: readonly string[], out: string,
  costs: DistributionCosts, assets: Readonly<Record<string, AssetRules>>, options: DistributionTrainingFileOptions) {
  if (!files.length) throw new Error("TRAINING_INPUT_REQUIRED");
  if (options.riskContext && (!options.sourceCodeHashes?.length || options.sourceCodeHashes.some(row =>
    !row || typeof row.path !== "string" || !row.path || !/^[a-f0-9]{64}$/.test(row.sha256))))
    throw new Error("RISK_TRAINING_SOURCE_CODE_HASHES_REQUIRED");
  if (options.riskContext && trainingContextHash(options.sourceCodeHashes) !== trainingContextHash(readRiskTrainingSourceHashes()))
    throw new Error("RISK_TRAINING_SOURCE_CODE_MISMATCH");
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
    if (content.length > 64 * 1024 * 1024) throw new Error("TRAINING_ARTIFACT_EXCEEDS_IMPORT_LIMIT");
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
    { cutoffMs: options.cutoffMs, ...(initialState === undefined ? {} : { initialState }),
      ...(options.riskContext ? { riskContext: options.riskContext } : {}) });
  for (const [path, before] of inputStats) {
    const after = await stat(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || after.ino !== before.ino || after.dev !== before.dev) throw new Error(`TRAINING_INPUT_CHANGED:${path}`);
  }
  const { origins: originRows, ...packedReport } = built.report;
  const provenance = { ...(options.riskContext ? packedReport : built.report), inputFiles, stateInput,
    ...(options.riskContext ? { sourceCodeHashes: structuredClone(options.sourceCodeHashes ?? []),
      sourceCodeSha256: trainingContextHash(options.sourceCodeHashes ?? []), originsPacked: packRiskTrainingOrigins(originRows ?? []) } : {}),
    instrumentRuleSource: options.instrumentRuleSource ?? "Explicit supplied rules; verify historical applicability",
    instrumentRulesSha256: createHash("sha256").update(JSON.stringify(assets)).digest("hex") };
  const artifact = { ...built.state, trainingBackfill: provenance };
  const content = `${JSON.stringify(artifact)}\n`;
  if (Buffer.byteLength(content) > 64 * 1024 * 1024) throw new Error("TRAINING_ARTIFACT_EXCEEDS_IMPORT_LIMIT");
  if (options.riskContext && trainingContextHash(options.sourceCodeHashes) !== trainingContextHash(readRiskTrainingSourceHashes()))
    throw new Error("RISK_TRAINING_SOURCE_CODE_CHANGED_DURING_REPLAY");
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
