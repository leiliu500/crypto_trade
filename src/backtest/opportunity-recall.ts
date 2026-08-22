import type { EngineConfig, SymbolConfig } from "../config.js";
import { FeatureEngine } from "../core/features.js";
import type { BookState, Direction, Features } from "../core/market.js";
import { LocalOrderBook } from "../core/order-book.js";
import { ExecutionPlanner } from "../execution/planner.js";
import { RiskSizer } from "../risk/sizing.js";
import { CostModel } from "../strategy/cost.js";
import { DeterministicEntryEngine, type DeterministicEvaluation } from "../strategy/deterministic-entry.js";
import { BookPressureTracker, DeterministicFeatureExtensions, type DeterministicFeatures } from "../strategy/deterministic-features.js";
import { DeterministicRegimeEngine } from "../strategy/deterministic-regime.js";
import { DynamicLiquidityPolicy } from "../strategy/dynamic-liquidity.js";
import { readRecordedEvents } from "./replay.js";

interface RecallPoint {
  atMs: number;
  bid: number;
  ask: number;
  evaluation: DeterministicEvaluation;
}
interface RecallSignal { atMs: number; side: Direction; bid: number; ask: number }
interface OpportunityWindow { startMs: number; endMs: number; peakNetBps: number }
export interface EconomicCandidateAudit {
  side: Direction; lowerBoundNetBps: number; grossOpportunityBps: number; uncertaintyReserveBps: number;
  estimatedCostBps: number; robustCostBps: number; shortfallBps: number; continuationQuality: number;
  requiredContinuationQuality: number | null; horizonMs: number; executionPath: string | null; edgeSource: string;
}
interface DirectionCandidateCounts {
  evaluations: number; regimePass: number; quorumPass: number; scorePass: number; arbitrationPass: number;
  antiChasePass: number; rawDirectionalPass: number; persistencePass: number; candidatePass: number;
  liquidityPass: number; slowTrendPass: number; edgeResolvedPass: number; preliminaryCostPass: number;
  maximumPersistence: number; maximumConfirmationMs: number; maximumConfirmationEvents: number;
}
interface OfflineRuntime {
  config: SymbolConfig;
  book: LocalOrderBook;
  features: FeatureEngine;
  pressure: BookPressureTracker;
  extensions: DeterministicFeatureExtensions;
  regime: DeterministicRegimeEngine;
  entry: DeterministicEntryEngine;
  liquidity: DynamicLiquidityPolicy;
  planner: ExecutionPlanner;
  points: RecallPoint[];
  signals: RecallSignal[];
  rawSignals: RecallSignal[];
  candidateSignals: RecallSignal[];
  blockReasons: Map<string, number>;
  lastSampleMs: number;
  staleEvents: number;
  nonFiniteEvents: number;
  evaluationEvents: number;
  rawDirectionalEvents: number;
  directionalCandidateEvents: number;
  costQualifiedIntentEvents: number;
  directionCounters: { long: DirectionCandidateCounts; short: DirectionCandidateCounts };
  bestCandidateEconomics: EconomicCandidateAudit | null;
}

export interface DirectionRecallReport {
  venueEligible: boolean;
  opportunityWindows: number;
  capturedWindows: number;
  recall: number;
  maximumNetMoveBps: number;
  signalCount: number;
  profitableSignals: number;
  precision: number;
  rawSignalCount: number;
  rawCapturedWindows: number;
  rawRecall: number;
  candidateSignalCount: number;
  candidateCapturedWindows: number;
  candidateRecall: number;
}
export interface SymbolRecallReport {
  samples: number;
  staleEvents: number;
  nonFiniteEvents: number;
  maximumLongScore: number;
  minimumModeledCostBps: number | null;
  evaluationEvents: number;
  rawDirectionalEvents: number;
  directionalCandidateEvents: number;
  costQualifiedIntentEvents: number;
  directionPipeline: { long: DirectionCandidateCounts; short: DirectionCandidateCounts };
  blockReasons: Record<string, number>;
  bestCandidateEconomics: EconomicCandidateAudit | null;
  long: DirectionRecallReport;
  shortAuditOnly: DirectionRecallReport;
}
export interface OpportunityRecallReport {
  recording: { path: string; events: number; books: number; trades: number; firstTsMs: number | null; lastTsMs: number | null; durationMs: number };
  assumptions: { sampleIntervalMs: number; opportunityHorizonMs: number; minimumNetMoveBps: number; label: string };
  symbols: Record<string, SymbolRecallReport>;
  tuning: { ready: boolean; observedDurationMs: number; requiredDurationMs: number; opportunityWindows: number; requiredOpportunityWindows: number; reason: string | null };
}

export async function analyzeOpportunityRecall(path: string, cfg: EngineConfig,
  options: { economicOnly?: boolean } = {}): Promise<OpportunityRecallReport> {
  const runtimes = new Map<string, OfflineRuntime>();
  for (const symbol of cfg.symbols) {
    const symbolCfg = cfg.symbolConfigs[symbol];
    if (!symbolCfg) throw new Error(`Missing symbol configuration for ${symbol}`);
    const cost = new CostModel(symbolCfg.cost);
    runtimes.set(symbol, {
      config: symbolCfg,
      book: new LocalOrderBook(symbol),
      features: new FeatureEngine(symbolCfg.feature),
      pressure: new BookPressureTracker(symbolCfg.feature.depthLevels),
      extensions: new DeterministicFeatureExtensions(symbolCfg.deterministicExtension),
      regime: new DeterministicRegimeEngine(symbolCfg.deterministicRegime),
      entry: new DeterministicEntryEngine(symbolCfg.deterministicSignal),
      liquidity: new DynamicLiquidityPolicy(symbolCfg.dynamicLiquidity),
      planner: new ExecutionPlanner(symbolCfg.planner, new RiskSizer(symbolCfg.sizing), cost, symbolCfg.strategyVersion, symbolCfg.modelVersion),
      points: [], signals: [], rawSignals: [], candidateSignals: [], blockReasons: new Map(), lastSampleMs: Number.NEGATIVE_INFINITY,
      staleEvents: 0, nonFiniteEvents: 0, evaluationEvents: 0, rawDirectionalEvents: 0,
      directionalCandidateEvents: 0, costQualifiedIntentEvents: 0,
      directionCounters: { long: emptyDirectionCounts(), short: emptyDirectionCounts() },
      bestCandidateEconomics: null,
    });
  }

  let events = 0, books = 0, trades = 0;
  let firstTsMs: number | null = null, lastTsMs: number | null = null;
  for await (const event of readRecordedEvents(path)) {
    events += 1;
    const atMs = event.kind === "BOOK" ? event.delta.receiveTsMs : event.kind === "TRADE" ? event.trade.receiveTsMs
      : event.kind === "DISCONNECT" ? event.receiveTsMs : null;
    if (atMs !== null) { firstTsMs ??= atMs; lastTsMs = atMs; }
    if (event.kind === "BOOK") {
      books += 1;
      const runtime = runtimes.get(event.delta.symbol);
      if (!runtime) continue;
      const applied = runtime.book.apply(event.delta);
      if (!applied.accepted || !applied.state || applied.duplicate) continue;
      const base = runtime.features.onBook(applied.state, applied.flow);
      if (base) processState(runtime, applied.state, base, cfg);
    } else if (event.kind === "TRADE") {
      trades += 1;
      const runtime = runtimes.get(event.trade.symbol);
      if (!runtime) continue;
      runtime.features.onTrade(event.trade);
      const snapshot = runtime.book.snapshot();
      if (!snapshot.valid) continue;
      const eventBook: BookState = { ...snapshot, receiveTsMs: event.trade.receiveTsMs };
      const base = runtime.features.onBook(eventBook);
      if (base) processState(runtime, eventBook, base, cfg);
    } else if (event.kind === "DISCONNECT") {
      for (const runtime of runtimes.values()) runtime.book.invalidate();
    }
  }

  const durationMs = firstTsMs === null || lastTsMs === null ? 0 : Math.max(0, lastTsMs - firstTsMs);
  const symbols: Record<string, SymbolRecallReport> = {};
  let opportunityWindows = 0;
  for (const [symbol, runtime] of runtimes) {
    const long = options.economicOnly ? emptyDirectionReport(true, runtime.signals.length) : directionReport(runtime, 1, cfg);
    const shortAuditOnly = options.economicOnly ? emptyDirectionReport(false, runtime.signals.length) : directionReport(runtime, -1, cfg);
    opportunityWindows += long.opportunityWindows;
    const finiteLongScores = runtime.points.map((point) => point.evaluation.long.score).filter(Number.isFinite);
    const modeledCosts = runtime.points.flatMap((point) => [point.evaluation.long.roundTripCostBps, point.evaluation.short.roundTripCostBps]).filter(Number.isFinite);
    symbols[symbol] = {
      samples: runtime.points.length, staleEvents: runtime.staleEvents, nonFiniteEvents: runtime.nonFiniteEvents,
      maximumLongScore: finiteLongScores.length ? Math.max(...finiteLongScores) : 0,
      minimumModeledCostBps: modeledCosts.length ? Math.min(...modeledCosts) : null,
      evaluationEvents: runtime.evaluationEvents, rawDirectionalEvents: runtime.rawDirectionalEvents,
      directionalCandidateEvents: runtime.directionalCandidateEvents,
      costQualifiedIntentEvents: runtime.costQualifiedIntentEvents,
      directionPipeline: { long: { ...runtime.directionCounters.long }, short: { ...runtime.directionCounters.short } },
      blockReasons: Object.fromEntries([...runtime.blockReasons].sort((a, b) => b[1] - a[1])),
      bestCandidateEconomics: runtime.bestCandidateEconomics ? { ...runtime.bestCandidateEconomics } : null,
      long, shortAuditOnly,
    };
  }
  const durationReady = durationMs >= cfg.recall.minimumTuningDurationMs;
  const opportunitiesReady = opportunityWindows >= cfg.recall.minimumTuningOpportunities;
  const ready = durationReady && opportunitiesReady;
  const reason = ready ? null : !durationReady
    ? `Recording duration is below ${cfg.recall.minimumTuningDurationMs} ms`
    : `Only ${opportunityWindows} eligible opportunity windows were observed`;
  return {
    recording: { path, events, books, trades, firstTsMs, lastTsMs, durationMs },
    assumptions: {
      sampleIntervalMs: cfg.recall.sampleIntervalMs,
      opportunityHorizonMs: cfg.recall.opportunityHorizonMs,
      minimumNetMoveBps: cfg.recall.minimumNetMoveBps,
      label: "Best executable bid/ask move within the horizon minus two taker fees and fixed adverse/funding/borrow costs; latency and impact omitted, so recall is an optimistic upper bound",
    },
    symbols,
    tuning: { ready, observedDurationMs: durationMs, requiredDurationMs: cfg.recall.minimumTuningDurationMs,
      opportunityWindows, requiredOpportunityWindows: cfg.recall.minimumTuningOpportunities, reason },
  };
}

function processState(runtime: OfflineRuntime, book: BookState, base: Features, cfg: EngineConfig): void {
  const features = runtime.extensions.update(base, runtime.pressure.update(book));
  if (!allNumbersFinite(features)) runtime.nonFiniteEvents += 1;
  if (features.stale || !features.warmedUp) {
    runtime.staleEvents += 1;
    if (!features.stale) runtime.liquidity.observe(features.spreadBps);
    return;
  }
  const longCost = runtime.planner.preliminaryCost(features, book, 1, 0);
  const shortCost = runtime.planner.preliminaryCost(features, book, -1, 0);
  const longEconomicCosts = runtime.planner.economicCosts(features, book, 1, 0);
  const shortEconomicCosts = runtime.planner.economicCosts(features, book, -1, 0);
  if (!longCost || !shortCost) { runtime.liquidity.observe(features.spreadBps); return; }
  const longLiquidity = runtime.liquidity.evaluate(liquidityInput(features, longCost.impactBps));
  const shortLiquidity = runtime.liquidity.evaluate(liquidityInput(features, shortCost.impactBps));
  runtime.liquidity.observe(features.spreadBps);
  const classified = runtime.regime.classify(features);
  const intent = runtime.entry.evaluate({
    symbol: book.symbol, sequence: book.sequence, nowMs: features.receiveTsMs, features, regime: classified,
    system: { bookValid: true, sequenceValid: true, checksumValid: true, publicStreamHealthy: true, privateStreamHealthy: true,
      accountReconciled: true, clockHealthy: true, entriesAllowed: true, noExistingPosition: true, noPendingEntry: true },
    bestBid: book.bids[0]!.px, bestAsk: book.asks[0]!.px,
    longCost, shortCost, longEconomicCosts, shortEconomicCosts, longLiquidity, shortLiquidity,
  });
  if (intent) {
    runtime.signals.push({ atMs: features.receiveTsMs, side: intent.side, bid: book.bids[0]!.px, ask: book.asks[0]!.px });
  }
  const latest = runtime.entry.latestEvaluation();
  if (latest) {
    runtime.evaluationEvents += 1;
    if (latest.long.rawDirectionalPass || latest.short.rawDirectionalPass) runtime.rawDirectionalEvents += 1;
    if (latest.candidate) runtime.directionalCandidateEvents += 1;
    if (latest.intent) runtime.costQualifiedIntentEvents += 1;
    incrementDirection(runtime.directionCounters.long, latest.long);
    incrementDirection(runtime.directionCounters.short, latest.short);
    if (latest.long.rawDirectionalPass) runtime.rawSignals.push({ atMs: features.receiveTsMs, side: 1, bid: book.bids[0]!.px, ask: book.asks[0]!.px });
    if (latest.short.rawDirectionalPass) runtime.rawSignals.push({ atMs: features.receiveTsMs, side: -1, bid: book.bids[0]!.px, ask: book.asks[0]!.px });
    if (latest.candidate) runtime.candidateSignals.push({ atMs: features.receiveTsMs, side: latest.candidate.side, bid: book.bids[0]!.px, ask: book.asks[0]!.px });
    if (latest.candidate) {
      const diagnostics = latest.candidate.diagnostics;
      const candidate: EconomicCandidateAudit = {
        side: latest.candidate.side, lowerBoundNetBps: diagnostics.lowerBoundNetBps,
        grossOpportunityBps: diagnostics.grossOpportunityBps,
        uncertaintyReserveBps: diagnostics.uncertaintyReserveBps,
        estimatedCostBps: diagnostics.roundTripCostBps, robustCostBps: diagnostics.robustCostBps,
        shortfallBps: diagnostics.costShortfallBps, continuationQuality: diagnostics.continuationQuality,
        requiredContinuationQuality: diagnostics.requiredContinuationQuality,
        horizonMs: diagnostics.edgeHorizonMs, executionPath: diagnostics.executionPath ?? null,
        edgeSource: diagnostics.edgeSource,
      };
      if (!runtime.bestCandidateEconomics || candidate.lowerBoundNetBps > runtime.bestCandidateEconomics.lowerBoundNetBps) {
        runtime.bestCandidateEconomics = candidate;
      }
    }
    for (const reason of [...latest.long.reasons, ...latest.short.reasons]) {
      runtime.blockReasons.set(reason, (runtime.blockReasons.get(reason) ?? 0) + 1);
    }
  }
  if (features.receiveTsMs - runtime.lastSampleMs < cfg.recall.sampleIntervalMs) return;
  const evaluation = runtime.entry.latestEvaluation();
  if (!evaluation) return;
  runtime.lastSampleMs = features.receiveTsMs;
  runtime.points.push({ atMs: features.receiveTsMs, bid: book.bids[0]!.px, ask: book.asks[0]!.px, evaluation });
}

function directionReport(runtime: OfflineRuntime, side: Direction, cfg: EngineConfig): DirectionRecallReport {
  const feesAndFixedCosts = 2 * runtime.config.cost.takerFeeBps + runtime.config.cost.adverseSelectionBps
    + runtime.config.cost.fundingBps + runtime.config.cost.borrowBps;
  const labels = runtime.points.map((point, index) => bestNetMove(runtime.points, index, side, cfg.recall.opportunityHorizonMs, feesAndFixedCosts));
  const windows = groupWindows(runtime.points, labels, cfg.recall.minimumNetMoveBps, cfg.recall.sampleIntervalMs);
  const signals = runtime.signals.filter((signal) => signal.side === side);
  const rawSignals = runtime.rawSignals.filter((signal) => signal.side === side);
  const candidateSignals = runtime.candidateSignals.filter((signal) => signal.side === side);
  const captured = windows.filter((window) => signals.some((signal) => signal.atMs >= window.startMs && signal.atMs <= window.endMs + cfg.recall.sampleIntervalMs)).length;
  const rawCaptured = windows.filter((window) => rawSignals.some((signal) => signal.atMs >= window.startMs && signal.atMs <= window.endMs + cfg.recall.sampleIntervalMs)).length;
  const candidateCaptured = windows.filter((window) => candidateSignals.some((signal) => signal.atMs >= window.startMs && signal.atMs <= window.endMs + cfg.recall.sampleIntervalMs)).length;
  const profitableSignals = signals.filter((signal) => bestNetForSignal(signal, runtime.points, cfg.recall.opportunityHorizonMs, feesAndFixedCosts) >= cfg.recall.minimumNetMoveBps).length;
  return {
    venueEligible: side === 1,
    opportunityWindows: windows.length, capturedWindows: captured, recall: ratio(captured, windows.length),
    maximumNetMoveBps: labels.length ? Math.max(0, ...labels.filter(Number.isFinite)) : 0,
    signalCount: signals.length, profitableSignals, precision: ratio(profitableSignals, signals.length),
    rawSignalCount: rawSignals.length, rawCapturedWindows: rawCaptured, rawRecall: ratio(rawCaptured, windows.length),
    candidateSignalCount: candidateSignals.length, candidateCapturedWindows: candidateCaptured,
    candidateRecall: ratio(candidateCaptured, windows.length),
  };
}

function emptyDirectionReport(venueEligible: boolean, signalCount: number): DirectionRecallReport {
  return { venueEligible, opportunityWindows: 0, capturedWindows: 0, recall: 0, maximumNetMoveBps: 0,
    signalCount, profitableSignals: 0, precision: 0, rawSignalCount: 0, rawCapturedWindows: 0,
    rawRecall: 0, candidateSignalCount: 0, candidateCapturedWindows: 0, candidateRecall: 0 };
}

function bestNetMove(points: readonly RecallPoint[], index: number, side: Direction, horizonMs: number, costsBps: number): number {
  const entry = points[index]!;
  let best = Number.NEGATIVE_INFINITY;
  for (let cursor = index + 1; cursor < points.length && points[cursor]!.atMs <= entry.atMs + horizonMs; cursor += 1) {
    const future = points[cursor]!;
    const gross = side === 1 ? (future.bid / entry.ask - 1) * 10_000 : (entry.bid / future.ask - 1) * 10_000;
    best = Math.max(best, gross - costsBps);
  }
  return best;
}

function bestNetForSignal(signal: RecallSignal, points: readonly RecallPoint[], horizonMs: number, costsBps: number): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.atMs <= signal.atMs || point.atMs > signal.atMs + horizonMs) continue;
    const gross = signal.side === 1 ? (point.bid / signal.ask - 1) * 10_000 : (signal.bid / point.ask - 1) * 10_000;
    best = Math.max(best, gross - costsBps);
  }
  return best;
}

function groupWindows(points: readonly RecallPoint[], labels: readonly number[], thresholdBps: number, sampleIntervalMs: number): OpportunityWindow[] {
  const windows: OpportunityWindow[] = [];
  let active: OpportunityWindow | undefined;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!, net = labels[index]!;
    if (net >= thresholdBps) {
      if (!active || point.atMs - active.endMs > sampleIntervalMs * 1.5) {
        active = { startMs: point.atMs, endMs: point.atMs, peakNetBps: net };
        windows.push(active);
      } else {
        active.endMs = point.atMs;
        active.peakNetBps = Math.max(active.peakNetBps, net);
      }
    } else active = undefined;
  }
  return windows;
}

function allNumbersFinite(value: object): boolean {
  for (const item of Object.values(value)) if (typeof item === "number" && !Number.isFinite(item)) return false;
  return true;
}
function emptyDirectionCounts(): DirectionCandidateCounts {
  return { evaluations: 0, regimePass: 0, quorumPass: 0, scorePass: 0, arbitrationPass: 0, antiChasePass: 0,
    rawDirectionalPass: 0, persistencePass: 0, candidatePass: 0, liquidityPass: 0, slowTrendPass: 0,
    edgeResolvedPass: 0, preliminaryCostPass: 0,
    maximumPersistence: 0, maximumConfirmationMs: 0, maximumConfirmationEvents: 0 };
}
function incrementDirection(counts: DirectionCandidateCounts, diagnostics: DeterministicEvaluation["long"]): void {
  counts.evaluations += 1;
  if (diagnostics.regimePass) counts.regimePass += 1;
  if (diagnostics.votes.quorum) counts.quorumPass += 1;
  if (diagnostics.scorePass) counts.scorePass += 1;
  if (diagnostics.arbitrationPass) counts.arbitrationPass += 1;
  if (diagnostics.antiChasePass) counts.antiChasePass += 1;
  if (diagnostics.rawDirectionalPass) counts.rawDirectionalPass += 1;
  if (diagnostics.persistencePass) counts.persistencePass += 1;
  if (diagnostics.candidatePass) counts.candidatePass += 1;
  if (diagnostics.liquidityPass) counts.liquidityPass += 1;
  if (diagnostics.slowTrendPass) counts.slowTrendPass += 1;
  if (diagnostics.edgeResolvedPass) counts.edgeResolvedPass += 1;
  if (diagnostics.costPass) counts.preliminaryCostPass += 1;
  counts.maximumPersistence = Math.max(counts.maximumPersistence, diagnostics.persistence);
  counts.maximumConfirmationMs = Math.max(counts.maximumConfirmationMs, diagnostics.confirmationMs);
  counts.maximumConfirmationEvents = Math.max(counts.maximumConfirmationEvents, diagnostics.confirmationEvents);
}
function liquidityInput(features: DeterministicFeatures, impactBps: number) {
  return {
    spreadBps: features.spreadBps, spreadZ: features.spreadZ, depthZ: features.depthZ,
    impactBps, providerAgeMs: features.providerAgeMs,
    stale: features.stale,
  };
}
function ratio(numerator: number, denominator: number): number { return denominator > 0 ? numerator / denominator : 0; }
