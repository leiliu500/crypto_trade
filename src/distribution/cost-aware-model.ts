import { ConditionalDistributionModel } from "./model.js";
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SCENARIOS, DISTRIBUTION_SPEC as S,
  type DistributionSample } from "./spec.js";

/** One prescribed research candidate. Costs have an unshrunk empirical mean;
 * ridge regularizes feature coefficients while leaving intercepts unpenalized.
 * This model has no entry-eligibility or order-submission interface. */
export const COST_AWARE_RIDGE_SPEC = Object.freeze({
  version: "btc-eth-cost-aware-ridge-v1", researchOnly: true, labelVersion: S.version,
  featureDimension: 12, ridgeLambda: 16, featureScaleFloor: .1,
  memoryHalfLifeMs: 7 * 86_400_000, maximumTrainingAgeMs: 86_400_000,
  maximumSamplesPerAction: 1024, minimumSamples: 48, minimumEffectiveSamples: 32,
  minimumTrainingDays: 3, minimumDayWeight: 1, minimumFilledEffectiveSamples: 16,
  fillTarget: "FILLED_FRACTION_INCLUDING_UNFILLED_ZERO",
  grossTarget: "GROSS_BPS_PER_FILLED_FRACTION",
  grossAndCostWeights: "RECENCY_TIMES_FILLED_FRACTION",
  coefficientRefresh: "FROZEN_AT_STRICT_TRAINING_CUTOFF",
});

export interface CostAwareScenarioPrediction {
  scenario: string; meanNetBps: number | null; grossBps: number | null; costBps: number | null;
  filledFraction: number | null; samples: number; effectiveSamples: number;
  filledEffectiveSamples: number; observedDays: number; reason: string;
}
export interface LinearFit { intercept: number; centers: number[]; scales: number[]; coefficients: number[] }
export interface Fit {
  symbol: string; actionId: string; scenario: string; samples: number; effectiveSamples: number;
  filledEffectiveSamples: number; observedDays: number; latestCompletedMs: number | null;
  trainingSampleIds: string[]; reason: string;
  fill: LinearFit | null; grossPerFilledUnit: LinearFit | null; costPerFilledUnitBps: number | null;
}
interface WeightedRow { features: readonly number[]; target: number; weight: number }
const DAY_MS = 86_400_000;
const validTime = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const validFeatures = (features: readonly number[]): boolean => Array.isArray(features)
  && features.length === COST_AWARE_RIDGE_SPEC.featureDimension && features.every(n => Number.isFinite(n) && Math.abs(n) <= 1);
const bankKey = (symbol: string, actionId: string): string => `${symbol}:${actionId}`;
const fitKey = (symbol: string, actionId: string, scenario: string): string => `${symbol}:${actionId}:${scenario}`;
const effectiveCount = (weights: readonly number[]): number => {
  const total = weights.reduce((sum, weight) => sum + weight, 0), squares = weights.reduce((sum, weight) => sum + weight * weight, 0);
  return squares > 0 ? total * total / squares : 0;
};

/** Solve the positive-definite ridge normal equations by Cholesky. A fixed
 * positive penalty guarantees a unique coefficient fit for constant features. */
function solve(matrix: number[][], target: number[]): number[] | null {
  const dimension = target.length, lower = Array.from({ length: dimension }, () => Array<number>(dimension).fill(0));
  for (let i = 0; i < dimension; i++) for (let j = 0; j <= i; j++) {
    let value = matrix[i]![j]!;
    for (let k = 0; k < j; k++) value -= lower[i]![k]! * lower[j]![k]!;
    if (!Number.isFinite(value) || i === j && value <= 0) return null;
    lower[i]![j] = i === j ? Math.sqrt(value) : value / lower[j]![j]!;
  }
  const interim = Array<number>(dimension).fill(0), result = Array<number>(dimension).fill(0);
  for (let i = 0; i < dimension; i++) {
    let value = target[i]!;
    for (let j = 0; j < i; j++) value -= lower[i]![j]! * interim[j]!;
    interim[i] = value / lower[i]![i]!;
  }
  for (let i = dimension - 1; i >= 0; i--) {
    let value = interim[i]!;
    for (let j = i + 1; j < dimension; j++) value -= lower[j]![i]! * result[j]!;
    result[i] = value / lower[i]![i]!;
  }
  return result.every(Number.isFinite) ? result : null;
}

function fitLinear(rows: WeightedRow[]): LinearFit | null {
  if (!rows.length || rows.some(row => !Number.isFinite(row.target) || !Number.isFinite(row.weight) || row.weight < 0)) return null;
  const dimension = COST_AWARE_RIDGE_SPEC.featureDimension, total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (!(total > 0)) return null;
  const intercept = rows.reduce((sum, row) => sum + row.weight * row.target, 0) / total;
  const centers = Array.from({ length: dimension }, (_, j) => rows.reduce((sum, row) => sum + row.weight * row.features[j]!, 0) / total);
  const scales = centers.map((center, j) => Math.max(COST_AWARE_RIDGE_SPEC.featureScaleFloor,
    Math.sqrt(rows.reduce((sum, row) => sum + row.weight * (row.features[j]! - center) ** 2, 0) / total)));
  const matrix = Array.from({ length: dimension }, (_, i) => Array.from({ length: dimension }, (_, j) => i === j ? COST_AWARE_RIDGE_SPEC.ridgeLambda : 0));
  const target = Array<number>(dimension).fill(0);
  for (const row of rows) {
    const x = centers.map((center, j) => (row.features[j]! - center) / scales[j]!);
    for (let i = 0; i < dimension; i++) {
      target[i]! += row.weight * x[i]! * (row.target - intercept);
      for (let j = 0; j <= i; j++) matrix[i]![j]! += row.weight * x[i]! * x[j]!;
    }
  }
  for (let i = 0; i < dimension; i++) for (let j = 0; j < i; j++) matrix[j]![i] = matrix[i]![j]!;
  const coefficients = solve(matrix, target);
  return Number.isFinite(intercept) && centers.every(Number.isFinite) && scales.every(Number.isFinite) && coefficients
    ? { intercept, centers, scales, coefficients } : null;
}
function predict(fit: LinearFit, features: readonly number[]): number {
  return fit.intercept + fit.coefficients.reduce((sum, coefficient, j) => sum + coefficient * (features[j]! - fit.centers[j]!) / fit.scales[j]!, 0);
}

export class CostAwareRidgeModel {
  private readonly fits = new Map<string, Fit>();
  private readonly acceptedSamples: number;
  private readonly retainedSamples: number;

  constructor(samples: DistributionSample[], private readonly cutoffMs: number) {
    if (!validTime(cutoffMs) || !Array.isArray(samples)) throw new Error("INVALID_COST_AWARE_TRAINING_INPUT");
    for (const sample of samples) if (!sample || !validTime(sample.completedAtMs) || sample.completedAtMs >= cutoffMs) {
      throw new Error("COST_AWARE_FUTURE_OR_INVALID_TRAINING_SAMPLE");
    }
    const validator = new ConditionalDistributionModel(), banks = new Map<string, DistributionSample[]>();
    for (const sample of [...samples].sort((a, b) => a.signalAtMs - b.signalAtMs || a.completedAtMs - b.completedAtMs)) {
      if (!validator.observe(sample)) throw new Error("INVALID_COST_AWARE_TRAINING_SAMPLE");
      const key = bankKey(sample.symbol, sample.actionId), rows = banks.get(key) ?? [];
      rows.push({ ...sample, features: [...sample.features], outcomes: sample.outcomes.map(outcome => ({ ...outcome })) });
      if (rows.length > COST_AWARE_RIDGE_SPEC.maximumSamplesPerAction) rows.shift();
      banks.set(key, rows);
    }
    this.acceptedSamples = samples.length;
    this.retainedSamples = [...banks.values()].reduce((sum, rows) => sum + rows.length, 0);
    for (const symbol of S.symbols) for (const action of DISTRIBUTION_ACTIONS) for (const scenario of DISTRIBUTION_SCENARIOS) {
      this.fits.set(fitKey(symbol, action.id, scenario.id), this.fit(symbol, action.id, scenario.id,
        banks.get(bankKey(symbol, action.id)) ?? []));
    }
  }

  predictScenarios(symbol: string, actionId: string, features: readonly number[], nowMs: number): CostAwareScenarioPrediction[] {
    const inputValid = S.symbols.some(s => s === symbol) && DISTRIBUTION_ACTIONS.some(action => action.id === actionId)
      && validFeatures(features) && validTime(nowMs) && nowMs >= this.cutoffMs;
    return DISTRIBUTION_SCENARIOS.map(scenario => {
      const fit = this.fits.get(fitKey(symbol, actionId, scenario.id));
      const empty = (reason: string): CostAwareScenarioPrediction => ({ scenario: scenario.id,
        meanNetBps: null, grossBps: null, costBps: null, filledFraction: null, samples: fit?.samples ?? 0,
        effectiveSamples: fit?.effectiveSamples ?? 0, filledEffectiveSamples: fit?.filledEffectiveSamples ?? 0,
        observedDays: fit?.observedDays ?? 0, reason });
      if (!inputValid) return empty("INVALID_COST_AWARE_PREDICTION_INPUT");
      if (!fit || fit.reason !== "READY") return empty(fit?.reason ?? "NO_TRAINING_SAMPLES");
      if (nowMs - fit.latestCompletedMs! > COST_AWARE_RIDGE_SPEC.maximumTrainingAgeMs) return empty("STALE_TRAINING");
      const fraction = Math.max(0, Math.min(1, predict(fit.fill!, features)));
      const grossPerFilled = predict(fit.grossPerFilledUnit!, features);
      const grossBps = fraction * grossPerFilled, costBps = fraction * fit.costPerFilledUnitBps!;
      const meanNetBps = grossBps - costBps;
      if (![fraction, grossBps, costBps, meanNetBps].every(Number.isFinite)) return empty("NONFINITE_PREDICTION");
      return { ...empty("READY"), meanNetBps, grossBps, costBps, filledFraction: fraction };
    });
  }

  diagnostics() {
    return structuredClone({ version: COST_AWARE_RIDGE_SPEC.version, researchOnly: true, cutoffMs: this.cutoffMs,
      acceptedSamples: this.acceptedSamples, retainedSamples: this.retainedSamples, fits: [...this.fits.values()] });
  }

  private fit(symbol: string, actionId: string, scenario: string, samples: DistributionSample[]): Fit {
    const weights = samples.map(row => 2 ** (-(this.cutoffMs - row.completedAtMs) / COST_AWARE_RIDGE_SPEC.memoryHalfLifeMs));
    const outcomes = samples.map(row => row.outcomes.find(outcome => outcome.scenario === scenario)!);
    const filledIndices = outcomes.flatMap((outcome, i) => outcome.status === "FILLED" ? [i] : []);
    const filledWeights = filledIndices.map(i => weights[i]! * outcomes[i]!.filledFraction);
    const days = new Map<number, number>();
    samples.forEach((row, i) => { const day = Math.floor(row.signalAtMs / DAY_MS); days.set(day, (days.get(day) ?? 0) + weights[i]!); });
    const fit: Fit = { symbol, actionId, scenario, samples: samples.length, effectiveSamples: effectiveCount(weights),
      filledEffectiveSamples: effectiveCount(filledWeights), observedDays: [...days.values()].filter(weight => weight >= COST_AWARE_RIDGE_SPEC.minimumDayWeight).length,
      latestCompletedMs: samples.length ? Math.max(...samples.map(row => row.completedAtMs)) : null,
      trainingSampleIds: samples.map(row => row.id), reason: "READY", fill: null, grossPerFilledUnit: null, costPerFilledUnitBps: null };
    fit.reason = !samples.length ? "NO_TRAINING_SAMPLES"
      : fit.samples < COST_AWARE_RIDGE_SPEC.minimumSamples ? "INSUFFICIENT_SAMPLES"
        : fit.effectiveSamples < COST_AWARE_RIDGE_SPEC.minimumEffectiveSamples ? "INSUFFICIENT_EFFECTIVE_SAMPLES"
          : fit.observedDays < COST_AWARE_RIDGE_SPEC.minimumTrainingDays ? "INSUFFICIENT_DAYS"
            : fit.filledEffectiveSamples < COST_AWARE_RIDGE_SPEC.minimumFilledEffectiveSamples ? "INSUFFICIENT_FILLED_SUPPORT" : "READY";
    if (fit.reason !== "READY") return fit;
    const fillRows = samples.map((row, i) => ({ features: row.features, target: outcomes[i]!.filledFraction, weight: weights[i]! }));
    const grossRows = filledIndices.map((i, j) => ({ features: samples[i]!.features,
      target: outcomes[i]!.grossBps! / outcomes[i]!.filledFraction, weight: filledWeights[j]! }));
    const costs = filledIndices.map(i => Math.max(0, (outcomes[i]!.grossBps! - outcomes[i]!.netBps!) / outcomes[i]!.filledFraction));
    const filledWeight = filledWeights.reduce((sum, weight) => sum + weight, 0);
    const costPerFilledUnit = costs.reduce((sum, cost, j) => sum + filledWeights[j]! * cost, 0) / filledWeight;
    const fill = fitLinear(fillRows), gross = fitLinear(grossRows);
    if (!fill || !gross || !Number.isFinite(costPerFilledUnit)) { fit.reason = "NONFINITE_FIT"; return fit; }
    fit.fill = fill; fit.grossPerFilledUnit = gross; fit.costPerFilledUnitBps = costPerFilledUnit;
    return fit;
  }
}
