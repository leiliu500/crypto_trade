import { createHash } from "node:crypto";
import type { RecordedEvent } from "../backtest/replay.js";
import { LocalOrderBook } from "../core/order-book.js";
import type { BookState } from "../core/market.js";
import type { AssetRules } from "../execution/planner.js";
import { DistributionController, type DistributionCosts } from "./controller.js";
import { EfficientDistributionTrainer, EFFICIENT_TRAINING_SPEC } from "./efficient-trainer.js";
import { DistributionExecutionCase } from "./execution.js";
import { ConditionalDistributionModel } from "./model.js";
import { DISTRIBUTION_ACTIONS as ACTIONS, DISTRIBUTION_SCENARIOS as SCENARIOS,
  DISTRIBUTION_SPEC as S, distributionEntryProfile,
  type DistributionDecision, type DistributionSample } from "./spec.js";

const DAY = 86_400_000, GRID = 31 * 60_000;
export const STUDY_POLICIES = ["current", "efficient", "flat", "long-15m", "short-15m", "momentum-15m"] as const;
type Policy = typeof STUDY_POLICIES[number];
type ModelName = "current" | "efficient";
export interface StudyProtocol {
  version: "conditional-study-v1"; startMs: number; endMs: number;
  costs: DistributionCosts; assets: Record<string, AssetRules>;
  minimumTrainingDays: 3; mode: "DEVELOPMENT" | "PROSPECTIVE";
}
interface Path {
  symbol: string; actionId: string; atMs: number; features: number[];
  cases: DistributionExecutionCase[]; forecast?: Forecast[];
}
interface Forecast { scenario: string; current: number | null; efficient: number | null;
  unconditionalCurrent: number | null; unconditionalEfficient: number | null;
  currentEligible: boolean; efficientEligible: boolean; currentSamples: number; efficientSamples: number;
  currentEffectiveSamples: number; efficientEffectiveSamples: number }
interface PolicyRow {
  policy: Policy; symbol: string; scenario: string; evaluations: number; selections: number;
  filled: number; unfilled: number; unknown: number; knownNetBpsSum: number;
  days: Record<string, { filled: number; unknown: number; netBps: number }>;
}
interface ErrorRow { symbol: string; actionId: string; scenario: string; probes: number; unknown: number;
  paired: number; currentEligible: number; efficientEligible: number;
  available: Record<string, number>;
  errors: Record<string, { absolute: number; squared: number }>;
  days: Record<string, { count: number; efficientMinusCurrentSquared: number;
    efficientMinusUnconditionalSquared: number; currentMinusUnconditionalSquared: number }> }
/** Recorded JSON and training banks need no per-value serialization callback.
 * Preserve the original bytes for live events containing BigInt sequences. */
export function studyHash(value: unknown): string {
  let serialized: string;
  try { serialized = JSON.stringify(value); }
  catch (error) {
    // Only retry the native BigInt failure; caller serialization failures and
    // circular structures must retain their original exception behavior.
    if (!(error instanceof TypeError) || error.message !== "Do not know how to serialize a BigInt") throw error;
    serialized = JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? String(item) : item);
  }
  return createHash("sha256").update(serialized).digest("hex");
}
const hash = studyHash;
const dayKey = (atMs: number) => new Date(atMs).toISOString().slice(0, 10);
const freshModel = (rows: DistributionSample[], cutoffMs: number) => {
  const model = new ConditionalDistributionModel();
  const counts = new Map<string, number>();
  const admitted = rows.filter(row => row.completedAtMs < cutoffMs).sort((a, b) => b.signalAtMs - a.signalAtMs)
    .filter(row => { const key = `${row.symbol}:${row.actionId}`, count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count); return count <= S.maximumSamples; }).reverse();
  for (const row of admitted) if (!model.observe(row)) throw new Error("STUDY_INVALID_TRAINING_BANK");
  return { model, admitted };
};
function dailyInterval(values: number[]) {
  if (values.length < 2) return { days: values.length, mean: values[0] ?? null, lower: null, upper: null };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const se = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1) / values.length);
  return { days: values.length, mean, lower: mean - 2.58 * se, upper: mean + 2.58 * se };
}

/** Forward research only. Neither this engine nor its runner can submit orders.
 * Training collectors run continuously; inference banks change only at UTC-day
 * boundaries and admit labels completed strictly before that boundary. */
export class StudyEngine {
  private readonly protocol: StudyProtocol;
  private readonly current: DistributionController;
  private readonly efficient: EfficientDistributionTrainer;
  private readonly seed: DistributionSample[];
  private readonly books = new Map<string, LocalOrderBook>();
  private readonly streamTimes = new Map<string, number>();
  private readonly slots = new Map<Policy, Path>();
  private readonly completedSlots = new Map<Policy, number>();
  private readonly probes = new Map<string, Path[]>();
  private readonly probeBuckets = new Map<string, number>();
  private readonly lastProbeMs = new Map<string, number>();
  private models: Record<ModelName, ConditionalDistributionModel> = {
    current: new ConditionalDistributionModel(), efficient: new ConditionalDistributionModel() };
  private unconditional: Record<ModelName, Map<string, number>> = { current: new Map(), efficient: new Map() };
  private cutoffMs = -1;
  private finishedAtMs: number | null = null;
  private finishReason: string | null = null;
  private readonly rows: PolicyRow[] = [];
  private readonly errors: ErrorRow[] = [];
  private readonly freezes: Array<{ cutoffMs: number; current: { samples: number; latestCompletedMs: number | null; sha256: string };
    efficient: { samples: number; latestCompletedMs: number | null; sha256: string } }> = [];
  private readonly coverage = new Map<string, { count: number; lastSecond: number }>();
  private readonly reasons: Record<string, number> = {};
  private audit: unknown[] = [];
  private readonly trainingQuality: Record<ModelName, { emitted: number; valid: number; invalid: number;
    learned: number; publicationDelayMs: number; byAction: Record<string, { valid: number; invalid: number; learned: number }> }> = {
      current: { emitted: 0, valid: 0, invalid: 0, learned: 0, publicationDelayMs: 0, byAction: {} },
      efficient: { emitted: 0, valid: 0, invalid: 0, learned: 0, publicationDelayMs: 0, byAction: {} } };
  private quality = { events: 0, acceptedBooks: 0, duplicates: 0, invalidBooks: 0,
    disconnects: 0, recorderGaps: 0, timestampReversals: 0, readyEvaluations: 0,
    trainingReadyEvaluations: 0,
    probeOrigins: 0, firstMs: null as number | null, lastMs: null as number | null, sourceHash: "" };

  constructor(protocol: StudyProtocol, seed: DistributionSample[]) {
    if (protocol.version !== "conditional-study-v1" || !Number.isSafeInteger(protocol.startMs)
      || !Number.isSafeInteger(protocol.endMs) || protocol.startMs <= 0 || protocol.endMs <= protocol.startMs
      || protocol.minimumTrainingDays !== 3 || !["DEVELOPMENT", "PROSPECTIVE"].includes(protocol.mode)
      || (protocol.mode === "PROSPECTIVE" && (protocol.startMs % DAY !== 0 || protocol.endMs - protocol.startMs !== 14 * DAY))
      || seed.some(row => row.completedAtMs >= protocol.startMs)) throw new Error("INVALID_STUDY_PROTOCOL_OR_FUTURE_SEED");
    this.protocol = structuredClone(protocol); this.seed = structuredClone(seed);
    freshModel(seed, protocol.startMs);
    this.current = new DistributionController(protocol.costs, structuredClone(protocol.assets), distributionEntryProfile(true));
    this.efficient = new EfficientDistributionTrainer(protocol.costs, protocol.assets, seed, protocol.startMs - 1);
    for (const policy of STUDY_POLICIES) for (const symbol of S.symbols) for (const scenario of SCENARIOS) {
      this.rows.push({ policy, symbol, scenario: scenario.id, evaluations: 0, selections: 0,
        filled: 0, unfilled: 0, unknown: 0, knownNetBpsSum: 0, days: {} });
    }
    for (const symbol of S.symbols) for (const action of ACTIONS) for (const scenario of SCENARIOS) {
      this.errors.push({ symbol, actionId: action.id, scenario: scenario.id, probes: 0, unknown: 0, paired: 0,
        currentEligible: 0, efficientEligible: 0, errors: Object.fromEntries(
          ["current", "efficient", "unconditionalCurrent", "unconditionalEfficient"].map(key => [key, { absolute: 0, squared: 0 }])),
        available: { current: 0, efficient: 0, unconditionalCurrent: 0, unconditionalEfficient: 0 }, days: {} });
    }
  }

  onEvent(event: RecordedEvent): void {
    if (this.finishedAtMs !== null) throw new Error("STUDY_ALREADY_FINISHED");
    this.quality.events++; this.quality.sourceHash = hash([this.quality.sourceHash, event]);
    if (event.kind === "PRIVATE" || (event.kind === "DISCONNECT" && event.stream === "private")) return;
    const now = event.kind === "BOOK" ? event.delta.receiveTsMs : event.kind === "TRADE" ? event.trade.receiveTsMs : event.receiveTsMs;
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("STUDY_INVALID_EVENT_TIME");
    if (this.quality.firstMs === null && this.seed.some(row => row.completedAtMs >= now)) throw new Error("STUDY_SEED_LEAKS_INTO_INPUT");
    this.quality.firstMs ??= now;
    this.quality.lastMs = Math.max(this.quality.lastMs ?? now, now);
    if (now >= this.protocol.endMs) return;
    if (now >= this.protocol.startMs) this.freeze(Math.floor(now / DAY) * DAY);
    const stream = event.kind === "BOOK" ? `BOOK:${event.delta.symbol}` : event.kind === "TRADE" ? `TRADE:${event.trade.symbol}` : null;
    if (stream && now < (this.streamTimes.get(stream) ?? -1)) {
      this.quality.timestampReversals++; this.invalidate(this.quality.lastMs, "TIMESTAMP_REVERSAL"); return;
    }
    if (stream) this.streamTimes.set(stream, now);
    if (event.kind === "DISCONNECT" || event.kind === "RECORDER_GAP") {
      if (event.kind === "DISCONNECT") this.quality.disconnects++; else this.quality.recorderGaps++;
      this.invalidate(now, event.kind); return;
    }
    if (event.kind === "TRADE") { this.current.onTrade(event.trade); return; }
    if (event.kind !== "BOOK") throw new Error("STUDY_UNKNOWN_EVENT");
    const symbol = event.delta.symbol;
    if (!this.protocol.assets[symbol]) return;
    const local = this.books.get(symbol) ?? new LocalOrderBook(symbol); this.books.set(symbol, local);
    const update = local.apply(event.delta);
    if (update.duplicate) { this.quality.duplicates++; return; }
    if (!update.accepted || !update.state) {
      this.quality.invalidBooks++; this.invalidate(now, `INVALID_BOOK:${update.reason}`); return;
    }
    this.quality.acceptedBooks++;
    const book = update.state;
    this.advance(book);
    const output = this.current.onBook(book);
    this.training("current", output.samples);
    const context = output.decision ?? output.trainingDecision;
    this.training("efficient", this.efficient.onBook(book, context));
    if (output.decision) this.quality.trainingReadyEvaluations++;
    if (!output.decision || now < this.protocol.startMs || now < this.cutoffMs) return;
    this.evaluate(book, output.decision);
  }

  private freeze(day: number): void {
    // Development may start mid-day: its initial snapshot is frozen at start.
    const cutoff = Math.max(this.protocol.startMs, day);
    if (cutoff <= this.cutoffMs) return;
    this.cutoffMs = cutoff;
    const banks = { current: [...this.seed, ...this.current.exportState().samples], efficient: this.efficient.exportSamples() };
    const details = {} as typeof this.freezes[number]; details.cutoffMs = cutoff;
    for (const name of ["current", "efficient"] as const) {
      const { model, admitted } = freshModel(banks[name], cutoff); this.models[name] = model;
      const totals = new Map<string, { sum: number; count: number }>();
      for (const row of admitted) for (const outcome of row.outcomes) {
        const key = `${row.symbol}:${row.actionId}:${outcome.scenario}`, old = totals.get(key) ?? { sum: 0, count: 0 };
        old.sum += outcome.netBps!; old.count++; totals.set(key, old);
      }
      this.unconditional[name] = new Map([...totals].map(([key, v]) => [key, v.sum / v.count]));
      details[name] = { samples: admitted.length, latestCompletedMs: admitted.length ? Math.max(...admitted.map(row => row.completedAtMs)) : null,
        sha256: hash(admitted) };
    }
    this.freezes.push(details); this.audit.push({ kind: "DAILY_FREEZE", ...details });
  }

  private training(name: ModelName, samples: DistributionSample[]): void {
    const q = this.trainingQuality[name];
    const jointValid = samples.every(row => row.outcomes.every(o => o.status !== "INVALID"));
    for (const row of samples) {
      const valid = row.outcomes.every(o => o.status !== "INVALID"), learned = valid && (name === "efficient" || jointValid);
      const key = `${row.symbol}:${row.actionId}`, counter = q.byAction[key] ?? { valid: 0, invalid: 0, learned: 0 };
      q.emitted++; q.valid += Number(valid); q.invalid += Number(!valid); q.learned += Number(learned);
      counter.valid += Number(valid); counter.invalid += Number(!valid); counter.learned += Number(learned); q.byAction[key] = counter;
      if (learned) q.publicationDelayMs += Math.max(0, row.completedAtMs - Math.max(...row.outcomes.map(o => o.exitAtMs)));
      this.audit.push({ kind: "TRAINING", trainer: name, learned, sample: row });
    }
  }

  private evaluate(book: BookState, context: DistributionDecision): void {
    const { symbol, atMs, features } = context;
    this.quality.readyEvaluations++;
    const key = `${dayKey(atMs)}:${symbol}`, seconds = this.coverage.get(key) ?? { count: 0, lastSecond: -1 };
    if (Math.floor(atMs / 1000) > seconds.lastSecond) { seconds.count++; seconds.lastSecond = Math.floor(atMs / 1000); }
    this.coverage.set(key, seconds);
    const estimates = { current: ACTIONS.map(a => this.models.current.estimate(symbol, a.id, features, atMs, 3)),
      efficient: ACTIONS.map(a => this.models.efficient.estimate(symbol, a.id, features, atMs, 3)) };
    for (const name of ["current", "efficient"] as const) {
      for (const estimate of estimates[name]) {
        const reason = `${name}:${symbol}:${estimate.actionId}:${estimate.reason}`; this.reasons[reason] = (this.reasons[reason] ?? 0) + 1;
      }
    }
    for (const policy of STUDY_POLICIES) {
      for (const row of this.rows) if (row.policy === policy && row.symbol === symbol) row.evaluations++;
      if (policy === "flat" || this.slots.has(policy) || atMs <= (this.completedSlots.get(policy) ?? -1)
        || atMs >= this.protocol.endMs - GRID) continue;
      const actionId = policy === "current" || policy === "efficient"
        ? estimates[policy].filter(e => e.eligible && (this.protocol.assets[symbol]!.shortable || ACTIONS.find(a => a.id === e.actionId)!.side === 1))
          .sort((a, b) => b.scoreBps! - a.scoreBps! || a.actionId.localeCompare(b.actionId))[0]?.actionId
        : policy === "momentum-15m" ? features[7] === 0 ? undefined : features[7]! > 0 ? "long-15m" : "short-15m" : policy;
      if (!actionId || (!this.protocol.assets[symbol]!.shortable && ACTIONS.find(a => a.id === actionId)!.side < 0)) continue;
      const path = this.path(book, context, actionId); this.slots.set(policy, path);
      for (const row of this.rows) if (row.policy === policy && row.symbol === symbol) row.selections++;
      this.audit.push({ kind: "SELECTION", policy, symbol, atMs, actionId, features, requestedQty: context.requestedQty,
        quoteSequence: context.quoteSequence, referenceBid: context.referenceBid, referenceAsk: context.referenceAsk,
        estimates: policy === "current" || policy === "efficient" ? estimates[policy] : undefined });
    }
    const bucket = Math.floor((atMs - this.protocol.startMs) / GRID);
    if (atMs >= this.protocol.endMs - GRID || bucket <= (this.probeBuckets.get(symbol) ?? -1) || this.probes.has(symbol)
      || atMs < (this.lastProbeMs.get(symbol) ?? -Infinity) + GRID) return;
    this.probeBuckets.set(symbol, bucket); this.lastProbeMs.set(symbol, atMs); this.quality.probeOrigins++;
    const paths = ACTIONS.map((action, index) => {
      const path = this.path(book, context, action.id);
      const current = this.models.current.predictScenarios(symbol, action.id, features, atMs);
      const efficient = this.models.efficient.predictScenarios(symbol, action.id, features, atMs);
      path.forecast = SCENARIOS.map((scenario, i) => ({ scenario: scenario.id, current: current[i]!.meanNetBps,
        efficient: efficient[i]!.meanNetBps,
        unconditionalCurrent: this.unconditional.current.get(`${symbol}:${action.id}:${scenario.id}`) ?? null,
        unconditionalEfficient: this.unconditional.efficient.get(`${symbol}:${action.id}:${scenario.id}`) ?? null,
        currentEligible: estimates.current[index]!.eligible, efficientEligible: estimates.efficient[index]!.eligible,
        currentSamples: current[i]!.samples, efficientSamples: efficient[i]!.samples,
        currentEffectiveSamples: current[i]!.effectiveSamples, efficientEffectiveSamples: efficient[i]!.effectiveSamples }));
      return path;
    });
    this.probes.set(symbol, paths);
    this.audit.push({ kind: "PROBE_FORECAST", symbol, atMs, bucket, features,
      predictions: paths.map(p => ({ actionId: p.actionId, forecast: p.forecast })) });
  }

  private path(book: BookState, context: DistributionDecision, actionId: string): Path {
    return { symbol: book.symbol, actionId, atMs: book.receiveTsMs, features: [...context.features],
      cases: SCENARIOS.map(scenario => new DistributionExecutionCase(ACTIONS.find(a => a.id === actionId)!,
        scenario, book, context.requestedQty, this.protocol.costs[book.symbol]!, this.protocol.assets[book.symbol]!.priceIncrement)) };
  }

  private advance(book?: BookState, invalid?: { atMs: number; reason: string }): void {
    const observe = (path: Path) => {
      if (invalid) for (const c of path.cases) c.invalidate(invalid.atMs, invalid.reason);
      else if (book?.symbol === path.symbol) DistributionExecutionCase.observeAll(path.cases, book);
      return path.cases.every(c => c.snapshot().outcome !== null);
    };
    for (const [policy, path] of this.slots) if (observe(path)) {
      const outcomes = path.cases.map(c => c.snapshot().outcome!);
      for (const outcome of outcomes) {
        const row = this.rows.find(r => r.policy === policy && r.symbol === path.symbol && r.scenario === outcome.scenario)!;
        const day = row.days[dayKey(path.atMs)] ?? { filled: 0, unknown: 0, netBps: 0 };
        row.filled += Number(outcome.status === "FILLED"); row.unfilled += Number(outcome.status === "UNFILLED");
        row.unknown += Number(outcome.status === "INVALID"); row.knownNetBpsSum += outcome.netBps ?? 0;
        day.filled += Number(outcome.status === "FILLED"); day.unknown += Number(outcome.status === "INVALID");
        day.netBps += outcome.netBps ?? 0; row.days[dayKey(path.atMs)] = day;
      }
      this.audit.push({ kind: "SELECTED_OUTCOME", policy, symbol: path.symbol, actionId: path.actionId, atMs: path.atMs, outcomes });
      this.slots.delete(policy); this.completedSlots.set(policy, Math.max(...outcomes.map(o => o.exitAtMs)));
    }
    for (const [symbol, paths] of this.probes) {
      const done: Path[] = [], pending: Path[] = [];
      for (const path of paths) (observe(path) ? done : pending).push(path);
      for (const path of done) this.scoreProbe(path);
      if (pending.length) this.probes.set(symbol, pending); else this.probes.delete(symbol);
    }
  }

  private scoreProbe(path: Path): void {
    const outcomes = path.cases.map(c => c.snapshot().outcome!);
    for (const outcome of outcomes) {
      const row = this.errors.find(r => r.symbol === path.symbol && r.actionId === path.actionId && r.scenario === outcome.scenario)!;
      row.probes++;
      const f = path.forecast!.find(f => f.scenario === outcome.scenario)!;
      for (const name of ["current", "efficient", "unconditionalCurrent", "unconditionalEfficient"] as const) row.available[name]! += Number(f[name] !== null);
      if (outcome.status === "INVALID") { row.unknown++; continue; }
      if ([f.current, f.efficient, f.unconditionalCurrent, f.unconditionalEfficient].some(v => v === null)) continue;
      row.paired++; row.currentEligible += Number(f.currentEligible); row.efficientEligible += Number(f.efficientEligible);
      for (const name of ["current", "efficient", "unconditionalCurrent", "unconditionalEfficient"] as const) {
        const error = f[name]! - outcome.netBps!; row.errors[name]!.absolute += Math.abs(error); row.errors[name]!.squared += error ** 2;
      }
      const day = row.days[dayKey(path.atMs)] ?? { count: 0, efficientMinusCurrentSquared: 0,
        efficientMinusUnconditionalSquared: 0, currentMinusUnconditionalSquared: 0 };
      const e = (f.efficient! - outcome.netBps!) ** 2, c = (f.current! - outcome.netBps!) ** 2;
      day.count++; day.efficientMinusCurrentSquared += e - c;
      day.efficientMinusUnconditionalSquared += e - (f.unconditionalEfficient! - outcome.netBps!) ** 2;
      day.currentMinusUnconditionalSquared += c - (f.unconditionalCurrent! - outcome.netBps!) ** 2;
      row.days[dayKey(path.atMs)] = day;
    }
    this.audit.push({ kind: "PROBE_OUTCOME", symbol: path.symbol, actionId: path.actionId, atMs: path.atMs, outcomes });
  }

  private invalidate(atMs: number, reason: string): void {
    this.training("current", this.current.invalidate(atMs, reason)); this.current.drainSelections();
    this.training("efficient", this.efficient.invalidate(atMs, reason));
    this.advance(undefined, { atMs, reason });
    for (const book of this.books.values()) book.invalidate();
    this.audit.push({ kind: "INVALIDATION", atMs, reason });
  }

  finish(atMs: number, reason: string): void {
    if (this.finishedAtMs !== null) return;
    if (!Number.isSafeInteger(atMs) || atMs < (this.quality.lastMs ?? 0)) throw new Error("STUDY_REVERSED_FINISH");
    this.invalidate(Math.min(atMs, this.protocol.endMs), reason);
    this.finishedAtMs = atMs; this.finishReason = reason;
  }

  drainAudit(): unknown[] { const rows = this.audit; this.audit = []; return rows; }

  report() {
    const now = this.quality.lastMs ?? 0;
    const coverage = [...this.coverage].map(([key, seconds]) => ({ key, readySeconds: seconds.count, readyHours: seconds.count / 3600 }));
    const dates = [...new Set(coverage.map(row => row.key.slice(0, 10)))];
    const sufficientlyCoveredDates = dates.filter(date => S.symbols.every(symbol =>
      (this.coverage.get(`${date}:${symbol}`)?.count ?? 0) >= 12 * 3600)).length;
    const adequacy = ["current", "efficient"].map(policy => {
      const rows = this.rows.filter(row => row.policy === policy && row.scenario === SCENARIOS[0]!.id);
      return { policy, filled: rows.reduce((n, row) => n + row.filled, 0),
        passed: sufficientlyCoveredDates >= 10 && rows.reduce((n, row) => n + row.filled, 0) >= 100
          && rows.every(row => row.filled >= 30 && Object.values(row.days).filter(day => day.filled > 0).length >= 7) };
    });
    const complete = this.finishedAtMs !== null && this.finishedAtMs >= this.protocol.endMs && this.finishReason === "STUDY_END";
    const unknownSelectedPaths = this.rows.reduce((n, row) => n + row.unknown, 0);
    return { version: this.protocol.version, mode: this.protocol.mode, protocol: this.protocol,
      status: this.finishedAtMs === null ? "PENDING" : !complete || unknownSelectedPaths > 0 || adequacy.some(row => !row.passed) ? "INCONCLUSIVE" : "COMPLETE_DESCRIPTIVE",
      finishedAtMs: this.finishedAtMs, finishReason: this.finishReason, quality: { ...this.quality },
      training: { initialSamplesEach: this.seed.length, currentCollectorExcludesSeed: true,
        current: this.current.stats(now), efficient: this.efficient.stats(),
        efficiency: Object.fromEntries(Object.entries(this.trainingQuality).map(([name, q]) => [name, { ...structuredClone(q),
          learnedPerObservedReadyAssetHour: this.quality.trainingReadyEvaluations ? q.learned * 3600 / this.quality.trainingReadyEvaluations : null,
          meanPublicationDelayMs: q.learned ? q.publicationDelayMs / q.learned : null }])), spec: EFFICIENT_TRAINING_SPEC },
      freezes: structuredClone(this.freezes), coverage, sufficientlyCoveredDates, adequacy,
      frozenModels: { current: this.models.current.stats(), efficient: this.models.efficient.stats() }, unknownSelectedPaths,
      expectedProbeOriginsPerSymbol: Math.max(0, Math.ceil((this.protocol.endMs - this.protocol.startMs - GRID) / GRID)),
      policies: this.rows.map(row => ({ ...structuredClone(row),
        fullPathKnownNetBpsSum: row.unknown === 0 && !this.slots.has(row.policy) ? row.knownNetBpsSum : null,
        knownMeanNetBps: row.filled + row.unfilled ? row.knownNetBpsSum / (row.filled + row.unfilled) : null })),
      predictions: this.errors.map(row => ({ ...structuredClone(row), errors: Object.fromEntries(Object.entries(row.errors).map(([name, v]) =>
        [name, { maeBps: row.paired ? v.absolute / row.paired : null, rmseBps: row.paired ? Math.sqrt(v.squared / row.paired) : null }])),
        dailyPairedSquaredErrorDifference: Object.fromEntries(["efficientMinusCurrentSquared", "efficientMinusUnconditionalSquared", "currentMinusUnconditionalSquared"].map(key =>
          [key, dailyInterval(Object.values(row.days).map(day => day[key as keyof typeof day] / day.count))])) })),
      decisionReasons: { ...this.reasons }, pendingSelections: this.slots.size,
      pendingProbes: [...this.probes.values()].reduce((n, rows) => n + rows.length, 0),
      brokerOrdersSubmitted: 0, profitabilityEstablished: false, deploymentReady: false,
      assumptions: ["Prospective daily walk-forward: each UTC block uses strictly preceding completed labels; fixed algorithms may learn earlier study days at the next block",
        "All policies share the same causal feed, features, costs, $12 quantity rules, action exits and three stresses; each policy has one global BTC/ETH slot",
        "Fixed long/short/momentum baselines use the 15-minute action including its stops and targets; momentum uses the sign of the observed prior 15-minute return",
        "Common 31-minute probe buckets include all six actions; prediction errors use the same realized scenario and common finite forecasts, including model abstentions",
        "Forecast means are ungated conditional shrunk means; unconditional predictions are unshrunk means of each corresponding daily training bank",
        "Missing/invalid paths remain unknown; known-only sums are explicitly partial and are not account P&L or compounded returns",
        "Ready coverage counts distinct observed evaluation seconds, conservatively; missing probe buckets can be inferred from frozen grid and recorded origins",
        "Daily paired error intervals use mean daily errors and fixed 2.58 standard-error multiplier; descriptive, unadjusted for multiple comparisons, not a calibrated significance claim",
        "Daily inference snapshots differ from the continuously updating paper engine; this study isolates training collection under the same fixed inference refresh schedule",
        "Raw source events are hash chained in emission order; compact audit retains labels, forecasts and selections but cannot reconstruct full depth without a separate raw archive",
        "Previously inspected historical replay is DEVELOPMENT only; future adequacy does not establish effectiveness automatically; no automatic promotion or order submission"] };
  }
}
