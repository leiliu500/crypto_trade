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
import { pullbackState } from "../strategy/pullback-recovery.js";
import type { EarlyBreakoutConfig } from "../strategy/early-breakout.js";
import { readRecordedEvents } from "./replay.js";
import type { CalibratedEdgeBucket } from "../calibration/calibrated-edge-table.js";
import type { EntryFamily, ExecutionPath } from "../economics/types.js";
import type { RegimeName } from "../strategy/deterministic-regime.js";

interface RecallPoint {
  atMs: number;
  bid: number;
  ask: number;
}
interface RecallSignal {
  atMs: number; side: Direction; family: EntryFamily | null; bid: number; ask: number;
  horizonMs: number; robustCostBps: number; executionPath: ExecutionPath | null;
  reversalExtremeAgeMs: number | null;
}
interface OpportunityWindow { startMs: number; endMs: number; peakNetBps: number }
interface ForwardCalibrationCandidate {
  atMs: number; side: Direction; bid: number; ask: number; regime: RegimeName;
  family: EntryFamily; quality: number; spreadBps: number; horizonMs: number; executionPath: ExecutionPath;
}
export interface EconomicCandidateAudit {
  family: EntryFamily; side: Direction; lowerBoundNetBps: number; grossOpportunityBps: number; uncertaintyReserveBps: number;
  estimatedCostBps: number; robustCostBps: number; shortfallBps: number; continuationQuality: number;
  requiredContinuationQuality: number | null; horizonMs: number; executionPath: string | null; edgeSource: string;
}
interface DirectionCandidateCounts {
  evaluations: number; regimePass: number; directionAuthorizationPass: number; quorumPass: number;
  scorePass: number; arbitrationPass: number;
  antiChasePass: number; rawDirectionalPass: number; persistencePass: number; candidatePass: number;
  liquidityPass: number; slowTrendPass: number; edgeResolvedPass: number; preliminaryCostPass: number;
  pullbackRecoveryPass: number; earlyBreakoutPass: number; earlyBreakoutCandidatePass: number;
  earlyBreakoutCostPass: number; maximumEarlyBreakoutLowerBoundNetBps: number | null;
  bestEarlyBreakoutCandidate: EarlyBreakoutCandidateAudit | null;
  earlyBreakoutCandidateExamples: EarlyBreakoutCandidateAudit[];
  maximumPersistence: number; maximumConfirmationMs: number; maximumConfirmationEvents: number;
}
interface EarlyBreakoutCandidateAudit {
  atMs: number; passedChecks: number; totalChecks: number;
  family: EntryFamily; score: number; costPass: boolean; lowerBoundNetBps: number;
  grossOpportunityBps: number; uncertaintyReserveBps: number; robustCostBps: number;
  fastTrendBps: number; mediumTrendBps: number; slowTrendBps: number; slowTrendAlignment: number;
  displacementBps: number; velocityZ: number; flowFlipRate: number; failedChecks: string[];
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
  calibrationCandidates: ForwardCalibrationCandidate[];
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
  maximumLongScore: number;
  minimumModeledCostBps: number | null;
}

export interface PullbackRecencyShadow {
  maximumReversalAgeMs: number;
  signalCount: number;
  profitableSignals: number;
  precision: number;
}

export interface DirectionRecallReport {
  venueEligible: boolean;
  opportunityWindows: number;
  capturedWindows: number;
  recall: number;
  maximumNetMoveBps: number;
  signalCount: number;
  profitableSignals: number;
  pullbackSignalCount: number;
  profitablePullbackSignals: number;
  earlyBreakoutSignalCount: number;
  profitableEarlyBreakoutSignals: number;
  pullbackRecencyShadow: Record<string, PullbackRecencyShadow>;
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
  short: DirectionRecallReport;
  /** Retained for report compatibility; consult `short.venueEligible` before treating it as audit-only. */
  shortAuditOnly: DirectionRecallReport;
}
export interface OpportunityRecallReport {
  recording: {
    path: string;
    paths: string[];
    events: number;
    books: number;
    trades: number;
    disconnects: number;
    gaps: number;
    firstTsMs: number | null;
    lastTsMs: number | null;
    durationMs: number;
    coveredDurationMs: number;
  };
  assumptions: { sampleIntervalMs: number; opportunityHorizonMs: number; minimumNetMoveBps: number; label: string };
  symbols: Record<string, SymbolRecallReport>;
  tuning: { ready: boolean; observedDurationMs: number; requiredDurationMs: number; opportunityWindows: number; requiredOpportunityWindows: number; reason: string | null };
  calibration: {
    ready: boolean;
    candidateCounts: { long: number; short: number; venueEligible: number };
    buckets: CalibratedEdgeBucket[];
    deployableBuckets: number;
    reason: string | null;
  };
  acceptance: {
    passed: boolean;
    eligibleIntentSignals: number;
    profitableAfterCostEligibleSignals: number;
    longIntentSignals: number;
    profitableAfterCostLongSignals: number;
    reason: string | null;
  };
}

const PULLBACK_RECENCY_SHADOW_MS = [60_000, 120_000, 300_000, 600_000] as const;

export async function analyzeOpportunityRecall(path: string | readonly string[], cfg: EngineConfig,
  options: { economicOnly?: boolean } = {}): Promise<OpportunityRecallReport> {
  const paths = typeof path === "string" ? [path] : [...path];
  if (paths.length === 0) throw new Error("Opportunity recall requires at least one recording path");
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
      points: [], signals: [], rawSignals: [], candidateSignals: [], calibrationCandidates: [], blockReasons: new Map(), lastSampleMs: Number.NEGATIVE_INFINITY,
      staleEvents: 0, nonFiniteEvents: 0, evaluationEvents: 0, rawDirectionalEvents: 0,
      directionalCandidateEvents: 0, costQualifiedIntentEvents: 0,
      directionCounters: { long: emptyDirectionCounts(), short: emptyDirectionCounts() },
      bestCandidateEconomics: null,
      maximumLongScore: Number.NEGATIVE_INFINITY,
      minimumModeledCostBps: null,
    });
  }

  let events = 0, books = 0, trades = 0, disconnects = 0, gaps = 0, coveredDurationMs = 0;
  let firstTsMs: number | null = null, lastTsMs: number | null = null, previousTsMs: number | null = null;
  const coverageGapToleranceMs = Math.max(cfg.feature.absoluteMaxProviderAgeMs * 2, cfg.feature.maximumKinematicsGapMs);
  for (const recordingPath of paths) {
    for await (const event of readRecordedEvents(recordingPath)) {
      events += 1;
      const atMs = event.kind === "BOOK" ? event.delta.receiveTsMs : event.kind === "TRADE" ? event.trade.receiveTsMs
        : event.kind === "DISCONNECT" || event.kind === "RECORDER_GAP" ? event.receiveTsMs : null;
      if (atMs !== null) {
        firstTsMs ??= atMs;
        if (previousTsMs !== null && atMs >= previousTsMs && atMs - previousTsMs <= coverageGapToleranceMs) {
          coveredDurationMs += atMs - previousTsMs;
        }
        previousTsMs = previousTsMs === null ? atMs : Math.max(previousTsMs, atMs);
        lastTsMs = previousTsMs;
      }
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
      } else if (event.kind === "DISCONNECT" || event.kind === "RECORDER_GAP") {
        if (event.kind === "DISCONNECT") disconnects += 1;
        else gaps += 1;
        for (const runtime of runtimes.values()) runtime.book.invalidate();
      }
    }
  }

  const durationMs = firstTsMs === null || lastTsMs === null ? 0 : Math.max(0, lastTsMs - firstTsMs);
  const symbols: Record<string, SymbolRecallReport> = {};
  let opportunityWindows = 0;
  for (const [symbol, runtime] of runtimes) {
    const longSignals = runtime.signals.filter((signal) => signal.side === 1);
    const shortSignals = runtime.signals.filter((signal) => signal.side === -1);
    const shortVenueEligible = cfg.venue === "kraken_futures";
    const long = options.economicOnly ? emptyDirectionReport(true, longSignals.length,
      longSignals.filter((signal) => signal.family === "PULLBACK_RECOVERY").length) : directionReport(runtime, 1, cfg, true);
    const short = options.economicOnly ? emptyDirectionReport(shortVenueEligible, shortSignals.length,
      shortSignals.filter((signal) => signal.family === "PULLBACK_RECOVERY").length) : directionReport(runtime, -1, cfg, shortVenueEligible);
    opportunityWindows += long.opportunityWindows + (short.venueEligible ? short.opportunityWindows : 0);
    symbols[symbol] = {
      samples: runtime.points.length, staleEvents: runtime.staleEvents, nonFiniteEvents: runtime.nonFiniteEvents,
      maximumLongScore: Number.isFinite(runtime.maximumLongScore) ? runtime.maximumLongScore : 0,
      minimumModeledCostBps: runtime.minimumModeledCostBps,
      evaluationEvents: runtime.evaluationEvents, rawDirectionalEvents: runtime.rawDirectionalEvents,
      directionalCandidateEvents: runtime.directionalCandidateEvents,
      costQualifiedIntentEvents: runtime.costQualifiedIntentEvents,
      directionPipeline: { long: { ...runtime.directionCounters.long }, short: { ...runtime.directionCounters.short } },
      blockReasons: Object.fromEntries([...runtime.blockReasons].sort((a, b) => b[1] - a[1])),
      bestCandidateEconomics: runtime.bestCandidateEconomics ? { ...runtime.bestCandidateEconomics } : null,
      long, short, shortAuditOnly: short,
    };
  }
  const durationReady = coveredDurationMs >= cfg.recall.minimumTuningDurationMs;
  const opportunitiesReady = opportunityWindows >= cfg.recall.minimumTuningOpportunities;
  const ready = gaps === 0 && durationReady && opportunitiesReady;
  const reason = ready ? null : gaps > 0 ? `Recording contains ${gaps} explicit recorder gap(s)`
    : !durationReady ? `Covered recording duration is below ${cfg.recall.minimumTuningDurationMs} ms`
    : `Only ${opportunityWindows} eligible opportunity windows were observed`;
  const calibrationBuckets = options.economicOnly ? [] : forwardCalibrationBuckets(runtimes, cfg);
  const longCalibrationCandidates = [...runtimes.values()].reduce((total, runtime) => total
    + runtime.calibrationCandidates.filter((candidate) => candidate.side === 1).length, 0);
  const shortCalibrationCandidates = [...runtimes.values()].reduce((total, runtime) => total
    + runtime.calibrationCandidates.filter((candidate) => candidate.side === -1).length, 0);
  const deployableBuckets = ready ? calibrationBuckets.filter((bucket) => bucket.effectiveSampleCount >= cfg.deterministicSignal.minimumEffectiveSampleCount
    && bucket.lowerConfidenceGrossReturnBps > 0).length : 0;
  const calibrationReady = ready && deployableBuckets > 0;
  const calibrationReason = calibrationReady ? null : !ready ? reason
    : `No forward-return bucket has ${cfg.deterministicSignal.minimumEffectiveSampleCount} independent samples and a positive lower confidence bound`;
  const longIntentSignals = Object.values(symbols).reduce((sum, symbol) => sum + symbol.long.signalCount, 0);
  const profitableAfterCostLongSignals = Object.values(symbols).reduce((sum, symbol) => sum + symbol.long.profitableSignals, 0);
  const eligibleReports = Object.values(symbols).flatMap((symbol) => [symbol.long, symbol.short]).filter((report) => report.venueEligible);
  const eligibleIntentSignals = eligibleReports.reduce((sum, report) => sum + report.signalCount, 0);
  const profitableAfterCostEligibleSignals = eligibleReports.reduce((sum, report) => sum + report.profitableSignals, 0);
  const acceptancePassed = !options.economicOnly && eligibleIntentSignals > 0 && profitableAfterCostEligibleSignals > 0;
  const acceptanceReason = acceptancePassed ? null : eligibleIntentSignals === 0 ? "Replay produced no cost-qualified venue-eligible intents"
    : options.economicOnly ? "Profitability acceptance requires a full replay; economic-only mode does not label forward returns"
      : "Replay produced no venue-eligible intent with a profitable forward move after its robust modeled cost";
  return {
    recording: { path: paths.join(","), paths, events, books, trades, disconnects, gaps,
      firstTsMs, lastTsMs, durationMs, coveredDurationMs },
    assumptions: {
      sampleIntervalMs: cfg.recall.sampleIntervalMs,
      opportunityHorizonMs: cfg.recall.opportunityHorizonMs,
      minimumNetMoveBps: cfg.recall.minimumNetMoveBps,
      label: "Best executable bid/ask move within the horizon minus two taker fees and fixed adverse/funding/borrow costs; latency and impact omitted, so recall is an optimistic upper bound",
    },
    symbols,
    tuning: { ready, observedDurationMs: coveredDurationMs, requiredDurationMs: cfg.recall.minimumTuningDurationMs,
      opportunityWindows, requiredOpportunityWindows: cfg.recall.minimumTuningOpportunities, reason },
    calibration: { ready: calibrationReady,
      candidateCounts: { long: longCalibrationCandidates, short: shortCalibrationCandidates,
        venueEligible: longCalibrationCandidates + (cfg.venue === "kraken_futures" ? shortCalibrationCandidates : 0) },
      buckets: calibrationBuckets, deployableBuckets, reason: calibrationReason },
    acceptance: { passed: acceptancePassed, eligibleIntentSignals, profitableAfterCostEligibleSignals,
      longIntentSignals, profitableAfterCostLongSignals, reason: acceptanceReason },
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
  const longEconomicCosts = runtime.planner.economicCosts(features, book, 1, 0, "CONTINUATION");
  const shortEconomicCosts = runtime.planner.economicCosts(features, book, -1, 0, "CONTINUATION");
  const longPullbackEconomicCosts = runtime.planner.economicCosts(features, book, 1, 0, "PULLBACK_RECOVERY");
  const shortPullbackEconomicCosts = runtime.planner.economicCosts(features, book, -1, 0, "PULLBACK_RECOVERY");
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
    longCost, shortCost, longEconomicCosts, shortEconomicCosts,
    longPullbackEconomicCosts, shortPullbackEconomicCosts, longLiquidity, shortLiquidity,
  });
  if (intent) {
    const pullback = pullbackState(intent.side, features);
    runtime.signals.push({ atMs: features.receiveTsMs, side: intent.side, family: intent.diagnostics.family,
      bid: book.bids[0]!.px, ask: book.asks[0]!.px,
      horizonMs: intent.selectedHorizonMs ?? intent.diagnostics.edgeHorizonMs,
      robustCostBps: intent.robustCostBps ?? intent.diagnostics.robustCostBps, executionPath: intent.executionPath ?? null,
      reversalExtremeAgeMs: intent.diagnostics.family === "PULLBACK_RECOVERY" ? pullback.reversalExtremeAgeMs : null });
  }
  const latest = runtime.entry.latestEvaluation();
  if (latest) {
    runtime.maximumLongScore = Math.max(runtime.maximumLongScore, latest.long.score);
    for (const cost of [latest.long.roundTripCostBps, latest.short.roundTripCostBps]) {
      if (Number.isFinite(cost)) runtime.minimumModeledCostBps = runtime.minimumModeledCostBps === null
        ? cost : Math.min(runtime.minimumModeledCostBps, cost);
    }
    runtime.evaluationEvents += 1;
    if (latest.long.rawDirectionalPass || latest.short.rawDirectionalPass) runtime.rawDirectionalEvents += 1;
    if (latest.candidate) runtime.directionalCandidateEvents += 1;
    if (latest.intent) runtime.costQualifiedIntentEvents += 1;
    incrementDirection(runtime.directionCounters.long, latest.long);
    incrementDirection(runtime.directionCounters.short, latest.short);
    if (latest.long.rawDirectionalPass) runtime.rawSignals.push(auditSignal(features.receiveTsMs, 1, book));
    if (latest.short.rawDirectionalPass) runtime.rawSignals.push(auditSignal(features.receiveTsMs, -1, book));
    if (latest.candidate) runtime.candidateSignals.push(auditSignal(features.receiveTsMs, latest.candidate.side, book));
    if (latest.candidate) {
      const diagnostics = latest.candidate.diagnostics;
      observeEarlyBreakoutCandidate(runtime.directionCounters[latest.candidate.side === 1 ? "long" : "short"],
        latest.candidate.side, features, runtime.config.deterministicSignal.earlyBreakout, diagnostics);
      const candidate: EconomicCandidateAudit = {
        family: diagnostics.family, side: latest.candidate.side, lowerBoundNetBps: diagnostics.lowerBoundNetBps,
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
      if (Number.isFinite(diagnostics.edgeHorizonMs) && diagnostics.edgeHorizonMs > 0) {
        runtime.calibrationCandidates.push({
          atMs: features.receiveTsMs, side: latest.candidate.side, bid: book.bids[0]!.px, ask: book.asks[0]!.px,
          regime: classified.name, family: diagnostics.family, quality: diagnostics.edgeQuality, spreadBps: features.spreadBps,
          horizonMs: diagnostics.edgeHorizonMs,
          executionPath: diagnostics.executionPath ?? (diagnostics.family === "EARLY_BREAKOUT"
            ? "TAKER_TAKER" : "MAKER_MAKER_TAKER_FALLBACK"),
        });
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
  runtime.points.push({ atMs: features.receiveTsMs, bid: book.bids[0]!.px, ask: book.asks[0]!.px });
}

function directionReport(runtime: OfflineRuntime, side: Direction, cfg: EngineConfig, venueEligible: boolean): DirectionRecallReport {
  const feesAndFixedCosts = 2 * runtime.config.cost.takerFeeBps + runtime.config.cost.adverseSelectionBps
    + runtime.config.cost.fundingBps + runtime.config.cost.borrowBps;
  const labels = bestNetMoves(runtime.points, side, cfg.recall.opportunityHorizonMs, feesAndFixedCosts);
  const windows = groupWindows(runtime.points, labels, cfg.recall.minimumNetMoveBps, cfg.recall.sampleIntervalMs);
  const signals = runtime.signals.filter((signal) => signal.side === side);
  const rawSignals = runtime.rawSignals.filter((signal) => signal.side === side);
  const candidateSignals = runtime.candidateSignals.filter((signal) => signal.side === side);
  const signalNet = new Map(signals.map((signal) => [signal, bestNetForSignal(signal, runtime.points)]));
  const captured = countCapturedWindows(windows, signals, cfg.recall.sampleIntervalMs);
  const rawCaptured = countCapturedWindows(windows, rawSignals, cfg.recall.sampleIntervalMs);
  const candidateCaptured = countCapturedWindows(windows, candidateSignals, cfg.recall.sampleIntervalMs);
  const profitableSignals = signals.filter((signal) => signalNet.get(signal)! >= cfg.recall.minimumNetMoveBps).length;
  const pullbackSignals = signals.filter((signal) => signal.family === "PULLBACK_RECOVERY");
  const profitablePullbackSignals = pullbackSignals.filter((signal) => signalNet.get(signal)!
    >= cfg.recall.minimumNetMoveBps).length;
  const earlyBreakoutSignals = signals.filter((signal) => signal.family === "EARLY_BREAKOUT");
  const profitableEarlyBreakoutSignals = earlyBreakoutSignals.filter((signal) => signalNet.get(signal)!
    >= cfg.recall.minimumNetMoveBps).length;
  const pullbackRecencyShadow = Object.fromEntries(PULLBACK_RECENCY_SHADOW_MS.map((maximumReversalAgeMs) => {
    const gated = pullbackSignals.filter((signal) => signal.reversalExtremeAgeMs !== null
      && signal.reversalExtremeAgeMs <= maximumReversalAgeMs);
    const profitable = gated.filter((signal) => signalNet.get(signal)! >= cfg.recall.minimumNetMoveBps).length;
    return [`${maximumReversalAgeMs}ms`, { maximumReversalAgeMs, signalCount: gated.length,
      profitableSignals: profitable, precision: ratio(profitable, gated.length) }];
  }));
  return {
    venueEligible,
    opportunityWindows: windows.length, capturedWindows: captured, recall: ratio(captured, windows.length),
    maximumNetMoveBps: maximumFinite(labels, 0),
    signalCount: signals.length, profitableSignals,
    pullbackSignalCount: pullbackSignals.length, profitablePullbackSignals,
    earlyBreakoutSignalCount: earlyBreakoutSignals.length, profitableEarlyBreakoutSignals,
    pullbackRecencyShadow,
    precision: ratio(profitableSignals, signals.length),
    rawSignalCount: rawSignals.length, rawCapturedWindows: rawCaptured, rawRecall: ratio(rawCaptured, windows.length),
    candidateSignalCount: candidateSignals.length, candidateCapturedWindows: candidateCaptured,
    candidateRecall: ratio(candidateCaptured, windows.length),
  };
}

function emptyDirectionReport(venueEligible: boolean, signalCount: number, pullbackSignalCount: number): DirectionRecallReport {
  return { venueEligible, opportunityWindows: 0, capturedWindows: 0, recall: 0, maximumNetMoveBps: 0,
    signalCount, profitableSignals: 0, pullbackSignalCount, profitablePullbackSignals: 0,
    earlyBreakoutSignalCount: 0, profitableEarlyBreakoutSignals: 0,
    pullbackRecencyShadow: {},
    precision: 0, rawSignalCount: 0, rawCapturedWindows: 0,
    rawRecall: 0, candidateSignalCount: 0, candidateCapturedWindows: 0, candidateRecall: 0 };
}

function bestNetMoves(points: readonly RecallPoint[], side: Direction, horizonMs: number, costsBps: number): number[] {
  const labels = Array.from({ length: points.length }, () => Number.NEGATIVE_INFINITY);
  const deque: number[] = [];
  let head = 0, end = 1;
  const executable = (index: number): number => side === 1 ? points[index]!.bid : points[index]!.ask;
  const dominates = (left: number, right: number): boolean => side === 1 ? left >= right : left <= right;
  for (let index = 0; index < points.length; index += 1) {
    while (head < deque.length && deque[head]! <= index) head += 1;
    end = Math.max(end, index + 1);
    while (end < points.length && points[end]!.atMs <= points[index]!.atMs + horizonMs) {
      const value = executable(end);
      while (deque.length > head && dominates(value, executable(deque.at(-1)!))) deque.pop();
      deque.push(end);
      end += 1;
    }
    const bestIndex = deque[head];
    if (bestIndex !== undefined) {
      const entry = points[index]!, bestPx = executable(bestIndex);
      const gross = side === 1 ? (bestPx / entry.ask - 1) * 10_000 : (entry.bid / bestPx - 1) * 10_000;
      labels[index] = gross - costsBps;
    }
    if (head > 1_024) { deque.splice(0, head); head = 0; }
  }
  return labels;
}

function bestNetForSignal(signal: RecallSignal, points: readonly RecallPoint[]): number {
  let best = Number.NEGATIVE_INFINITY;
  let lo = 0, hi = points.length;
  while (lo < hi) {
    const middle = (lo + hi) >>> 1;
    if (points[middle]!.atMs <= signal.atMs) lo = middle + 1;
    else hi = middle;
  }
  for (let index = lo; index < points.length; index += 1) {
    const point = points[index]!;
    if (point.atMs > signal.atMs + signal.horizonMs) break;
    const makerEntry = signal.executionPath !== "TAKER_TAKER";
    const entryPx = signal.side === 1 ? (makerEntry ? signal.bid : signal.ask) : (makerEntry ? signal.ask : signal.bid);
    const gross = signal.side === 1 ? (point.bid / entryPx - 1) * 10_000 : (entryPx / point.ask - 1) * 10_000;
    best = Math.max(best, gross - signal.robustCostBps);
  }
  return best;
}

function auditSignal(atMs: number, side: Direction, book: BookState): RecallSignal {
  return { atMs, side, family: null, bid: book.bids[0]!.px, ask: book.asks[0]!.px,
    horizonMs: 0, robustCostBps: Number.POSITIVE_INFINITY, executionPath: null, reversalExtremeAgeMs: null };
}

function forwardCalibrationBuckets(runtimes: ReadonlyMap<string, OfflineRuntime>, cfg: EngineConfig): CalibratedEdgeBucket[] {
  const buckets: CalibratedEdgeBucket[] = [];
  for (const [symbol, runtime] of runtimes) {
    const groups = new Map<string, ForwardCalibrationCandidate[]>();
    for (const candidate of runtime.calibrationCandidates.filter((item) => item.side === 1 || cfg.venue === "kraken_futures")) {
      const key = calibrationGroupKey(candidate.side, candidate.family, candidate.regime,
        candidate.horizonMs, candidate.executionPath);
      const values = groups.get(key) ?? [];
      values.push(candidate);
      groups.set(key, values);
    }
    for (const candidates of groups.values()) {
      const independent: ForwardCalibrationCandidate[] = [];
      for (const candidate of candidates.sort((left, right) => left.atMs - right.atMs)) {
        if (independent.length === 0 || candidate.atMs - independent.at(-1)!.atMs >= candidate.horizonMs) independent.push(candidate);
      }
      const returns = independent.flatMap((candidate) => {
        const future = pointAtOrAfter(runtime.points, candidate.atMs + candidate.horizonMs, Math.max(5_000, cfg.recall.sampleIntervalMs * 2));
        if (!future) return [];
        return [fixedHorizonGrossReturnBps(candidate.side, candidate.bid, candidate.ask, future.bid, future.ask)];
      });
      if (returns.length < 2) continue;
      const template = independent[0]!;
      const bucket = calibrationBucketFromReturns(symbol, template.family, template.side, template.regime,
        template.horizonMs, template.executionPath, runtime.config.deterministicSignal.maximumSpreadBps, returns);
      if (bucket) buckets.push(bucket);
    }
  }
  return buckets;
}

function pointAtOrAfter(points: readonly RecallPoint[], targetMs: number, toleranceMs: number): RecallPoint | undefined {
  let lo = 0, hi = points.length;
  while (lo < hi) { const middle = (lo + hi) >>> 1; if (points[middle]!.atMs < targetMs) lo = middle + 1; else hi = middle; }
  const point = points[lo];
  return point && point.atMs - targetMs <= toleranceMs ? point : undefined;
}

export function calibrationGroupKey(side: Direction, family: EntryFamily, regime: RegimeName,
  horizonMs: number, executionPath: ExecutionPath): string {
  return `${side}|${family}|${regime}|${horizonMs}|${executionPath}`;
}

export function fixedHorizonGrossReturnBps(side: Direction, entryBid: number, entryAsk: number,
  futureBid: number, futureAsk: number): number {
  return side === 1 ? (futureBid / entryBid - 1) * 10_000 : (entryAsk / futureAsk - 1) * 10_000;
}

export function calibrationBucketFromReturns(symbol: string, family: EntryFamily, side: Direction,
  regime: RegimeName, horizonMs: number, executionPath: ExecutionPath, maximumSpreadBps: number,
  returns: readonly number[]): CalibratedEdgeBucket | null {
  if (returns.length < 2) return null;
  const meanGrossReturnBps = mean(returns);
  const standardError = sampleStandardDeviation(returns) / Math.sqrt(returns.length);
  return {
    symbol, family, side, regime, minimumQuality: 0, maximumQuality: 1,
    minimumSpreadBps: 0, maximumSpreadBps, horizonMs, path: executionPath,
    meanGrossReturnBps, lowerConfidenceGrossReturnBps: meanGrossReturnBps - 1.645 * standardError,
    effectiveSampleCount: returns.length,
  };
}

function mean(values: readonly number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function sampleStandardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
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

function countCapturedWindows(windows: readonly OpportunityWindow[], signals: readonly RecallSignal[], sampleIntervalMs: number): number {
  let count = 0, signalIndex = 0;
  for (const window of windows) {
    while (signalIndex < signals.length && signals[signalIndex]!.atMs < window.startMs) signalIndex += 1;
    if (signalIndex < signals.length && signals[signalIndex]!.atMs <= window.endMs + sampleIntervalMs) count += 1;
  }
  return count;
}

function maximumFinite(values: readonly number[], fallback: number): number {
  let maximum = fallback;
  for (const value of values) if (Number.isFinite(value)) maximum = Math.max(maximum, value);
  return maximum;
}

function allNumbersFinite(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object") return true;
  return Object.values(value as Record<string, unknown>).every(allNumbersFinite);
}
function emptyDirectionCounts(): DirectionCandidateCounts {
  return { evaluations: 0, regimePass: 0, directionAuthorizationPass: 0,
    quorumPass: 0, scorePass: 0, arbitrationPass: 0, antiChasePass: 0,
    rawDirectionalPass: 0, persistencePass: 0, candidatePass: 0, liquidityPass: 0, slowTrendPass: 0,
    edgeResolvedPass: 0, preliminaryCostPass: 0, pullbackRecoveryPass: 0,
    earlyBreakoutPass: 0, earlyBreakoutCandidatePass: 0, earlyBreakoutCostPass: 0,
    maximumEarlyBreakoutLowerBoundNetBps: null,
    bestEarlyBreakoutCandidate: null,
    earlyBreakoutCandidateExamples: [],
    maximumPersistence: 0, maximumConfirmationMs: 0, maximumConfirmationEvents: 0 };
}
function incrementDirection(counts: DirectionCandidateCounts, diagnostics: DeterministicEvaluation["long"]): void {
  counts.evaluations += 1;
  if (diagnostics.regimePass) counts.regimePass += 1;
  if (diagnostics.directionAuthorizationPass) counts.directionAuthorizationPass += 1;
  if (diagnostics.votes.quorum) counts.quorumPass += 1;
  if (diagnostics.scorePass) counts.scorePass += 1;
  if (diagnostics.arbitrationPass) counts.arbitrationPass += 1;
  if (diagnostics.antiChasePass) counts.antiChasePass += 1;
  if (diagnostics.rawDirectionalPass) counts.rawDirectionalPass += 1;
  if (diagnostics.persistencePass) counts.persistencePass += 1;
  if (diagnostics.candidatePass) counts.candidatePass += 1;
  if (diagnostics.liquidityPass) counts.liquidityPass += 1;
  if (diagnostics.slowTrendPass) counts.slowTrendPass += 1;
  if (diagnostics.pullbackRecoveryPass) counts.pullbackRecoveryPass += 1;
  if (diagnostics.earlyBreakoutPass) counts.earlyBreakoutPass += 1;
  if (diagnostics.family === "EARLY_BREAKOUT" && diagnostics.candidatePass) counts.earlyBreakoutCandidatePass += 1;
  if (diagnostics.family === "EARLY_BREAKOUT" && diagnostics.costPass) counts.earlyBreakoutCostPass += 1;
  if (diagnostics.family === "EARLY_BREAKOUT" && Number.isFinite(diagnostics.lowerBoundNetBps)) {
    counts.maximumEarlyBreakoutLowerBoundNetBps = counts.maximumEarlyBreakoutLowerBoundNetBps === null
      ? diagnostics.lowerBoundNetBps
      : Math.max(counts.maximumEarlyBreakoutLowerBoundNetBps, diagnostics.lowerBoundNetBps);
  }
  if (diagnostics.edgeResolvedPass) counts.edgeResolvedPass += 1;
  if (diagnostics.costPass) counts.preliminaryCostPass += 1;
  counts.maximumPersistence = Math.max(counts.maximumPersistence, diagnostics.persistence);
  counts.maximumConfirmationMs = Math.max(counts.maximumConfirmationMs, diagnostics.confirmationMs);
  counts.maximumConfirmationEvents = Math.max(counts.maximumConfirmationEvents, diagnostics.confirmationEvents);
}
function observeEarlyBreakoutCandidate(counts: DirectionCandidateCounts, side: Direction,
  f: DeterministicFeatures, cfg: EarlyBreakoutConfig, diagnostics: DeterministicEvaluation["long"]): void {
  const displacementBps = Math.max(side === 1 ? f.breakoutUpBps : f.breakoutDownBps, side * f.impulseBps);
  const checks: [string, boolean][] = [
    ["SLOW_READY", f.slowTrendReady],
    ["SLOW_DRIFT", side * f.trendSlowBps >= -cfg.maximumOpposingSlowTrendBps],
    ["MEDIUM_DRIFT", side * f.trendMediumBps >= -cfg.maximumOpposingMediumTrendBps],
    ["FAST_TREND", side * f.trendFastBps >= cfg.minimumFastTrendBps],
    ["SLOW_ALIGNMENT", side * f.slowTrendAlignment >= -cfg.maximumOpposingSlowTrendAlignment],
    ["DISPLACEMENT", displacementBps >= cfg.minimumBreakoutBps],
    ["VELOCITY", side * f.velocityZ >= cfg.minimumVelocityZ],
    ["FLOW_FLIP", f.flowFlipRate <= cfg.maximumFlowFlipRate],
  ];
  const passedChecks = checks.filter(([, pass]) => pass).length;
  const audit: EarlyBreakoutCandidateAudit = {
    atMs: f.receiveTsMs, passedChecks, totalChecks: checks.length,
    family: diagnostics.family, score: diagnostics.score, costPass: diagnostics.costPass,
    lowerBoundNetBps: diagnostics.lowerBoundNetBps,
    grossOpportunityBps: diagnostics.grossOpportunityBps,
    uncertaintyReserveBps: diagnostics.uncertaintyReserveBps,
    robustCostBps: diagnostics.robustCostBps,
    fastTrendBps: side * f.trendFastBps, mediumTrendBps: side * f.trendMediumBps,
    slowTrendBps: side * f.trendSlowBps, slowTrendAlignment: side * f.slowTrendAlignment,
    displacementBps, velocityZ: side * f.velocityZ, flowFlipRate: f.flowFlipRate,
    failedChecks: checks.flatMap(([name, pass]) => pass ? [] : [name]),
  };
  if (!counts.bestEarlyBreakoutCandidate || counts.bestEarlyBreakoutCandidate.passedChecks <= passedChecks) {
    counts.bestEarlyBreakoutCandidate = audit;
  }
  counts.earlyBreakoutCandidateExamples.push(audit);
  counts.earlyBreakoutCandidateExamples.sort((left, right) => right.passedChecks - left.passedChecks);
  if (counts.earlyBreakoutCandidateExamples.length > 20) counts.earlyBreakoutCandidateExamples.length = 20;
}
function liquidityInput(features: DeterministicFeatures, impactBps: number) {
  return {
    spreadBps: features.spreadBps, spreadZ: features.spreadZ, depthZ: features.depthZ,
    impactBps, providerAgeMs: features.providerAgeMs,
    stale: features.stale,
  };
}
function ratio(numerator: number, denominator: number): number { return denominator > 0 ? numerator / denominator : 0; }
