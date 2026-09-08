import type { BookState } from "../core/market.js";
import type { AssetRules } from "../execution/planner.js";
import type { DistributionCosts } from "./controller.js";
import { DistributionExecutionCase } from "./execution.js";
import { distributionBookReason } from "./market.js";
import { ConditionalDistributionModel } from "./model.js";
import { RegimeDistributionModel } from "./regime-model.js";
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SCENARIOS, DISTRIBUTION_SPEC as S,
  type DistributionDecision, type DistributionEstimate, type DistributionSample } from "./spec.js";

/** Research protocol: these clocks are prescribed before evaluating returns.
 * A new origin requires an observed ready quote, both sides free, and elapsed
 * horizon + one minute. Early exits never accelerate that clock. */
export const EFFICIENT_TRAINING_SPEC = Object.freeze({
  version: "btc-eth-independent-horizon-training-v1", researchOnly: true,
  labelVersion: S.version, completionBufferMs: 60_000,
  horizons: Object.freeze([5, 15, 30].map(minutes => Object.freeze({
    horizonMs: minutes * 60_000, intervalMs: (minutes + 1) * 60_000,
  }))),
  maximumSamplesPerAction: S.maximumSamples,
  maximumInvalidReasonCategories: 32,
  maximumPendingActions: S.symbols.length * DISTRIBUTION_ACTIONS.length,
  maximumPendingCases: S.symbols.length * DISTRIBUTION_ACTIONS.length * DISTRIBUTION_SCENARIOS.length,
  eligibilityUnchanged: true, pairedSides: true, labelsRequireAllScenarios: true,
});

interface PendingAction {
  symbol: string; actionId: string; signalAtMs: number; features: number[];
  cases: DistributionExecutionCase[];
}
interface ActionCounters { started: number; completed: number; learned: number; invalid: number }
interface QuoteWatermark { atMs: number; exchangeAtMs: number; sequence: bigint }
export interface EfficientTrainingSchedulerState {
  version: string; nextOrigins: Record<string, number>; invalidatedThrough: Record<string, number>;
  observedThrough: Record<string, number>;
  pendingOrigins: Array<{ symbol: string; actionId: string; signalAtMs: number }>;
}
const validTime = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const key = (symbol: string, actionId: string): string => `${symbol}:${actionId}`;
const clockKey = (symbol: string, horizonMs: number): string => `${symbol}:${horizonMs}`;
const clone = (sample: DistributionSample): DistributionSample => ({ ...sample,
  features: [...sample.features], outcomes: sample.outcomes.map(outcome => ({ ...outcome })) });

/** Independent research collector, with no order permissions or broker access.
 * The caller supplies context only after its causal market state is ready.
 * Entry eligibility/paperReady are intentionally irrelevant to label collection.
 * Completed actions learn immediately; an unavailable scenario excludes only
 * its own action. Correlated horizons remain separate model banks, not extra
 * independent observations for a pooled estimator. */
export class EfficientDistributionTrainer {
  private readonly model: ConditionalDistributionModel | RegimeDistributionModel;
  private readonly costs: DistributionCosts;
  private readonly assets: Record<string, AssetRules>;
  private readonly pending = new Map<string, PendingAction>();
  private readonly nextOrigins = new Map<string, number>();
  private readonly quotes = new Map<string, QuoteWatermark>();
  private readonly invalidatedThrough = new Map<string, number>();
  private readonly retained = new Map<string, DistributionSample[]>();
  private readonly actionCounters = new Map<string, ActionCounters>();
  private readonly invalidByReason: Record<string, number> = Object.create(null) as Record<string, number>;
  private counters = { initialSamples: 0, startedHorizons: 0, startedActions: 0,
    completedActions: 0, learnedActions: 0, invalidActions: 0, rejectedContexts: 0 };

  constructor(costs: DistributionCosts, assets: Record<string, AssetRules>,
    initialSamples: DistributionSample[] = [], cutoffMs = Date.now(), options: { regimeModel?: boolean } = {}) {
    if (options.regimeModel !== undefined && typeof options.regimeModel !== "boolean") throw new Error("INVALID_EFFICIENT_TRAINING_MODEL_OPTION");
    this.model = options.regimeModel ? new RegimeDistributionModel() : new ConditionalDistributionModel();
    if (!validTime(cutoffMs) || !Array.isArray(initialSamples)) throw new Error("INVALID_EFFICIENT_TRAINING_SEED");
    for (const symbol of S.symbols) {
      const fee = costs?.[symbol], asset = assets?.[symbol];
      if (!fee || ![fee.feeBps, fee.reserveBps].every(n => Number.isFinite(n) && n >= 0)
        || !asset || asset.symbol !== symbol || typeof asset.shortable !== "boolean"
        || ![asset.minOrderSize, asset.minTradeIncrement, asset.priceIncrement, asset.maximumOrderQty]
          .every(n => Number.isFinite(n) && n > 0)
        || asset.maximumOrderQty < asset.minOrderSize) throw new Error("INVALID_EFFICIENT_TRAINING_CONFIG");
    }
    this.costs = Object.fromEntries(S.symbols.map(symbol => [symbol, { ...costs[symbol]! }]));
    this.assets = Object.fromEntries(S.symbols.map(symbol => [symbol, { ...assets[symbol]! }]));
    for (const sample of initialSamples) {
      if (!sample || !validTime(sample.completedAtMs) || sample.completedAtMs > cutoffMs) {
        throw new Error("INVALID_EFFICIENT_TRAINING_SEED_FUTURE_OR_SHAPE");
      }
    }
    for (const sample of [...initialSamples].sort((a, b) => a.signalAtMs - b.signalAtMs || a.completedAtMs - b.completedAtMs)) {
      if (!this.model.observe(sample)) throw new Error("INVALID_EFFICIENT_TRAINING_SEED_LABEL");
      this.retain(sample); this.counters.initialSamples++;
      const action = DISTRIBUTION_ACTIONS.find(action => action.id === sample.actionId)!;
      const clock = clockKey(sample.symbol, action.horizonMs);
      this.nextOrigins.set(clock, Math.max(this.nextOrigins.get(clock) ?? 0,
        sample.signalAtMs + action.horizonMs + EFFICIENT_TRAINING_SPEC.completionBufferMs, sample.completedAtMs));
    }
  }

  onBook(book: BookState, context: DistributionDecision | null): DistributionSample[] {
    const completed: DistributionSample[] = [];
    // Labels always observe every quote, including quotes without an evaluation.
    const ownActions = [...this.pending.values()].filter(item => item.symbol === book.symbol);
    DistributionExecutionCase.observeAll(ownActions.flatMap(item => item.cases), book);
    for (const item of ownActions) {
      if (item.cases.some(execution => execution.snapshot().outcome?.status === "INVALID")) {
        for (const execution of item.cases) execution.invalidate(book.receiveTsMs, "ACTION_EXECUTION_PATH_INVALID");
      }
      if (item.cases.every(execution => execution.snapshot().outcome !== null)) completed.push(this.complete(item));
    }
    const previous = this.quotes.get(book.symbol);
    const valid = validTime(book.receiveTsMs) && validTime(book.exchangeTsMs)
      && book.receiveTsMs >= (this.invalidatedThrough.get(book.symbol) ?? 0) && !distributionBookReason(book);
    const fresh = valid && (!previous || (book.sequence > previous.sequence && book.receiveTsMs >= previous.atMs
      && book.exchangeTsMs >= previous.exchangeAtMs));
    if (fresh) this.quotes.set(book.symbol, { sequence: book.sequence, atMs: book.receiveTsMs, exchangeAtMs: book.exchangeTsMs });
    if (context === null) return completed;
    if (!fresh || !this.validContext(book, context)) { this.counters.rejectedContexts++; return completed; }
    const rules = this.assets[book.symbol]!;
    for (const horizon of EFFICIENT_TRAINING_SPEC.horizons) {
      const actions = DISTRIBUTION_ACTIONS.filter(action => action.horizonMs === horizon.horizonMs);
      const clock = clockKey(book.symbol, horizon.horizonMs);
      if (book.receiveTsMs < (this.nextOrigins.get(clock) ?? 0)
        || actions.some(action => this.pending.has(key(book.symbol, action.id)))) continue;
      this.nextOrigins.set(clock, book.receiveTsMs + horizon.intervalMs);
      this.counters.startedHorizons++;
      for (const action of actions) {
        this.pending.set(key(book.symbol, action.id), { symbol: book.symbol, actionId: action.id,
          signalAtMs: book.receiveTsMs, features: [...context.features],
          cases: DISTRIBUTION_SCENARIOS.map(scenario => new DistributionExecutionCase(action, scenario,
            book, context.requestedQty, this.costs[book.symbol]!, rules.priceIncrement)) });
        this.actionCount(book.symbol, action.id).started++; this.counters.startedActions++;
      }
    }
    return completed;
  }

  invalidate(atMs: number, reason: string): DistributionSample[] {
    if (!validTime(atMs) || typeof reason !== "string" || !reason.length) throw new Error("INVALID_EFFICIENT_TRAINING_INVALIDATION");
    const rows: DistributionSample[] = [];
    for (const item of this.pending.values()) {
      for (const execution of item.cases) execution.invalidate(atMs, reason);
      rows.push(this.complete(item));
    }
    // Quote sequences can restart across transport sessions. The horizon clocks
    // and per-symbol receipt floors retain time watermarks. Even a short action
    // completed before this disconnect cannot restart from a late old quote.
    for (const symbol of S.symbols) this.invalidatedThrough.set(symbol,
      Math.max(atMs, this.invalidatedThrough.get(symbol) ?? 0, this.quotes.get(symbol)?.atMs ?? 0));
    this.quotes.clear();
    return rows;
  }

  estimate(symbol: string, actionId: string, features: readonly number[], nowMs: number,
    minimumTrainingDays = 3): DistributionEstimate {
    return this.model.estimate(symbol, actionId, features, nowMs, minimumTrainingDays);
  }

  get proposalCount(): number { return this.counters.startedHorizons; }
  get pendingCount(): number { return this.pending.size; }
  hasDueTraining(symbol: string, atMs: number): boolean {
    return S.symbols.some(s => s === symbol) && validTime(atMs)
      && atMs >= (this.invalidatedThrough.get(symbol) ?? 0)
      && EFFICIENT_TRAINING_SPEC.horizons.some(horizon => atMs >= (this.nextOrigins.get(clockKey(symbol, horizon.horizonMs)) ?? 0)
        && !DISTRIBUTION_ACTIONS.some(action => action.horizonMs === horizon.horizonMs && this.pending.has(key(symbol, action.id))));
  }

  assertAssetRules(asset: AssetRules): void {
    const expected = this.assets[asset.symbol];
    if (!expected || (Object.keys(expected) as Array<keyof AssetRules>).some(field => asset[field] !== expected[field])) {
      throw new Error("DISTRIBUTION_TRAINING_ASSET_RULES_CHANGED");
    }
  }

  /** Execution paths cannot survive a process/feed restart. Keep their origin
   * clocks and receipt floors, so discarding them never creates overlap. */
  prepareForLive(): void {
    for (const symbol of S.symbols) this.invalidatedThrough.set(symbol,
      Math.max(this.invalidatedThrough.get(symbol) ?? 0, this.quotes.get(symbol)?.atMs ?? 0));
    this.pending.clear(); this.quotes.clear();
  }

  exportSchedulerState(): EfficientTrainingSchedulerState {
    return { version: EFFICIENT_TRAINING_SPEC.version, nextOrigins: Object.fromEntries(this.nextOrigins),
      invalidatedThrough: Object.fromEntries(this.invalidatedThrough),
      observedThrough: Object.fromEntries([...this.quotes].map(([symbol, value]) => [symbol, value.atMs])),
      pendingOrigins: [...this.pending.values()].map(({ symbol, actionId, signalAtMs }) => ({ symbol, actionId, signalAtMs })) };
  }

  /** Call on a newly seeded collector only. Validate completely before changing
   * its scheduler; completed labels are validated by the constructor's model. */
  restoreSchedulerState(value: unknown, cutoffMs: number): void {
    const state = value as EfficientTrainingSchedulerState;
    const dictionary = (v: unknown): v is Record<string, number> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
    if (!validTime(cutoffMs) || this.pending.size || this.quotes.size || !state
      || state.version !== EFFICIENT_TRAINING_SPEC.version || !dictionary(state.nextOrigins)
      || !dictionary(state.invalidatedThrough) || !dictionary(state.observedThrough)
      || !Array.isArray(state.pendingOrigins) || state.pendingOrigins.length > EFFICIENT_TRAINING_SPEC.maximumPendingActions) {
      throw new Error("INVALID_EFFICIENT_TRAINING_SCHEDULER");
    }
    const clocks = new Map<string, number>(), floors = new Map<string, number>();
    for (const [clock, time] of Object.entries(state.nextOrigins)) {
      const horizon = EFFICIENT_TRAINING_SPEC.horizons.find(h => S.symbols.some(symbol => clock === clockKey(symbol, h.horizonMs)));
      if (!horizon || !validTime(time) || time > cutoffMs + horizon.intervalMs) throw new Error("INVALID_EFFICIENT_TRAINING_CLOCK");
      clocks.set(clock, time);
    }
    for (const [clock, minimum] of this.nextOrigins) if ((clocks.get(clock) ?? -1) < minimum) {
      throw new Error("EFFICIENT_TRAINING_CLOCK_PRECEDES_LABELS");
    }
    for (const times of [state.invalidatedThrough, state.observedThrough]) for (const [symbol, time] of Object.entries(times)) {
      if (!S.symbols.some(s => s === symbol) || !validTime(time) || time > cutoffMs) throw new Error("INVALID_EFFICIENT_TRAINING_RECEIPT_FLOOR");
      floors.set(symbol, Math.max(floors.get(symbol) ?? 0, time));
    }
    const seen = new Set<string>();
    for (const pending of state.pendingOrigins) {
      const action = DISTRIBUTION_ACTIONS.find(a => a.id === pending?.actionId), id = pending && key(pending.symbol, pending.actionId);
      const last = id ? this.retained.get(id)?.at(-1) : undefined;
      if (!pending || !S.symbols.some(s => s === pending.symbol) || !action || !validTime(pending.signalAtMs)
        || pending.signalAtMs > cutoffMs || seen.has(id!) || (last && (pending.signalAtMs <= last.signalAtMs
          || pending.signalAtMs < last.completedAtMs))) throw new Error("INVALID_EFFICIENT_TRAINING_PENDING_ORIGIN");
      seen.add(id!);
      if ((clocks.get(clockKey(pending.symbol, action.horizonMs)) ?? -1)
        < pending.signalAtMs + action.horizonMs + EFFICIENT_TRAINING_SPEC.completionBufferMs) {
        throw new Error("EFFICIENT_TRAINING_CLOCK_PRECEDES_PENDING_ORIGIN");
      }
    }
    this.nextOrigins.clear(); for (const [clock, time] of clocks) this.nextOrigins.set(clock, time);
    this.invalidatedThrough.clear();
    for (const symbol of S.symbols) this.invalidatedThrough.set(symbol, Math.max(cutoffMs, floors.get(symbol) ?? 0));
  }

  exportSamples(): DistributionSample[] {
    return [...this.retained.values()].flatMap(rows => rows.map(clone))
      .sort((a, b) => a.signalAtMs - b.signalAtMs || a.symbol.localeCompare(b.symbol) || a.actionId.localeCompare(b.actionId));
  }

  stats() {
    const learning = this.model.stats();
    return { version: EFFICIENT_TRAINING_SPEC.version, researchOnly: true, ...this.counters,
      pendingActions: this.pending.size,
      pendingCases: [...this.pending.values()].reduce((sum, item) => sum + item.cases.length, 0),
      invalidByReason: { ...this.invalidByReason }, learning,
      byAction: learning.byAction.map(row => {
        const action = DISTRIBUTION_ACTIONS.find(action => action.id === row.actionId)!;
        const pending = this.pending.get(key(row.symbol, row.actionId));
        return { ...row, ...(this.actionCounters.get(key(row.symbol, row.actionId))
          ?? { started: 0, completed: 0, learned: 0, invalid: 0 }),
        pendingSignalAtMs: pending?.signalAtMs ?? null,
        nextOriginAtMs: this.nextOrigins.get(clockKey(row.symbol, action.horizonMs)) ?? null };
      }) };
  }

  private validContext(book: BookState, d: DistributionDecision): boolean {
    const rules = this.assets[book.symbol], costs = this.costs[book.symbol];
    if (!rules || !costs || !d || d.version !== S.version || d.symbol !== book.symbol
      || d.atMs !== book.receiveTsMs || d.quoteSequence !== String(book.sequence)
      || d.referenceBid !== book.bids[0]!.px || d.referenceAsk !== book.asks[0]!.px
      || d.feeBps !== costs.feeBps || d.reserveBps !== costs.reserveBps
      || (d.actionId !== null && !DISTRIBUTION_ACTIONS.some(action => action.id === d.actionId))
      || !Array.isArray(d.features) || d.features.length !== S.featureDimension
      || !d.features.every(n => Number.isFinite(n) && Math.abs(n) <= 1)
      || !Number.isFinite(d.requestedQty) || d.requestedQty < rules.minOrderSize
      || d.requestedQty > rules.maximumOrderQty || d.requestedQty * d.referenceAsk > S.maximumNotional + 1e-8) return false;
    const expectedQty = Math.floor(S.maximumNotional / d.referenceAsk / rules.minTradeIncrement + 1e-12) * rules.minTradeIncrement;
    return Math.abs(d.requestedQty - expectedQty) <= 1e-10;
  }

  private complete(item: PendingAction): DistributionSample {
    const outcomes = item.cases.map(execution => execution.snapshot().outcome!);
    const sample: DistributionSample = { id: `${item.symbol}:${item.actionId}:${item.signalAtMs}`,
      symbol: item.symbol, actionId: item.actionId, signalAtMs: item.signalAtMs,
      completedAtMs: Math.max(...outcomes.map(outcome => outcome.exitAtMs)), features: [...item.features], outcomes };
    this.pending.delete(key(item.symbol, item.actionId));
    const action = DISTRIBUTION_ACTIONS.find(action => action.id === item.actionId)!;
    const clock = clockKey(item.symbol, action.horizonMs);
    this.nextOrigins.set(clock, Math.max(this.nextOrigins.get(clock) ?? 0, sample.completedAtMs));
    const count = this.actionCount(item.symbol, item.actionId);
    count.completed++; this.counters.completedActions++;
    if (outcomes.every(outcome => outcome.status !== "INVALID") && this.model.observe(sample)) {
      this.retain(sample); count.learned++; this.counters.learnedActions++;
    } else {
      count.invalid++; this.counters.invalidActions++;
      const reasons = new Set(outcomes.filter(outcome => outcome.status === "INVALID").map(outcome => outcome.reason));
      if (!reasons.size) reasons.add("MODEL_REJECTED_LABEL");
      for (const reason of reasons) {
        const category = Object.hasOwn(this.invalidByReason, reason)
          || Object.keys(this.invalidByReason).length < EFFICIENT_TRAINING_SPEC.maximumInvalidReasonCategories - 1
          ? reason : "OTHER_INVALID_REASON";
        this.invalidByReason[category] = (this.invalidByReason[category] ?? 0) + 1;
      }
    }
    return clone(sample);
  }

  private actionCount(symbol: string, actionId: string): ActionCounters {
    const id = key(symbol, actionId);
    let count = this.actionCounters.get(id);
    if (!count) { count = { started: 0, completed: 0, learned: 0, invalid: 0 }; this.actionCounters.set(id, count); }
    return count;
  }

  private retain(sample: DistributionSample): void {
    const id = key(sample.symbol, sample.actionId), rows = this.retained.get(id) ?? [];
    rows.push(clone(sample));
    if (rows.length > S.maximumSamples) rows.shift();
    this.retained.set(id, rows);
  }
}
