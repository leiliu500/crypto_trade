import type { DashboardPnlPoint, DashboardRealizedPnlBreakdown } from "../dashboard/types.js";

export interface OptimizationLivePosition {
  openedMs: number;
  closedAtMs: number | null;
  realizedPnl: number | null;
  realizedPnlBps?: number | null;
  entryOrderId: string | null;
  pnlHistory: readonly DashboardPnlPoint[];
  realizedBreakdown?: DashboardRealizedPnlBreakdown | null;
}

export interface OptimizationOrder {
  clientOrderId: string;
  runId: string | null;
  telemetryDroppedRecords: number | null;
  symbol: string;
  side: 1 | -1;
  style: string;
  status: string;
  requestedQty: number;
  filledQty: number;
  fillProbability: number | null;
  reduceOnlyIntent: boolean;
  createdMs: number;
  updatedMs: number;
  entryFamily: string | null;
  configurationVersion?: string | null;
  regime?: string | null;
  edgeSource?: string | null;
  edgeEffectiveSampleCount?: number | null;
  economicHorizonMs?: number | null;
  researchOnly?: boolean;
  cancellationReason: string | null;
  exitReason: string | null;
  livePosition: OptimizationLivePosition | null;
}

export interface TradeOptimizationOptions {
  minimumDurationMs: number;
  minimumSamples: number;
  shadowUnproductiveExitMs: number;
  activeUnproductiveExitMs: number;
  minimumFillAuc?: number;
  routeShadowDecisionHorizonMs?: number;
  routeShadowMaximumMarkDelayMs?: number;
}

export interface OptimizationRouteShadowMark {
  runId: string | null;
  telemetryDroppedRecords: number | null;
  decisionId: string;
  symbol: string;
  side: 1 | -1;
  family: string;
  configurationVersion: string | null;
  regime: string | null;
  regimePass: boolean | null;
  edgeSource: string | null;
  edgeEffectiveSampleCount: number | null;
  economicHorizonMs: number | null;
  signalAtMs: number;
  horizonMs: number;
  markDelayMs: number;
  makerAvailable: boolean;
  takerAvailable: boolean;
  makerFillFraction: number | null;
  makerNetBps: number | null;
  takerNetBps: number | null;
}

export interface RouteShadowSlice {
  samples: number;
  makerAlternatives: number;
  makerFills: number;
  makerFillRate: number | null;
  meanMakerPolicyNetBps: number | null;
  meanTakerNetBps: number | null;
  lower95TakerNetBps: number | null;
  meanTakerMinusMakerBps: number | null;
  lower95TakerMinusMakerBps: number | null;
  takerProfitable: number;
  takerUnprofitable: number;
  takerWins: number;
  makerWins: number;
}

export interface RouteShadowCohort extends RouteShadowSlice {
  observedDurationMs: number;
  dataReady: boolean;
  deploymentReady: boolean;
  reason: string | null;
}

export interface MakerRouteShadowSlice {
  samples: number;
  fills: number;
  fillRate: number | null;
  meanPolicyNetBps: number | null;
  lower95PolicyNetBps: number | null;
  meanFilledNetBps: number | null;
  profitable: number;
  unprofitable: number;
}

export interface MakerRouteShadowCohort extends MakerRouteShadowSlice {
  observedDurationMs: number;
  dataReady: boolean;
  deploymentReady: boolean;
  reason: string | null;
}

export interface CalibrationSlice {
  attempts: number;
  anyFilled: number;
  predictedMean: number | null;
  actualAnyFillRate: number | null;
  quantityFillRate: number | null;
  brierScore: number | null;
  logLoss: number | null;
}

export interface RealizedPerformanceCohort {
  samples: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnl: number;
  meanPnl: number | null;
  meanNetReturnBps: number | null;
  lower95NetReturnBps: number | null;
  observedDurationMs: number;
  dataReady: boolean;
  deploymentReady: boolean;
  reason: string | null;
}

export interface TradeOptimizationReport {
  requirements: {
    minimumDurationMs: number;
    minimumSamples: number;
    minimumFillAuc: number;
    shadowUnproductiveExitMs: number;
    activeUnproductiveExitMs: number;
    routeShadowDecisionHorizonMs: number;
    routeShadowMaximumMarkDelayMs: number;
  };
  dataQuality: {
    orders: number;
    cleanOrders: number;
    excludedOrdersFromRunsWithDropsOrNoHealth: number;
  };
  makerFill: CalibrationSlice & {
    pendingAttempts: number;
    invalidAttempts: number;
    excludedUncleanAttempts: number;
    observedDurationMs: number;
    rocAuc: number | null;
    calibrationBuckets: Record<string, CalibrationSlice>;
    groups: Record<string, CalibrationSlice>;
    fittedHazardInterceptOffset: number | null;
    fittedPredictedMean: number | null;
    fittedBrierScore: number | null;
    fittedLogLoss: number | null;
    dataReady: boolean;
    deploymentReady: boolean;
    reason: string | null;
  };
  realizedPerformance: RealizedPerformanceCohort & {
    costAttribution: {
      matchedTrades: number;
      missingOrInvalidBreakdowns: number;
      grossPricePnl: number | null;
      entryFees: number | null;
      exitFees: number | null;
      netPnl: number | null;
      grossWinners: number;
      grossWinnersLostAfterFees: number;
    };
    exitReasons: Record<string, { trades: number; totalPnl: number; meanNetReturnBps: number; meanHoldMs: number }>;
    closedTrades: number;
    cleanMatchedTrades: number;
    excludedUncleanOrUnmatchedTrades: number;
    groups: Record<string, RealizedPerformanceCohort>;
    deployableGroups: string[];
  };
  unproductiveExitShadow: {
    closedTrades: number;
    eligibleTrades: number;
    excludedUncleanTrades: number;
    observedDurationMs: number;
    counterfactualWins: number;
    actualTotalPnl: number;
    counterfactualTotalPnl: number;
    totalPnlDelta: number;
    averagePnlDelta: number | null;
    lower95AveragePnlDelta: number | null;
    pnlDeltaByActualExitReason: Record<string, number>;
    dataReady: boolean;
    deploymentReady: boolean;
    reason: string | null;
  };
  entryRouteShadow: {
    marks: number;
    cleanMarks: number;
    excludedUncleanMarks: number;
    excludedInvalidOrDelayedCleanMarks: number;
    excludedNoExecutableTakerMarks: number;
    pairedMakerTakerMarks: number;
    economicHorizonMarks: number;
    decisions: number;
    observedDurationMs: number;
    horizons: Record<string, RouteShadowSlice>;
    groups: Record<string, RouteShadowCohort>;
    deployableGroups: string[];
    decisionHorizon: RouteShadowSlice;
    economicHorizon: RouteShadowSlice;
    dataReady: boolean;
    deploymentReady: boolean;
    reason: string | null;
    makerOnly: {
      economicHorizonMarks: number;
      decisions: number;
      observedDurationMs: number;
      economicHorizon: MakerRouteShadowSlice;
      groups: Record<string, MakerRouteShadowCohort>;
      deployableGroups: string[];
      dataReady: boolean;
      deploymentReady: boolean;
      reason: string | null;
    };
  };
}

interface FillAttempt extends OptimizationOrder { probability: number; label: 0 | 1; }
interface TimeoutCandidate { openedMs: number; actualPnl: number; counterfactualPnl: number; exitReason: string; }
interface RealizedTrade {
  breakdown: DashboardRealizedPnlBreakdown | null;
  exitReason: string; holdMs: number;
  openedMs: number; pnl: number; netReturnBps: number; configurationVersion: string | null;
  symbol: string; side: 1 | -1; family: string | null; regime: string | null; edgeSource: string | null;
  economicHorizonMs: number | null; researchOnly: boolean;
}

const TERMINAL_ORDER_STATES = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);

export function analyzeTradeOptimization(orders: readonly OptimizationOrder[], options: TradeOptimizationOptions,
  routeShadows: readonly OptimizationRouteShadowMark[] = []): TradeOptimizationReport {
  validateOptions(options);
  const minimumFillAuc = options.minimumFillAuc ?? .55;
  const routeShadowDecisionHorizonMs = options.routeShadowDecisionHorizonMs ?? 30_000;
  const routeShadowMaximumMarkDelayMs = options.routeShadowMaximumMarkDelayMs ?? 1_000;
  const cleanOrders = orders.filter((order) => order.telemetryDroppedRecords === 0);
  const makerFill = makerFillReport(orders, options, minimumFillAuc);
  const realizedPerformance = realizedPerformanceReport(orders, options);
  const unproductiveExitShadow = timeoutReport(orders, options);
  const entryRouteShadow = routeShadowReport(routeShadows, options, routeShadowDecisionHorizonMs,
    routeShadowMaximumMarkDelayMs);
  return {
    requirements: {
      minimumDurationMs: options.minimumDurationMs,
      minimumSamples: options.minimumSamples,
      minimumFillAuc,
      shadowUnproductiveExitMs: options.shadowUnproductiveExitMs,
      activeUnproductiveExitMs: options.activeUnproductiveExitMs,
      routeShadowDecisionHorizonMs,
      routeShadowMaximumMarkDelayMs,
    },
    dataQuality: {
      orders: orders.length,
      cleanOrders: cleanOrders.length,
      excludedOrdersFromRunsWithDropsOrNoHealth: orders.length - cleanOrders.length,
    },
    makerFill,
    realizedPerformance,
    unproductiveExitShadow,
    entryRouteShadow,
  };
}

function realizedPerformanceReport(orders: readonly OptimizationOrder[],
  options: TradeOptimizationOptions): TradeOptimizationReport["realizedPerformance"] {
  const entries = new Map(orders.filter((order) => !order.reduceOnlyIntent)
    .map((order) => [order.clientOrderId, order]));
  const closed = orders.filter((order) => order.reduceOnlyIntent && order.status.toUpperCase() === "FILLED"
    && order.livePosition !== null && order.livePosition.closedAtMs !== null
    && order.livePosition.realizedPnl !== null);
  const trades: RealizedTrade[] = [];
  for (const exit of closed) {
    const position = exit.livePosition;
    const entry = position?.entryOrderId ? entries.get(position.entryOrderId) : undefined;
    if (!position || !entry || exit.telemetryDroppedRecords !== 0 || entry.telemetryDroppedRecords !== 0
      || position.realizedPnl === null) continue;
    const netReturnBps = realizedNetReturnBps(position);
    if (netReturnBps === null) continue;
    trades.push({
      breakdown: validBreakdown(position.realizedBreakdown, position.realizedPnl),
      exitReason: exit.exitReason ?? "UNKNOWN", holdMs: position.closedAtMs! - position.openedMs,
      openedMs: position.openedMs, pnl: position.realizedPnl, netReturnBps,
      configurationVersion: entry.configurationVersion ?? null, symbol: entry.symbol, side: entry.side,
      family: entry.entryFamily, regime: entry.regime ?? null, edgeSource: entry.edgeSource ?? null,
      economicHorizonMs: entry.economicHorizonMs ?? null, researchOnly: entry.researchOnly === true,
    });
  }
  const groups = groupRealizedPerformance(trades, options);
  const deployableGroups = Object.entries(groups).filter(([, group]) => group.deploymentReady).map(([key]) => key);
  const aggregate = realizedPerformanceCohort(trades, options, false);
  const reason = deployableGroups.length > 0 ? null
    : trades.length === 0 ? "No clean closed trade can be matched to its entry metadata and net return"
      : "No calibrated realized-performance cohort has enough independent duration/samples and a positive lower 95% net-return bound";
  return {
    ...aggregate, deploymentReady: deployableGroups.length > 0, reason,
    costAttribution: costAttribution(trades),
    exitReasons: Object.fromEntries([...new Set(trades.map((trade) => trade.exitReason))].sort().map((reason) => {
      const values = trades.filter((trade) => trade.exitReason === reason);
      return [reason, { trades: values.length, totalPnl: sum(values.map((trade) => trade.pnl)),
        meanNetReturnBps: mean(values.map((trade) => trade.netReturnBps)),
        meanHoldMs: mean(values.map((trade) => trade.holdMs)) }];
    })),
    closedTrades: closed.length, cleanMatchedTrades: trades.length,
    excludedUncleanOrUnmatchedTrades: closed.length - trades.length, groups, deployableGroups,
  };
}

function validBreakdown(value: DashboardRealizedPnlBreakdown | null | undefined,
  pnl: number): DashboardRealizedPnlBreakdown | null {
  if (!value || ![value.grossPricePnl, value.entryFee, value.exitFee, value.realizedPnl].every(Number.isFinite)) return null;
  const tolerance = 1e-8 * Math.max(1, Math.abs(pnl), Math.abs(value.grossPricePnl));
  if (Math.abs(value.grossPricePnl - value.entryFee - value.exitFee - pnl) > tolerance
    || Math.abs(value.realizedPnl - pnl) > tolerance) return null;
  return value;
}

function costAttribution(trades: readonly RealizedTrade[]): TradeOptimizationReport["realizedPerformance"]["costAttribution"] {
  const values = trades.flatMap((trade) => trade.breakdown ? [trade.breakdown] : []);
  return {
    matchedTrades: values.length, missingOrInvalidBreakdowns: trades.length - values.length,
    grossPricePnl: values.length ? sum(values.map((value) => value.grossPricePnl)) : null,
    entryFees: values.length ? sum(values.map((value) => value.entryFee)) : null,
    exitFees: values.length ? sum(values.map((value) => value.exitFee)) : null,
    netPnl: values.length ? sum(values.map((value) => value.realizedPnl)) : null,
    grossWinners: values.filter((value) => value.grossPricePnl > 0).length,
    grossWinnersLostAfterFees: values.filter((value) => value.grossPricePnl > 0 && value.realizedPnl < 0).length,
  };
}

function groupRealizedPerformance(trades: readonly RealizedTrade[],
  options: TradeOptimizationOptions): Record<string, RealizedPerformanceCohort> {
  const groups = new Map<string, RealizedTrade[]>();
  for (const trade of trades) {
    const key = [trade.configurationVersion ?? "legacy", trade.symbol, trade.side === 1 ? "long" : "short",
      trade.family ?? "UNKNOWN", trade.regime ?? "legacy", trade.edgeSource ?? "legacy",
      trade.economicHorizonMs ?? "legacy", trade.researchOnly ? "research" : "deployable"].join(":");
    const values = groups.get(key) ?? [];
    values.push(trade);
    groups.set(key, values);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => [key, realizedPerformanceCohort(values, options, true)]));
}

function realizedPerformanceCohort(trades: readonly RealizedTrade[], options: TradeOptimizationOptions,
  requireCalibrated: boolean): RealizedPerformanceCohort {
  const returns = trades.map((trade) => trade.netReturnBps);
  const observedDurationMs = span(trades.map((trade) => trade.openedMs));
  const calibrated = !requireCalibrated || trades.every((trade) => trade.edgeSource === "CALIBRATED" && !trade.researchOnly);
  const dataReady = calibrated && trades.length >= options.minimumSamples && observedDurationMs >= options.minimumDurationMs;
  const lower95NetReturnBps = lowerConfidenceMean(returns);
  const deploymentReady = dataReady && (lower95NetReturnBps ?? Number.NEGATIVE_INFINITY) > 0;
  const reason = deploymentReady ? null
    : !calibrated ? "Analytical/research trades cannot authorize deployment"
      : trades.length < options.minimumSamples ? `Only ${trades.length} trades; ${options.minimumSamples} required`
        : observedDurationMs < options.minimumDurationMs
          ? `Observed span is ${observedDurationMs} ms; ${options.minimumDurationMs} ms required`
          : `Lower 95% realized net return is ${lower95NetReturnBps}; it must be positive`;
  return {
    samples: trades.length, wins: returns.filter((value) => value > 0).length,
    losses: returns.filter((value) => value <= 0).length,
    winRate: trades.length ? returns.filter((value) => value > 0).length / trades.length : null,
    totalPnl: sum(trades.map((trade) => trade.pnl)), meanPnl: trades.length ? mean(trades.map((trade) => trade.pnl)) : null,
    meanNetReturnBps: returns.length ? mean(returns) : null, lower95NetReturnBps,
    observedDurationMs, dataReady, deploymentReady, reason,
  };
}

function realizedNetReturnBps(position: OptimizationLivePosition): number | null {
  if (position.realizedPnlBps !== undefined && position.realizedPnlBps !== null
    && Number.isFinite(position.realizedPnlBps)) return position.realizedPnlBps;
  const history = position.pnlHistory.filter(validPnlPoint).sort((left, right) => left.atMs - right.atMs);
  const close = [...history].reverse().find((point) => point.kind === "close") ?? history.at(-1);
  return close && Number.isFinite(close.unrealizedPnlBps) ? close.unrealizedPnlBps : null;
}

function routeShadowReport(marks: readonly OptimizationRouteShadowMark[], options: TradeOptimizationOptions,
  decisionHorizonMs: number, maximumMarkDelayMs: number): TradeOptimizationReport["entryRouteShadow"] {
  const clean = marks.filter((mark) => mark.telemetryDroppedRecords === 0);
  const structurallyValid = clean.filter((mark) => validRouteShadowShape(mark, maximumMarkDelayMs));
  const makerExecutable = structurallyValid.filter(validExecutableMakerMark);
  // A taker-only candidate is a real profitability observation: when no safe
  // maker plan exists, the alternative policy is no trade (zero), not a reason
  // to discard the taker markout.
  const executable = structurallyValid.filter(validExecutableTakerMark);
  const grouped = new Map<number, OptimizationRouteShadowMark[]>();
  for (const mark of executable) {
    const values = grouped.get(mark.horizonMs) ?? [];
    values.push(mark);
    grouped.set(mark.horizonMs, values);
  }
  const horizons = Object.fromEntries([...grouped].sort(([a], [b]) => a - b)
    .map(([horizonMs, values]) => [String(horizonMs), routeShadowSlice(values)]));
  const decisionMarks = grouped.get(decisionHorizonMs) ?? [];
  const decisionHorizon = routeShadowSlice(decisionMarks);
  const economicMarks = executable.filter((mark) => mark.horizonMs
    === (mark.economicHorizonMs ?? decisionHorizonMs));
  const economicHorizon = routeShadowSlice(economicMarks);
  const groups = groupRouteShadowCohorts(economicMarks, options,
    (mark) => [mark.configurationVersion ?? "legacy", mark.symbol, mark.side === 1 ? "long" : "short",
      mark.family, mark.regime ?? "legacy", mark.edgeSource ?? "legacy", String(mark.horizonMs)].join(":"));
  const deployableGroups = Object.entries(groups).filter(([, group]) => group.deploymentReady).map(([key]) => key);
  const observedDurationMs = span(economicMarks.map((mark) => mark.signalAtMs));
  const dataReady = Object.values(groups).some((group) => group.dataReady);
  const deploymentReady = deployableGroups.length > 0;
  const largestGroup = Object.values(groups).sort((left, right) => right.samples - left.samples)[0];
  const reason = deploymentReady ? null
    : economicMarks.length === 0
      ? "No clean executable taker marks exist at their selected economic horizons"
      : !dataReady
        ? `No economic-horizon cohort meets ${options.minimumSamples} samples over ${options.minimumDurationMs} ms; largest has ${largestGroup?.samples ?? 0} samples`
        : "No data-ready economic-horizon cohort has positive lower 95% bounds for both taker net return and taker-versus-alternative return";
  const makerEconomicMarks = makerExecutable.filter((mark) => mark.horizonMs
    === (mark.economicHorizonMs ?? decisionHorizonMs));
  const makerOnly = makerRouteShadowReport(makerEconomicMarks, options);
  return {
    marks: marks.length, cleanMarks: clean.length, excludedUncleanMarks: marks.length - clean.length,
    excludedInvalidOrDelayedCleanMarks: clean.length - structurallyValid.length,
    excludedNoExecutableTakerMarks: structurallyValid.length - executable.length,
    pairedMakerTakerMarks: executable.filter((mark) => mark.makerAvailable).length,
    economicHorizonMarks: economicMarks.length,
    decisions: new Set(executable.map((mark) => mark.decisionId)).size, observedDurationMs, horizons, groups,
    deployableGroups, decisionHorizon, economicHorizon, dataReady, deploymentReady, reason, makerOnly,
  };
}

function makerRouteShadowReport(marks: readonly OptimizationRouteShadowMark[], options: TradeOptimizationOptions):
  TradeOptimizationReport["entryRouteShadow"]["makerOnly"] {
  const groups = groupMakerRouteShadowCohorts(marks, options,
    (mark) => [mark.configurationVersion ?? "legacy", mark.symbol, mark.side === 1 ? "long" : "short",
      mark.family, mark.regime ?? "legacy", mark.edgeSource ?? "legacy", String(mark.horizonMs)].join(":"));
  const deployableGroups = Object.entries(groups).filter(([, group]) => group.deploymentReady).map(([key]) => key);
  const observedDurationMs = span(marks.map((mark) => mark.signalAtMs));
  const dataReady = Object.values(groups).some((group) => group.dataReady);
  const deploymentReady = deployableGroups.length > 0;
  const largestGroup = Object.values(groups).sort((left, right) => right.samples - left.samples)[0];
  const reason = deploymentReady ? null
    : marks.length === 0
      ? "No clean executable maker marks exist at their selected economic horizons"
      : !dataReady
        ? `No maker economic-horizon cohort meets ${options.minimumSamples} samples over ${options.minimumDurationMs} ms; largest has ${largestGroup?.samples ?? 0} samples`
        : "No data-ready calibrated maker cohort has a positive lower 95% policy-return bound";
  return {
    economicHorizonMarks: marks.length,
    decisions: new Set(marks.map((mark) => mark.decisionId)).size,
    observedDurationMs,
    economicHorizon: makerRouteShadowSlice(marks),
    groups,
    deployableGroups,
    dataReady,
    deploymentReady,
    reason,
  };
}

function routeShadowSlice(marks: readonly OptimizationRouteShadowMark[]): RouteShadowSlice {
  if (marks.length === 0) return {
    samples: 0, makerAlternatives: 0, makerFills: 0, makerFillRate: null, meanMakerPolicyNetBps: null,
    meanTakerNetBps: null, lower95TakerNetBps: null,
    meanTakerMinusMakerBps: null, lower95TakerMinusMakerBps: null,
    takerProfitable: 0, takerUnprofitable: 0, takerWins: 0, makerWins: 0,
  };
  const makerPolicy = marks.map((mark) => mark.makerAvailable ? mark.makerNetBps ?? 0 : 0);
  const taker = marks.map((mark) => mark.takerNetBps!);
  const deltas = taker.map((value, index) => value - makerPolicy[index]!);
  return {
    samples: marks.length,
    makerAlternatives: marks.filter((mark) => mark.makerAvailable).length,
    makerFills: marks.filter((mark) => (mark.makerFillFraction ?? 0) > 0).length,
    makerFillRate: mean(marks.map((mark) => (mark.makerFillFraction ?? 0) > 0 ? 1 : 0)),
    meanMakerPolicyNetBps: mean(makerPolicy), meanTakerNetBps: mean(taker), lower95TakerNetBps: lowerConfidenceMean(taker),
    meanTakerMinusMakerBps: mean(deltas), lower95TakerMinusMakerBps: lowerConfidenceMean(deltas),
    takerProfitable: taker.filter((value) => value > 0).length,
    takerUnprofitable: taker.filter((value) => value <= 0).length,
    takerWins: deltas.filter((value) => value > 0).length, makerWins: deltas.filter((value) => value < 0).length,
  };
}

function validRouteShadowShape(mark: OptimizationRouteShadowMark, maximumMarkDelayMs: number): boolean {
  return Number.isFinite(mark.signalAtMs)
    && Number.isInteger(mark.horizonMs) && mark.horizonMs > 0
    && Number.isFinite(mark.markDelayMs) && mark.markDelayMs >= 0 && mark.markDelayMs <= maximumMarkDelayMs
    && (mark.makerNetBps === null || Number.isFinite(mark.makerNetBps))
    && (mark.makerFillFraction === null || (Number.isFinite(mark.makerFillFraction)
      && mark.makerFillFraction >= 0 && mark.makerFillFraction <= 1));
}

function validExecutableTakerMark(mark: OptimizationRouteShadowMark): boolean {
  return mark.takerAvailable && mark.takerNetBps !== null && Number.isFinite(mark.takerNetBps);
}

function validExecutableMakerMark(mark: OptimizationRouteShadowMark): boolean {
  if (!mark.makerAvailable || mark.makerFillFraction === null || !Number.isFinite(mark.makerFillFraction)) return false;
  return mark.makerFillFraction === 0
    ? mark.makerNetBps === null || Number.isFinite(mark.makerNetBps)
    : mark.makerNetBps !== null && Number.isFinite(mark.makerNetBps);
}

function groupRouteShadowCohorts(marks: readonly OptimizationRouteShadowMark[], options: TradeOptimizationOptions,
  key: (mark: OptimizationRouteShadowMark) => string): Record<string, RouteShadowCohort> {
  const groups = new Map<string, OptimizationRouteShadowMark[]>();
  for (const mark of marks) {
    const group = key(mark);
    const values = groups.get(group) ?? [];
    values.push(mark);
    groups.set(group, values);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([group, values]) => [group, routeShadowCohort(values, options)]));
}

function routeShadowCohort(marks: readonly OptimizationRouteShadowMark[],
  options: TradeOptimizationOptions): RouteShadowCohort {
  const slice = routeShadowSlice(marks);
  const observedDurationMs = span(marks.map((mark) => mark.signalAtMs));
  const dataReady = slice.samples >= options.minimumSamples && observedDurationMs >= options.minimumDurationMs;
  const calibratedEvidence = calibratedRouteEvidence(marks, options.minimumSamples);
  const deploymentReady = dataReady && calibratedEvidence
    && (slice.lower95TakerNetBps ?? Number.NEGATIVE_INFINITY) > 0
    && (slice.lower95TakerMinusMakerBps ?? Number.NEGATIVE_INFINITY) > 0;
  const reason = deploymentReady ? null
    : slice.samples < options.minimumSamples ? `Only ${slice.samples} samples; ${options.minimumSamples} required`
      : observedDurationMs < options.minimumDurationMs
        ? `Observed span is ${observedDurationMs} ms; ${options.minimumDurationMs} ms required`
        : !calibratedEvidence
          ? "Route deployment requires calibrated edge metadata with sufficient effective samples"
        : (slice.lower95TakerNetBps ?? Number.NEGATIVE_INFINITY) <= 0
          ? `Lower 95% taker net return is ${slice.lower95TakerNetBps}; it must be positive`
          : `Lower 95% taker-versus-alternative return is ${slice.lower95TakerMinusMakerBps}; it must be positive`;
  return { ...slice, observedDurationMs, dataReady, deploymentReady, reason };
}

function makerRouteShadowSlice(marks: readonly OptimizationRouteShadowMark[]): MakerRouteShadowSlice {
  if (marks.length === 0) return {
    samples: 0, fills: 0, fillRate: null, meanPolicyNetBps: null, lower95PolicyNetBps: null,
    meanFilledNetBps: null, profitable: 0, unprofitable: 0,
  };
  const policyReturns = marks.map((mark) => mark.makerNetBps ?? 0);
  const filledReturns = marks.flatMap((mark) => (mark.makerFillFraction ?? 0) > 0 && mark.makerNetBps !== null
    ? [mark.makerNetBps] : []);
  return {
    samples: marks.length,
    fills: filledReturns.length,
    fillRate: filledReturns.length / marks.length,
    meanPolicyNetBps: mean(policyReturns),
    lower95PolicyNetBps: lowerConfidenceMean(policyReturns),
    meanFilledNetBps: filledReturns.length ? mean(filledReturns) : null,
    profitable: policyReturns.filter((value) => value > 0).length,
    unprofitable: policyReturns.filter((value) => value <= 0).length,
  };
}

function groupMakerRouteShadowCohorts(marks: readonly OptimizationRouteShadowMark[], options: TradeOptimizationOptions,
  key: (mark: OptimizationRouteShadowMark) => string): Record<string, MakerRouteShadowCohort> {
  const groups = new Map<string, OptimizationRouteShadowMark[]>();
  for (const mark of marks) {
    const group = key(mark);
    const values = groups.get(group) ?? [];
    values.push(mark);
    groups.set(group, values);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([group, values]) => {
    const slice = makerRouteShadowSlice(values);
    const observedDurationMs = span(values.map((mark) => mark.signalAtMs));
    const dataReady = slice.samples >= options.minimumSamples && observedDurationMs >= options.minimumDurationMs;
    const calibratedEvidence = calibratedRouteEvidence(values, options.minimumSamples);
    const deploymentReady = dataReady && calibratedEvidence
      && (slice.lower95PolicyNetBps ?? Number.NEGATIVE_INFINITY) > 0;
    const reason = deploymentReady ? null
      : slice.samples < options.minimumSamples ? `Only ${slice.samples} samples; ${options.minimumSamples} required`
        : observedDurationMs < options.minimumDurationMs
          ? `Observed span is ${observedDurationMs} ms; ${options.minimumDurationMs} ms required`
          : !calibratedEvidence
            ? "Maker deployment requires calibrated edge metadata with sufficient effective samples"
            : `Lower 95% maker policy net return is ${slice.lower95PolicyNetBps}; it must be positive`;
    return [group, { ...slice, observedDurationMs, dataReady, deploymentReady, reason }];
  }));
}

function calibratedRouteEvidence(marks: readonly OptimizationRouteShadowMark[], minimumEffectiveSamples: number): boolean {
  return marks.length > 0 && marks.every((mark) => mark.edgeSource === "CALIBRATED"
    && (mark.edgeEffectiveSampleCount ?? Number.NEGATIVE_INFINITY) >= minimumEffectiveSamples);
}

function makerFillReport(orders: readonly OptimizationOrder[], options: TradeOptimizationOptions,
  minimumFillAuc: number): TradeOptimizationReport["makerFill"] {
  const makerOrders = orders.filter((order) => !order.reduceOnlyIntent && order.style === "maker");
  const pendingAttempts = makerOrders.filter((order) => !TERMINAL_ORDER_STATES.has(order.status.toUpperCase())).length;
  const terminal = makerOrders.filter((order) => TERMINAL_ORDER_STATES.has(order.status.toUpperCase()));
  const excludedUncleanAttempts = terminal.filter((order) => order.telemetryDroppedRecords !== 0).length;
  const cleanTerminal = terminal.filter((order) => order.telemetryDroppedRecords === 0);
  const attempts = cleanTerminal.flatMap((order): FillAttempt[] => {
    const probability = order.fillProbability;
    if (probability === null || !Number.isFinite(probability) || probability < 0 || probability > 1
      || !(order.requestedQty > 0) || !Number.isFinite(order.filledQty)) return [];
    return [{ ...order, probability, label: order.filledQty > 0 ? 1 : 0 }];
  });
  const invalidAttempts = cleanTerminal.length - attempts.length;
  const observedDurationMs = span(attempts.map((attempt) => attempt.createdMs));
  const base = calibrationSlice(attempts);
  const rocAuc = fillRocAuc(attempts);
  const fitted = fitHazardIntercept(attempts);
  const dataReady = attempts.length >= options.minimumSamples && observedDurationMs >= options.minimumDurationMs;
  const deploymentReady = dataReady && rocAuc !== null && rocAuc >= minimumFillAuc && fitted !== null;
  const reason = deploymentReady ? null
    : attempts.length < options.minimumSamples ? `Only ${attempts.length} clean terminal maker attempts; ${options.minimumSamples} required`
      : observedDurationMs < options.minimumDurationMs ? `Clean maker-attempt span is ${observedDurationMs} ms; ${options.minimumDurationMs} ms required`
        : rocAuc === null ? "Maker-fill discrimination requires both filled and unfilled attempts"
          : rocAuc < minimumFillAuc ? `Maker-fill ROC AUC ${rocAuc.toFixed(4)} is below ${minimumFillAuc.toFixed(4)}; an intercept-only change is unsafe`
            : "No finite hazard-intercept calibration was available";
  return {
    ...base,
    pendingAttempts,
    invalidAttempts,
    excludedUncleanAttempts,
    observedDurationMs,
    rocAuc,
    calibrationBuckets: groupCalibration(attempts, (attempt) => probabilityBucket(attempt.probability)),
    groups: groupCalibration(attempts, (attempt) => `${attempt.symbol}:${attempt.side === 1 ? "long" : "short"}:${attempt.entryFamily ?? "UNKNOWN"}`),
    fittedHazardInterceptOffset: fitted?.offset ?? null,
    fittedPredictedMean: fitted?.predictedMean ?? null,
    fittedBrierScore: fitted?.brierScore ?? null,
    fittedLogLoss: fitted?.logLoss ?? null,
    dataReady,
    deploymentReady,
    reason,
  };
}

function timeoutReport(orders: readonly OptimizationOrder[], options: TradeOptimizationOptions): TradeOptimizationReport["unproductiveExitShadow"] {
  const exitsByEntry = new Map<string, OptimizationOrder>();
  let excludedUncleanTrades = 0;
  for (const order of orders) {
    const position = order.livePosition;
    if (!order.reduceOnlyIntent || order.status.toUpperCase() !== "FILLED" || !(order.filledQty > 0)
      || !position || position.entryOrderId === null || position.closedAtMs === null || position.realizedPnl === null) continue;
    if (order.telemetryDroppedRecords !== 0) { excludedUncleanTrades += 1; continue; }
    const previous = exitsByEntry.get(position.entryOrderId);
    if (!previous || previous.updatedMs < order.updatedMs) exitsByEntry.set(position.entryOrderId, order);
  }
  const closed = [...exitsByEntry.values()];
  const candidates = closed.flatMap((order) => timeoutCandidate(order, options.shadowUnproductiveExitMs));
  const deltas = candidates.map((candidate) => candidate.counterfactualPnl - candidate.actualPnl);
  const averagePnlDelta = deltas.length ? mean(deltas) : null;
  const lower95AveragePnlDelta = lowerConfidenceMean(deltas);
  const observedDurationMs = span(candidates.flatMap((candidate) => [candidate.openedMs]));
  const dataReady = candidates.length >= options.minimumSamples && observedDurationMs >= options.minimumDurationMs;
  const deploymentReady = dataReady && lower95AveragePnlDelta !== null && lower95AveragePnlDelta > 0;
  const reason = deploymentReady ? null
    : candidates.length < options.minimumSamples
      ? `Only ${candidates.length} clean ${options.shadowUnproductiveExitMs / 60_000}-minute unproductive trades; ${options.minimumSamples} required`
      : observedDurationMs < options.minimumDurationMs ? `Eligible trade span is ${observedDurationMs} ms; ${options.minimumDurationMs} ms required`
        : lower95AveragePnlDelta === null ? "A confidence bound requires at least two eligible trades"
          : `The lower 95% average P&L delta is ${lower95AveragePnlDelta}; it must be positive`;
  const pnlDeltaByActualExitReason: Record<string, number> = {};
  for (const candidate of candidates) {
    pnlDeltaByActualExitReason[candidate.exitReason] = (pnlDeltaByActualExitReason[candidate.exitReason] ?? 0)
      + candidate.counterfactualPnl - candidate.actualPnl;
  }
  return {
    closedTrades: closed.length,
    eligibleTrades: candidates.length,
    excludedUncleanTrades,
    observedDurationMs,
    counterfactualWins: candidates.filter((candidate) => candidate.counterfactualPnl > candidate.actualPnl).length,
    actualTotalPnl: sum(candidates.map((candidate) => candidate.actualPnl)),
    counterfactualTotalPnl: sum(candidates.map((candidate) => candidate.counterfactualPnl)),
    totalPnlDelta: sum(deltas),
    averagePnlDelta,
    lower95AveragePnlDelta,
    pnlDeltaByActualExitReason,
    dataReady,
    deploymentReady,
    reason,
  };
}

function timeoutCandidate(order: OptimizationOrder, shadowExitMs: number): TimeoutCandidate[] {
  const position = order.livePosition;
  if (!position) return [];
  const closedAtMs = position.closedAtMs, realizedPnl = position.realizedPnl;
  if (closedAtMs === null || realizedPnl === null) return [];
  const targetMs = position.openedMs + shadowExitMs;
  if (closedAtMs <= targetMs) return [];
  const history = [...position.pnlHistory].filter(validPnlPoint).sort((a, b) => a.atMs - b.atMs);
  const beforeTarget = history.filter((point) => point.atMs <= targetMs && point.kind !== "close");
  if (beforeTarget.length === 0 || Math.max(...beforeTarget.map((point) => point.unrealizedPnlBps)) >= 0) return [];
  const counterfactual = history.find((point) => point.atMs >= targetMs && point.atMs < closedAtMs && point.kind !== "close");
  if (!counterfactual) return [];
  return [{
    openedMs: position.openedMs,
    actualPnl: realizedPnl,
    counterfactualPnl: counterfactual.unrealizedPnl,
    exitReason: order.exitReason ?? "UNKNOWN",
  }];
}

function calibrationSlice(attempts: readonly FillAttempt[], probability = (attempt: FillAttempt): number => attempt.probability): CalibrationSlice {
  if (attempts.length === 0) return { attempts: 0, anyFilled: 0, predictedMean: null, actualAnyFillRate: null,
    quantityFillRate: null, brierScore: null, logLoss: null };
  const probabilities = attempts.map(probability);
  const labels = attempts.map((attempt) => attempt.label);
  const requested = sum(attempts.map((attempt) => attempt.requestedQty));
  return {
    attempts: attempts.length,
    anyFilled: sum(labels),
    predictedMean: mean(probabilities),
    actualAnyFillRate: mean(labels),
    quantityFillRate: requested > 0 ? sum(attempts.map((attempt) => Math.min(attempt.requestedQty, Math.max(0, attempt.filledQty)))) / requested : null,
    brierScore: mean(probabilities.map((value, index) => Math.pow(value - labels[index]!, 2))),
    logLoss: mean(probabilities.map((value, index) => binaryLogLoss(value, labels[index]!))),
  };
}

function groupCalibration(attempts: readonly FillAttempt[], key: (attempt: FillAttempt) => string): Record<string, CalibrationSlice> {
  const groups = new Map<string, FillAttempt[]>();
  for (const attempt of attempts) {
    const group = key(attempt);
    const values = groups.get(group) ?? [];
    values.push(attempt);
    groups.set(group, values);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([group, values]) => [group, calibrationSlice(values)]));
}

function fitHazardIntercept(attempts: readonly FillAttempt[]): { offset: number; predictedMean: number; brierScore: number; logLoss: number } | null {
  if (!attempts.some((attempt) => attempt.label === 1) || !attempts.some((attempt) => attempt.label === 0)) return null;
  let best: { offset: number; predictedMean: number; brierScore: number; logLoss: number } | null = null;
  for (let step = -32; step <= 8; step += 1) {
    const offset = step / 4;
    const slice = calibrationSlice(attempts, (attempt) => shiftedHazardProbability(attempt.probability, offset));
    if (slice.predictedMean === null || slice.brierScore === null || slice.logLoss === null) continue;
    const candidate = { offset, predictedMean: slice.predictedMean, brierScore: slice.brierScore, logLoss: slice.logLoss };
    if (!best || candidate.logLoss < best.logLoss || (candidate.logLoss === best.logLoss && candidate.brierScore < best.brierScore)) best = candidate;
  }
  return best;
}

function shiftedHazardProbability(probability: number, interceptOffset: number): number {
  const baseSurvival = Math.max(0, Math.min(1, 1 - probability));
  return 1 - Math.pow(baseSurvival, Math.exp(interceptOffset));
}

function fillRocAuc(attempts: readonly FillAttempt[]): number | null {
  const positive = attempts.filter((attempt) => attempt.label === 1).length;
  const negative = attempts.length - positive;
  if (positive === 0 || negative === 0) return null;
  const sorted = [...attempts].sort((a, b) => a.probability - b.probability);
  let positiveRankSum = 0;
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end]!.probability === sorted[start]!.probability) end += 1;
    const averageRank = ((start + 1) + end) / 2;
    positiveRankSum += averageRank * sorted.slice(start, end).filter((attempt) => attempt.label === 1).length;
    start = end;
  }
  return (positiveRankSum - positive * (positive + 1) / 2) / (positive * negative);
}

function probabilityBucket(probability: number): string {
  const lower = Math.min(4, Math.floor(probability * 5)) / 5;
  return `${lower.toFixed(1)}-${(lower + .2).toFixed(1)}`;
}

function binaryLogLoss(probability: number, label: 0 | 1): number {
  const p = Math.max(1e-9, Math.min(1 - 1e-9, probability));
  return -(label * Math.log(p) + (1 - label) * Math.log(1 - p));
}

function lowerConfidenceMean(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values);
  const variance = sum(values.map((value) => Math.pow(value - average, 2))) / (values.length - 1);
  return average - 1.96 * Math.sqrt(variance / values.length);
}

function validPnlPoint(point: DashboardPnlPoint): boolean {
  return Number.isFinite(point.atMs) && Number.isFinite(point.unrealizedPnl) && Number.isFinite(point.unrealizedPnlBps);
}

function validateOptions(options: TradeOptimizationOptions): void {
  if (!(options.minimumDurationMs > 0) || !(options.minimumSamples > 0) || !(options.shadowUnproductiveExitMs > 0)
    || !(options.activeUnproductiveExitMs > options.shadowUnproductiveExitMs)) {
    throw new Error("Optimization safeguards require positive duration/sample limits and a shadow timeout below the active timeout");
  }
  const auc = options.minimumFillAuc ?? .55;
  if (!(auc >= .5 && auc <= 1)) throw new Error("minimumFillAuc must be between 0.5 and 1");
  const routeHorizon = options.routeShadowDecisionHorizonMs ?? 30_000;
  if (!Number.isInteger(routeHorizon) || routeHorizon <= 0) throw new Error("routeShadowDecisionHorizonMs must be positive");
  const maximumMarkDelayMs = options.routeShadowMaximumMarkDelayMs ?? 1_000;
  if (!Number.isInteger(maximumMarkDelayMs) || maximumMarkDelayMs < 0) {
    throw new Error("routeShadowMaximumMarkDelayMs must be a non-negative integer");
  }
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const mean = (values: readonly number[]): number => sum(values) / values.length;
function span(values: readonly number[]): number {
  if (values.length < 2) return 0;
  let minimum = Number.POSITIVE_INFINITY, maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
  return maximum - minimum;
}
