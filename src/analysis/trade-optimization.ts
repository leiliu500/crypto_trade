import type { DashboardPnlPoint } from "../dashboard/types.js";

export interface OptimizationLivePosition {
  openedMs: number;
  closedAtMs: number | null;
  realizedPnl: number | null;
  entryOrderId: string | null;
  pnlHistory: readonly DashboardPnlPoint[];
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
  makerFills: number;
  makerFillRate: number | null;
  meanMakerPolicyNetBps: number | null;
  meanTakerNetBps: number | null;
  meanTakerMinusMakerBps: number | null;
  lower95TakerMinusMakerBps: number | null;
  takerWins: number;
  makerWins: number;
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
    decisions: number;
    observedDurationMs: number;
    horizons: Record<string, RouteShadowSlice>;
    groups: Record<string, RouteShadowSlice>;
    decisionHorizon: RouteShadowSlice;
    dataReady: boolean;
    deploymentReady: boolean;
    reason: string | null;
  };
}

interface FillAttempt extends OptimizationOrder { probability: number; label: 0 | 1; }
interface TimeoutCandidate { openedMs: number; actualPnl: number; counterfactualPnl: number; exitReason: string; }

const TERMINAL_ORDER_STATES = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);

export function analyzeTradeOptimization(orders: readonly OptimizationOrder[], options: TradeOptimizationOptions,
  routeShadows: readonly OptimizationRouteShadowMark[] = []): TradeOptimizationReport {
  validateOptions(options);
  const minimumFillAuc = options.minimumFillAuc ?? .55;
  const routeShadowDecisionHorizonMs = options.routeShadowDecisionHorizonMs ?? 30_000;
  const routeShadowMaximumMarkDelayMs = options.routeShadowMaximumMarkDelayMs ?? 1_000;
  const cleanOrders = orders.filter((order) => order.telemetryDroppedRecords === 0);
  const makerFill = makerFillReport(orders, options, minimumFillAuc);
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
    unproductiveExitShadow,
    entryRouteShadow,
  };
}

function routeShadowReport(marks: readonly OptimizationRouteShadowMark[], options: TradeOptimizationOptions,
  decisionHorizonMs: number, maximumMarkDelayMs: number): TradeOptimizationReport["entryRouteShadow"] {
  const clean = marks.filter((mark) => mark.telemetryDroppedRecords === 0);
  const paired = clean.filter((mark) => validRouteShadowMark(mark, maximumMarkDelayMs));
  const grouped = new Map<number, OptimizationRouteShadowMark[]>();
  for (const mark of paired) {
    const values = grouped.get(mark.horizonMs) ?? [];
    values.push(mark);
    grouped.set(mark.horizonMs, values);
  }
  const horizons = Object.fromEntries([...grouped].sort(([a], [b]) => a - b)
    .map(([horizonMs, values]) => [String(horizonMs), routeShadowSlice(values)]));
  const decisionMarks = grouped.get(decisionHorizonMs) ?? [];
  const decisionHorizon = routeShadowSlice(decisionMarks);
  const groups = groupRouteShadows(decisionMarks,
    (mark) => `${mark.symbol}:${mark.side === 1 ? "long" : "short"}:${mark.family}`);
  const observedDurationMs = span(decisionMarks.map((mark) => mark.signalAtMs));
  const dataReady = decisionMarks.length >= options.minimumSamples && observedDurationMs >= options.minimumDurationMs;
  const deploymentReady = dataReady && decisionHorizon.meanTakerNetBps !== null
    && decisionHorizon.meanTakerNetBps > 0
    && decisionHorizon.lower95TakerMinusMakerBps !== null
    && decisionHorizon.lower95TakerMinusMakerBps > 0;
  const reason = deploymentReady ? null
    : decisionMarks.length < options.minimumSamples
      ? `Only ${decisionMarks.length} clean paired route shadows at ${decisionHorizonMs} ms; ${options.minimumSamples} required`
      : observedDurationMs < options.minimumDurationMs
        ? `Paired route-shadow span is ${observedDurationMs} ms; ${options.minimumDurationMs} ms required`
        : decisionHorizon.meanTakerNetBps === null || decisionHorizon.meanTakerNetBps <= 0
          ? "Mean taker shadow net return must be positive"
          : decisionHorizon.lower95TakerMinusMakerBps === null
            ? "A maker-versus-taker confidence bound requires at least two paired shadows"
            : `The lower 95% taker-minus-maker delta is ${decisionHorizon.lower95TakerMinusMakerBps}; it must be positive`;
  return {
    marks: marks.length, cleanMarks: clean.length, excludedUncleanMarks: marks.length - clean.length,
    excludedInvalidOrDelayedCleanMarks: clean.length - paired.length,
    decisions: new Set(paired.map((mark) => mark.decisionId)).size, observedDurationMs, horizons, groups,
    decisionHorizon, dataReady, deploymentReady, reason,
  };
}

function routeShadowSlice(marks: readonly OptimizationRouteShadowMark[]): RouteShadowSlice {
  if (marks.length === 0) return {
    samples: 0, makerFills: 0, makerFillRate: null, meanMakerPolicyNetBps: null,
    meanTakerNetBps: null, meanTakerMinusMakerBps: null, lower95TakerMinusMakerBps: null,
    takerWins: 0, makerWins: 0,
  };
  const makerPolicy = marks.map((mark) => mark.makerNetBps ?? 0);
  const taker = marks.map((mark) => mark.takerNetBps!);
  const deltas = taker.map((value, index) => value - makerPolicy[index]!);
  return {
    samples: marks.length,
    makerFills: marks.filter((mark) => (mark.makerFillFraction ?? 0) > 0).length,
    makerFillRate: mean(marks.map((mark) => (mark.makerFillFraction ?? 0) > 0 ? 1 : 0)),
    meanMakerPolicyNetBps: mean(makerPolicy), meanTakerNetBps: mean(taker),
    meanTakerMinusMakerBps: mean(deltas), lower95TakerMinusMakerBps: lowerConfidenceMean(deltas),
    takerWins: deltas.filter((value) => value > 0).length, makerWins: deltas.filter((value) => value < 0).length,
  };
}

function validRouteShadowMark(mark: OptimizationRouteShadowMark, maximumMarkDelayMs: number): boolean {
  return Boolean(mark.makerAvailable && mark.takerAvailable) && Number.isFinite(mark.signalAtMs)
    && Number.isInteger(mark.horizonMs) && mark.horizonMs > 0
    && Number.isFinite(mark.markDelayMs) && mark.markDelayMs >= 0 && mark.markDelayMs <= maximumMarkDelayMs
    && mark.takerNetBps !== null && Number.isFinite(mark.takerNetBps)
    && (mark.makerNetBps === null || Number.isFinite(mark.makerNetBps))
    && (mark.makerFillFraction === null || (Number.isFinite(mark.makerFillFraction)
      && mark.makerFillFraction >= 0 && mark.makerFillFraction <= 1));
}

function groupRouteShadows(marks: readonly OptimizationRouteShadowMark[],
  key: (mark: OptimizationRouteShadowMark) => string): Record<string, RouteShadowSlice> {
  const groups = new Map<string, OptimizationRouteShadowMark[]>();
  for (const mark of marks) {
    const group = key(mark);
    const values = groups.get(group) ?? [];
    values.push(mark);
    groups.set(group, values);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([group, values]) => [group, routeShadowSlice(values)]));
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
