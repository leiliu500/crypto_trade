import { DynamicBayes, studentLogDensity, type BayesianPrediction } from "./dynamic-bayes.js";

export const CROSS_ASSET_SPEC = Object.freeze({ version: "btc-eth-dynamic-bayes-v1", sampleMs: 60_000,
  horizonMs: 900_000, historyMs: 3_600_000, maximumQuoteAgeMs: 2_000, maximumQuoteGapMs: 5_000,
  maximumSampleGapMs: 90_000, minimumLabels: 24, returnScaleBps: 20,
  parameterPenalty: 2, predictiveRiskPenalty: .1, maximumFeature: 6, weightMemory: .98, maximumModelAgeMs: 86_400_000 });
export const CROSS_ASSET_SYMBOLS = ["BTC/USD", "ETH/USD"] as const;
// These identities are deliberately outside the v1 order-submission contract.
export const CROSS_ASSET_RESEARCH_VARIANTS = Object.freeze({
  "endpoint-15m": { version: "btc-eth-endpoint-15m-research-v1", horizonMs: 900_000 },
  "endpoint-30m": { version: "btc-eth-endpoint-30m-research-v1", horizonMs: 1_800_000 },
  "endpoint-60m": { version: "btc-eth-endpoint-60m-research-v1", horizonMs: 3_600_000 },
});
export type CrossAssetResearchVariant = keyof typeof CROSS_ASSET_RESEARCH_VARIANTS;
export interface CrossAssetTrainingLabel {
  symbol: string; startMs: number; endMs: number; trainingLabelsBefore: number;
  predictedGrossBps: number; actualGrossBps: number;
}
export type CrossAssetSymbol = typeof CROSS_ASSET_SYMBOLS[number];
export interface CrossAssetQuote { symbol: string; atMs: number; bid: number; ask: number; valid: boolean }
interface Pair { atMs: number; mids: [number, number] }
interface Pending { pair: Pair; features: number[][]; predictions: BayesianPrediction[][]; means: number[] }
const EXPERTS = [
  { name: "trend", columns: [0, 1, 2, 3], halfLife: 64 },
  { name: "cross-asset", columns: [0, 1, 2, 4, 5, 6], halfLife: 64 },
  { name: "relative-value", columns: [0, 6, 7, 8], halfLife: 32 },
  { name: "zero-alpha", columns: [], halfLife: 32 },
] as const;

export interface CrossAssetForecast {
  version: string; symbol: CrossAssetSymbol; atMs: number; horizonMs: number; trainingLabels: number;
  trainedThroughMs: number | null; referenceMid: number; side: 1 | -1; predictedGrossBps: number;
  parameterUncertaintyBps: number; predictiveStdBps: number; costHurdleBps: number;
  conservativeNetBps: number; eligible: boolean; reason: string; factorBeta: number;
  expertWeights: Record<string, number>;
}

/** Directional midpoint target return measured from the proposed entry price.
 * This is a direction check, not net expected value: fees and exit spread still
 * belong in the planner's complete midpoint-based cost calculation. */
export function crossAssetEntryGrossBps(f: Pick<CrossAssetForecast, "referenceMid" | "predictedGrossBps" | "side">,
  entryPrice: number): number | null {
  if (![f.referenceMid, f.predictedGrossBps, entryPrice].every(Number.isFinite)
    || f.referenceMid <= 0 || entryPrice <= 0 || ![1, -1].includes(f.side)) return null;
  const target = f.referenceMid * (1 + f.predictedGrossBps / 10_000);
  if (!Number.isFinite(target) || target <= 0) return null;
  const gross = f.side * (target - entryPrice) / entryPrice * 10_000;
  return Number.isFinite(gross) ? gross : null;
}

function validCrossAssetForecast(f: CrossAssetForecast | undefined, symbol: string, nowMs: number): f is CrossAssetForecast {
  return !!f && f.version === CROSS_ASSET_SPEC.version && f.symbol === symbol && [1, -1].includes(f.side)
    && [f.atMs, nowMs, f.referenceMid, f.predictedGrossBps, f.parameterUncertaintyBps, f.predictiveStdBps,
      f.costHurdleBps, f.conservativeNetBps].every(Number.isFinite)
    && f.referenceMid > 0 && f.parameterUncertaintyBps >= 0 && f.predictiveStdBps > 0 && f.costHurdleBps >= 0
    && Number.isInteger(f.trainingLabels) && f.trainingLabels >= CROSS_ASSET_SPEC.minimumLabels
    && f.horizonMs === CROSS_ASSET_SPEC.horizonMs && f.trainedThroughMs !== null
    && Number.isFinite(f.trainedThroughMs) && f.trainedThroughMs <= f.atMs
    && nowMs - f.trainedThroughMs <= CROSS_ASSET_SPEC.maximumModelAgeMs
    && nowMs >= f.atMs && nowMs - f.atMs <= 1_000 && f.side * f.predictedGrossBps > 0
    && Math.abs(f.conservativeNetBps - (Math.abs(f.predictedGrossBps)
      - CROSS_ASSET_SPEC.parameterPenalty * f.parameterUncertaintyBps
      - CROSS_ASSET_SPEC.predictiveRiskPenalty * f.predictiveStdBps - f.costHurdleBps)) < 1e-7;
}

export function usableCrossAssetForecast(f: CrossAssetForecast | undefined, symbol: string, nowMs: number): f is CrossAssetForecast {
  return validCrossAssetForecast(f, symbol, nowMs) && f.eligible === true
    && f.reason === "POSITIVE_RESEARCH_FORECAST" && f.conservativeNetBps > 0;
}

/** Evaluation orders have a separate cohort and retain their original failing screen. */
export function crossAssetPaperCandidate(f: CrossAssetForecast | undefined, symbol: string, nowMs: number, paperEvaluation = false) {
  if (!validCrossAssetForecast(f, symbol, nowMs)) return null;
  const acceptable = (f.eligible === true && f.reason === "POSITIVE_RESEARCH_FORECAST" && f.conservativeNetBps > 0) || (paperEvaluation && f.eligible === false
    && f.reason === "COST_OR_UNCERTAINTY" && f.conservativeNetBps <= 0);
  return acceptable ? { family: "CONTINUATION" as const, side: f!.side,
    regime: `${CROSS_ASSET_SPEC.version}${paperEvaluation ? ":EVALUATION" : ""}:${f!.side === 1 ? "UP" : "DOWN"}` } : null;
}

/** Joint, causal market sampling, independent of all existing entry triggers.
 * Labels cover disjoint intervals (15 minutes in production). Weights learn from each expert's
 * forecast made before the label existed, never its fitted residual. */
export class CrossAssetModel {
  private readonly latest = new Map<string, CrossAssetQuote>();
  private history: Pair[] = [];
  private pending?: Pending;
  private readonly learners = CROSS_ASSET_SYMBOLS.map(() => EXPERTS.map((e) => new DynamicBayes(e.columns.length, e.halfLife)));
  private readonly weights = CROSS_ASSET_SYMBOLS.map(() => EXPERTS.map(() => 1 / EXPERTS.length));
  private labels = 0;
  private trainedThroughMs: number | null = null;
  private invalidLabels = 0;
  private trainingResets = 0;
  private readonly errors = CROSS_ASSET_SYMBOLS.map(() => ({ labels: 0, squared: 0, zeroSquared: 0 }));
  public constructor(private readonly costs: Readonly<Record<string, { feeBps: number; reserveBps: number }>>,
    private readonly researchVariant?: CrossAssetResearchVariant,
    private readonly onTrainingLabel?: (label: CrossAssetTrainingLabel) => void) {
    if (researchVariant !== undefined && !Object.hasOwn(CROSS_ASSET_RESEARCH_VARIANTS, researchVariant)) throw new Error("INVALID_RESEARCH_VARIANT");
    for (const symbol of CROSS_ASSET_SYMBOLS) {
      const cost = costs[symbol];
      if (!cost || ![cost.feeBps, cost.reserveBps].every((v) => Number.isFinite(v) && v >= 0)) throw new Error("INVALID_CROSS_ASSET_COSTS");
    }
  }
  public get version(): string { return this.researchVariant ? CROSS_ASSET_RESEARCH_VARIANTS[this.researchVariant].version : CROSS_ASSET_SPEC.version; }
  public get horizonMs(): number { return this.researchVariant ? CROSS_ASSET_RESEARCH_VARIANTS[this.researchVariant].horizonMs : CROSS_ASSET_SPEC.horizonMs; }
  public invalidate(atMs?: number, discardLabel = false): void {
    const last = this.history.at(-1);
    // A research return label needs clean endpoints, not an inferred execution
    // path. Keep its frozen origin only until the declared endpoint deadline.
    // Quote synchronization and feature-history gap checks remain mandatory.
    const retainEndpoint = this.researchVariant !== undefined && !discardLabel && this.pending
      && atMs !== undefined && Number.isFinite(atMs) && atMs >= this.pending.pair.atMs
      && (!last || atMs >= last.atMs)
      && atMs <= this.pending.pair.atMs + this.horizonMs + CROSS_ASSET_SPEC.maximumSampleGapMs;
    if (this.pending && !retainEndpoint) { this.invalidLabels++; delete this.pending; }
    this.latest.clear();
    // Previously observed minute prices remain useful within the sample-gap
    // limit. Production still discards the interrupted training label above.
    if (last && atMs !== undefined && (!Number.isFinite(atMs) || atMs < last.atMs
      || atMs - last.atMs > CROSS_ASSET_SPEC.maximumSampleGapMs)) this.history = [];
  }
  /** Offline and live fitting share the same price and label gap rules. */
  public observeHistorical(quote: CrossAssetQuote): void {
    this.observe(quote);
  }
  /** Historical labels may seed learning, but an unfinished historical interval
   * and historical quotes must never authorize or label a live entry. Retain
   * minute features only across the existing bounded sampling gap. */
  public prepareForLive(nowMs: number) {
    if (!Number.isFinite(nowMs)) throw new Error("INVALID_CROSS_ASSET_HANDOFF_TIME");
    const discardedIncompleteInterval = Boolean(this.pending);
    delete this.pending; this.latest.clear();
    const last = this.history.at(-1);
    const historyRetained = Boolean(last && nowMs >= last.atMs
      && nowMs - last.atMs <= CROSS_ASSET_SPEC.maximumSampleGapMs);
    if (!historyRetained) this.history = [];
    if (this.trainedThroughMs !== null && (nowMs < this.trainedThroughMs
      || nowMs - this.trainedThroughMs > CROSS_ASSET_SPEC.maximumModelAgeMs)) {
      this.invalidate(nowMs); this.history = []; this.labels = 0; this.trainedThroughMs = null; this.trainingResets++;
      for (let s = 0; s < 2; s++) {
        this.learners[s] = EXPERTS.map((e) => new DynamicBayes(e.columns.length, e.halfLife));
        this.weights[s] = EXPERTS.map(() => 1 / EXPERTS.length);
      }
    }
    return { discardedIncompleteInterval, historyRetained: historyRetained && this.history.length > 0,
      priceHistoryReady: historyRetained && this.history.length >= 55
        && this.history.at(-1)!.atMs - this.history[0]!.atMs >= CROSS_ASSET_SPEC.historyMs };
  }
  public stats(nowMs = this.history.at(-1)?.atMs ?? 0) {
    const last = this.history.at(-1), historyCoverageMs = last ? last.atMs - this.history[0]!.atMs : 0;
    return { version: this.version, labelsPerSymbol: this.labels,
    trainedThroughMs: this.trainedThroughMs, invalidLabelPairs: this.invalidLabels, historySamples: this.history.length,
    historyCoverageMs, priceHistoryReady: Boolean(last && this.history.length >= 55
      && historyCoverageMs >= CROSS_ASSET_SPEC.historyMs && nowMs >= last.atMs
      && nowMs - last.atMs <= CROSS_ASSET_SPEC.maximumSampleGapMs),
    trainingResets: this.trainingResets, prequentialErrors: CROSS_ASSET_SYMBOLS.map((symbol, i) => ({ symbol,
      labels: this.errors[i]!.labels,
      modelMseBpsSquared: this.errors[i]!.labels ? this.errors[i]!.squared / this.errors[i]!.labels : null,
      zeroForecastMseBpsSquared: this.errors[i]!.labels ? this.errors[i]!.zeroSquared / this.errors[i]!.labels : null })) }; }
  public observe(quote: CrossAssetQuote): CrossAssetForecast[] {
    if (!(CROSS_ASSET_SYMBOLS as readonly string[]).includes(quote.symbol)) return [];
    const previous = this.latest.get(quote.symbol);
    if (!quote.valid || ![quote.atMs, quote.bid, quote.ask].every(Number.isFinite) || quote.bid <= 0 || quote.ask <= quote.bid
      || previous && quote.atMs < previous.atMs) { this.invalidate(quote.atMs, !Number.isFinite(quote.atMs)
        || Boolean(previous && quote.atMs < previous.atMs)); return []; }
    if (this.trainedThroughMs !== null && quote.atMs - this.trainedThroughMs > CROSS_ASSET_SPEC.maximumModelAgeMs) {
      this.invalidate(quote.atMs, true); this.history = []; this.labels = 0; this.trainedThroughMs = null; this.trainingResets++;
      for (let s = 0; s < 2; s++) {
        this.learners[s] = EXPERTS.map((e) => new DynamicBayes(e.columns.length, e.halfLife));
        this.weights[s] = EXPERTS.map(() => 1 / EXPERTS.length);
      }
    }
    if (previous && quote.atMs - previous.atMs > CROSS_ASSET_SPEC.maximumQuoteGapMs) this.invalidate(quote.atMs);
    this.latest.set(quote.symbol, { ...quote });
    const quotes = CROSS_ASSET_SYMBOLS.map((s) => this.latest.get(s));
    if (quotes.some((q) => !q || q.atMs > quote.atMs || quote.atMs - q.atMs > CROSS_ASSET_SPEC.maximumQuoteAgeMs)) return [];
    const atMs = quote.atMs, last = this.history.at(-1);
    if (last && atMs - last.atMs < CROSS_ASSET_SPEC.sampleMs) return [];
    if (last && atMs - last.atMs > CROSS_ASSET_SPEC.maximumSampleGapMs) {
      this.invalidate(atMs); this.latest.set(quote.symbol, { ...quote }); return [];
    }
    const pair: Pair = { atMs, mids: quotes.map((q) => (q!.bid + q!.ask) / 2) as [number, number] };
    this.history.push(pair);
    this.history = this.history.filter((p) => atMs - p.atMs <= CROSS_ASSET_SPEC.historyMs + CROSS_ASSET_SPEC.maximumSampleGapMs);
    if (this.pending && atMs >= this.pending.pair.atMs + this.horizonMs) {
      if (atMs - this.pending.pair.atMs > this.horizonMs + CROSS_ASSET_SPEC.maximumSampleGapMs) this.invalidLabels++;
      else {
        for (let s = 0; s < 2; s++) {
          const y = (pair.mids[s]! / this.pending.pair.mids[s]! - 1) * 10_000 / CROSS_ASSET_SPEC.returnScaleBps;
          this.onTrainingLabel?.({ symbol: CROSS_ASSET_SYMBOLS[s]!, startMs: this.pending.pair.atMs, endMs: atMs,
            trainingLabelsBefore: this.labels, predictedGrossBps: this.pending.means[s]! * CROSS_ASSET_SPEC.returnScaleBps,
            actualGrossBps: y * CROSS_ASSET_SPEC.returnScaleBps });
          if (this.labels >= CROSS_ASSET_SPEC.minimumLabels) {
            const e = this.errors[s]!; e.labels++;
            e.squared += ((y - this.pending.means[s]!) * CROSS_ASSET_SPEC.returnScaleBps) ** 2;
            e.zeroSquared += (y * CROSS_ASSET_SPEC.returnScaleBps) ** 2;
          }
          const logWeights = EXPERTS.map((_, j) => CROSS_ASSET_SPEC.weightMemory * Math.log(this.weights[s]![j]!)
            + studentLogDensity(y, this.pending!.predictions[s]![j]!));
          const maximum = Math.max(...logWeights), total = logWeights.reduce((sum, v) => sum + Math.exp(v - maximum), 0);
          this.weights[s] = logWeights.map((v) => .99 * Math.exp(v - maximum) / total + .01 / EXPERTS.length);
          EXPERTS.forEach((e, j) => this.learners[s]![j]!.update(e.columns.map((c) => this.pending!.features[s]![c]!), y));
        }
        this.labels++; this.trainedThroughMs = atMs;
      }
      delete this.pending;
    }
    if (this.history.length < 55 || atMs - this.history[0]!.atMs < CROSS_ASSET_SPEC.historyMs) return [];
    const features = [this.features(0), this.features(1)];
    if (features.some((f) => !f)) return [];
    const predictions = features.map((f, s) => EXPERTS.map((e, j) => this.learners[s]![j]!.predict(e.columns.map((c) => f!.x[c]!))));
    if (!this.pending) this.pending = { pair, features: features.map((f) => f!.x), predictions,
      means: predictions.map((p, s) => p.reduce((sum, v, j) => sum + this.weights[s]![j]! * v.mean, 0)) };
    return CROSS_ASSET_SYMBOLS.map((symbol, s) => {
      const weights = this.weights[s]!, p = predictions[s]!, mean = p.reduce((sum, v, j) => sum + weights[j]! * v.mean, 0);
      const mixtureVariance = (field: "meanVariance" | "predictiveVariance") => p.reduce((sum, v, j) =>
        sum + weights[j]! * (v[field] + (v.mean - mean) ** 2), 0);
      const predictedGrossBps = mean * CROSS_ASSET_SPEC.returnScaleBps;
      const parameterUncertaintyBps = Math.sqrt(mixtureVariance("meanVariance")) * CROSS_ASSET_SPEC.returnScaleBps;
      const predictiveStdBps = Math.sqrt(mixtureVariance("predictiveVariance")) * CROSS_ASSET_SPEC.returnScaleBps;
      const spreadBps = (quotes[s]!.ask - quotes[s]!.bid) / pair.mids[s]! * 10_000;
      const costHurdleBps = 2 * this.costs[symbol]!.feeBps + this.costs[symbol]!.reserveBps + spreadBps;
      const conservativeNetBps = Math.abs(predictedGrossBps) - CROSS_ASSET_SPEC.parameterPenalty * parameterUncertaintyBps
        - CROSS_ASSET_SPEC.predictiveRiskPenalty * predictiveStdBps - costHurdleBps;
      const reason = this.labels < CROSS_ASSET_SPEC.minimumLabels ? "TRAINING"
        : features[s]!.outOfDomain ? "OUT_OF_DOMAIN" : conservativeNetBps <= 0 ? "COST_OR_UNCERTAINTY" : "POSITIVE_RESEARCH_FORECAST";
      return { version: this.version, symbol, atMs, horizonMs: this.horizonMs,
        trainingLabels: this.labels, trainedThroughMs: this.trainedThroughMs, referenceMid: pair.mids[s]!,
        side: predictedGrossBps >= 0 ? 1 : -1,
        predictedGrossBps, parameterUncertaintyBps, predictiveStdBps, costHurdleBps, conservativeNetBps,
        eligible: reason === "POSITIVE_RESEARCH_FORECAST", reason, factorBeta: features[s]!.beta,
        expertWeights: Object.fromEntries(EXPERTS.map((e, j) => [e.name, weights[j]!])) };
    });
  }
  private features(s: number): { x: number[]; beta: number; outOfDomain: boolean } | null {
    const current = this.history.at(-1)!, other = 1 - s;
    const ret = (minutes: number, symbol: number): number | null => {
      const point = [...this.history].reverse().find((p) => p.atMs <= current.atMs - minutes * 60_000);
      return point && current.atMs - minutes * 60_000 - point.atMs <= CROSS_ASSET_SPEC.maximumSampleGapMs
        ? Math.log(current.mids[symbol]! / point.mids[symbol]!) * 10_000 : null;
    };
    const returns = [ret(5, s), ret(15, s), ret(60, s), ret(5, other), ret(15, other)];
    if (returns.some((r) => r === null)) return null;
    const increments = this.history.slice(1).map((p, i) => p.mids.map((mid, j) => Math.log(mid / this.history[i]!.mids[j]!) * 10_000));
    const average = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const a = average(increments.map((p) => p[s]!)), b = average(increments.map((p) => p[other]!));
    const covariance = average(increments.map((p) => (p[s]! - a) * (p[other]! - b)));
    const variance = average(increments.map((p) => (p[other]! - b) ** 2));
    const beta = Math.max(0, Math.min(3, covariance / Math.max(.01, variance)));
    const ownMean = average(this.history.map((p) => Math.log(p.mids[s]!)));
    const otherMean = average(this.history.map((p) => Math.log(p.mids[other]!)));
    const relative = (Math.log(current.mids[s]!) - ownMean - beta * (Math.log(current.mids[other]!) - otherMean)) * 10_000;
    const raw = [1, ...returns.map((r) => r! / CROSS_ASSET_SPEC.returnScaleBps),
      (returns[1]! - beta * returns[4]!) / CROSS_ASSET_SPEC.returnScaleBps,
      relative / CROSS_ASSET_SPEC.returnScaleBps,
      (Math.log(current.mids[s]!) - ownMean) * 10_000 / CROSS_ASSET_SPEC.returnScaleBps];
    return { beta, outOfDomain: raw.some((v) => Math.abs(v) > CROSS_ASSET_SPEC.maximumFeature),
      x: raw.map((v) => Math.max(-CROSS_ASSET_SPEC.maximumFeature, Math.min(CROSS_ASSET_SPEC.maximumFeature, v))) };
  }
}
