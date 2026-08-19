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
import { readRecordedEvents } from "./replay.js";

interface RecallPoint {
  atMs: number;
  bid: number;
  ask: number;
  evaluation: DeterministicEvaluation;
}
interface RecallSignal { atMs: number; side: Direction; bid: number; ask: number }
interface OpportunityWindow { startMs: number; endMs: number; peakNetBps: number }
interface OfflineRuntime {
  config: SymbolConfig;
  book: LocalOrderBook;
  features: FeatureEngine;
  pressure: BookPressureTracker;
  extensions: DeterministicFeatureExtensions;
  regime: DeterministicRegimeEngine;
  entry: DeterministicEntryEngine;
  planner: ExecutionPlanner;
  points: RecallPoint[];
  signals: RecallSignal[];
  blockReasons: Map<string, number>;
  lastSampleMs: number;
  staleEvents: number;
  nonFiniteEvents: number;
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
}
export interface SymbolRecallReport {
  samples: number;
  staleEvents: number;
  nonFiniteEvents: number;
  maximumLongScore: number;
  minimumModeledCostBps: number | null;
  blockReasons: Record<string, number>;
  long: DirectionRecallReport;
  shortAuditOnly: DirectionRecallReport;
}
export interface OpportunityRecallReport {
  recording: { path: string; events: number; books: number; trades: number; firstTsMs: number | null; lastTsMs: number | null; durationMs: number };
  assumptions: { sampleIntervalMs: number; opportunityHorizonMs: number; minimumNetMoveBps: number; label: string };
  symbols: Record<string, SymbolRecallReport>;
  tuning: { ready: boolean; observedDurationMs: number; requiredDurationMs: number; opportunityWindows: number; requiredOpportunityWindows: number; reason: string | null };
}

export async function analyzeOpportunityRecall(path: string, cfg: EngineConfig): Promise<OpportunityRecallReport> {
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
      planner: new ExecutionPlanner(symbolCfg.planner, new RiskSizer(symbolCfg.sizing), cost, symbolCfg.strategyVersion, symbolCfg.modelVersion),
      points: [], signals: [], blockReasons: new Map(), lastSampleMs: Number.NEGATIVE_INFINITY,
      staleEvents: 0, nonFiniteEvents: 0,
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
    const long = directionReport(runtime, 1, cfg);
    const shortAuditOnly = directionReport(runtime, -1, cfg);
    opportunityWindows += long.opportunityWindows;
    const finiteLongScores = runtime.points.map((point) => point.evaluation.long.score).filter(Number.isFinite);
    const modeledCosts = runtime.points.flatMap((point) => [point.evaluation.long.roundTripCostBps, point.evaluation.short.roundTripCostBps]).filter(Number.isFinite);
    symbols[symbol] = {
      samples: runtime.points.length, staleEvents: runtime.staleEvents, nonFiniteEvents: runtime.nonFiniteEvents,
      maximumLongScore: finiteLongScores.length ? Math.max(...finiteLongScores) : 0,
      minimumModeledCostBps: modeledCosts.length ? Math.min(...modeledCosts) : null,
      blockReasons: Object.fromEntries([...runtime.blockReasons].sort((a, b) => b[1] - a[1])),
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
  if (features.stale || !features.warmedUp) { runtime.staleEvents += 1; return; }
  const longCost = runtime.planner.preliminaryCost(features, book, 1, 0);
  const shortCost = runtime.planner.preliminaryCost(features, book, -1, 0);
  if (!longCost || !shortCost) return;
  const classified = runtime.regime.classify(features);
  const spotRegime = classified.allowShort ? { ...classified, allowShort: false } : classified;
  const intent = runtime.entry.evaluate({
    symbol: book.symbol, sequence: book.sequence, nowMs: features.receiveTsMs, features, regime: spotRegime,
    system: { bookValid: true, sequenceValid: true, checksumValid: true, publicStreamHealthy: true, privateStreamHealthy: true,
      accountReconciled: true, clockHealthy: true, entriesAllowed: true, noExistingPosition: true, noPendingEntry: true },
    bestBid: book.bids[0]!.px, bestAsk: book.asks[0]!.px,
    expectedLatencyMs: runtime.config.deterministicSignal.expectedLatencyMs, longCost, shortCost,
  });
  if (intent) {
    runtime.signals.push({ atMs: features.receiveTsMs, side: intent.side, bid: book.bids[0]!.px, ask: book.asks[0]!.px });
    runtime.entry.markFired(intent.side, features.receiveTsMs);
  }
  if (features.receiveTsMs - runtime.lastSampleMs < cfg.recall.sampleIntervalMs) return;
  const evaluation = runtime.entry.latestEvaluation();
  if (!evaluation) return;
  runtime.lastSampleMs = features.receiveTsMs;
  runtime.points.push({ atMs: features.receiveTsMs, bid: book.bids[0]!.px, ask: book.asks[0]!.px, evaluation });
  for (const reason of [...evaluation.long.reasons, ...evaluation.short.reasons]) runtime.blockReasons.set(reason, (runtime.blockReasons.get(reason) ?? 0) + 1);
}

function directionReport(runtime: OfflineRuntime, side: Direction, cfg: EngineConfig): DirectionRecallReport {
  const feesAndFixedCosts = 2 * runtime.config.cost.takerFeeBps + runtime.config.cost.adverseSelectionBps
    + runtime.config.cost.fundingBps + runtime.config.cost.borrowBps;
  const labels = runtime.points.map((point, index) => bestNetMove(runtime.points, index, side, cfg.recall.opportunityHorizonMs, feesAndFixedCosts));
  const windows = groupWindows(runtime.points, labels, cfg.recall.minimumNetMoveBps, cfg.recall.sampleIntervalMs);
  const signals = runtime.signals.filter((signal) => signal.side === side);
  const captured = windows.filter((window) => signals.some((signal) => signal.atMs >= window.startMs && signal.atMs <= window.endMs + cfg.recall.sampleIntervalMs)).length;
  const profitableSignals = signals.filter((signal) => bestNetForSignal(signal, runtime.points, cfg.recall.opportunityHorizonMs, feesAndFixedCosts) >= cfg.recall.minimumNetMoveBps).length;
  return {
    venueEligible: side === 1,
    opportunityWindows: windows.length, capturedWindows: captured, recall: ratio(captured, windows.length),
    maximumNetMoveBps: labels.length ? Math.max(0, ...labels.filter(Number.isFinite)) : 0,
    signalCount: signals.length, profitableSignals, precision: ratio(profitableSignals, signals.length),
  };
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
function ratio(numerator: number, denominator: number): number { return denominator > 0 ? numerator / denominator : 0; }
