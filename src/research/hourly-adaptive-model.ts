import { createHash } from "node:crypto";
import { HOURLY_CANDIDATES, HOURLY_MODEL_SPEC, hourlyCandidateFeatures,
  type HourlyCandidate, type HourlySymbol, type HourlyTrainingRow } from "./hourly-model.js";

const HOUR = 3_600_000, DAY = 24 * HOUR;
const SYMBOLS: readonly HourlySymbol[] = ["BTC/USD", "ETH/USD"];

/** One fixed adaptation rule; candidate features and gross labels remain v1.
 * The research runner separately applies its common 26-hour decision purge. */
export const HOURLY_ADAPTIVE_MODEL_SPEC = Object.freeze({
  version: "btc-eth-hourly-monthly-adaptive-ridge-v1",
  featureAndLabelVersion: HOURLY_MODEL_SPEC.version,
  candidates: HOURLY_CANDIDATES,
  refit: "UTC_CALENDAR_MONTH_START" as const,
  trailingDecisionDays: 365,
  recencyHalfLifeDays: 90,
  recencyClock: "LABEL_COMPLETED_AT_MS" as const,
  recencyWeight: "2^((completedAtMs-cutoffMs)/(90*24*3600000))" as const,
  normalization: "WEIGHTED_POPULATION_MEAN_AND_STANDARD_DEVIATION" as const,
  featureStandardDeviationFloor: .1,
  ridgePenalty: 16,
  ridgeObjective: "SUM_WEIGHTED_SQUARED_ERROR_PLUS_16_TIMES_COEFFICIENT_L2_SQUARED" as const,
  interceptPenalized: false,
  minimumSamples: 6_000,
  minimumWeightedESS: 1_000,
  weightedESSInterpretation: "WEIGHT_CONCENTRATION_NOT_INDEPENDENT_LABEL_COUNT" as const,
  latestLabelStrictlyBeforeCutoff: true,
  predictionsExpireAtNextMonth: true,
});

export interface AdaptiveHourlyAssetFit {
  symbol: HourlySymbol;
  samples: number;
  weightSum: number;
  weightSquaredSum: number;
  weightedESS: number;
  firstDecisionMs: number | null;
  lastDecisionMs: number | null;
  earliestCompletedMs: number | null;
  latestCompletedMs: number | null;
  intercept: number | null;
  targetMeanGrossBps: number | null;
  targetStdGrossBps: number | null;
  centers: number[];
  scales: number[];
  coefficients: number[];
  trainingRowsSha256: string;
  weightedRowsSha256: string;
  reason: "READY" | "NO_TRAINING_ROWS" | "INSUFFICIENT_TRAINING_ROWS" | "INSUFFICIENT_WEIGHTED_ESS";
}

const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
const validHour = (value: number) => validTime(value) && value % HOUR === 0;
const validSymbol = (value: string): value is HourlySymbol => (SYMBOLS as readonly string[]).includes(value);
const validFeatures = (value: readonly number[]) => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function validMonthStart(value: number): boolean {
  if (!validHour(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getUTCDate() === 1 && date.getUTCHours() === 0;
}

function solve(matrix: number[][], target: number[]): number[] {
  const size = target.length, lower = Array.from({ length: size }, () => Array<number>(size).fill(0));
  for (let i = 0; i < size; i++) for (let j = 0; j <= i; j++) {
    let value = matrix[i]![j]!;
    for (let k = 0; k < j; k++) value -= lower[i]![k]! * lower[j]![k]!;
    if (!Number.isFinite(value) || i === j && value <= 0) throw new Error("HOURLY_ADAPTIVE_NONFINITE_FIT");
    lower[i]![j] = i === j ? Math.sqrt(value) : value / lower[j]![j]!;
  }
  const intermediate = Array<number>(size).fill(0), result = Array<number>(size).fill(0);
  for (let i = 0; i < size; i++) {
    let value = target[i]!;
    for (let j = 0; j < i; j++) value -= lower[i]![j]! * intermediate[j]!;
    intermediate[i] = value / lower[i]![i]!;
  }
  for (let i = size - 1; i >= 0; i--) {
    let value = intermediate[i]!;
    for (let j = i + 1; j < size; j++) value -= lower[j]![i]! * result[j]!;
    result[i] = value / lower[i]![i]!;
  }
  if (!result.every(Number.isFinite)) throw new Error("HOURLY_ADAPTIVE_NONFINITE_FIT");
  return result;
}

/** Each instance freezes one monthly fit. It cannot learn during prediction or
 * silently carry an old fit into another month. Window violations throw rather
 * than silently filtering labels supplied by a research caller. */
export class AdaptiveHourlyRidgeModel {
  public readonly candidate: Readonly<HourlyCandidate>;
  private readonly fits = new Map<HourlySymbol, AdaptiveHourlyAssetFit>();
  private readonly windowStartMs: number;
  private readonly nextRefitMs: number;

  constructor(candidate: HourlyCandidate, rows: readonly HourlyTrainingRow[], private readonly cutoffMs: number) {
    const fixed = HOURLY_CANDIDATES.find(value => value.id === candidate?.id && value.kind === candidate.kind
      && value.horizonHours === candidate.horizonHours);
    if (!fixed || !validMonthStart(cutoffMs) || !Array.isArray(rows)) throw new Error("HOURLY_ADAPTIVE_INVALID_FIT_INPUT");
    this.candidate = fixed;
    this.windowStartMs = cutoffMs - HOURLY_ADAPTIVE_MODEL_SPEC.trailingDecisionDays * DAY;
    const nextMonth = new Date(cutoffMs); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    this.nextRefitMs = nextMonth.getTime();
    if (!validTime(this.windowStartMs) || !validMonthStart(this.nextRefitMs)) throw new Error("HOURLY_ADAPTIVE_INVALID_FIT_INPUT");
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row || !validSymbol(row.symbol) || !validHour(row.decisionMs) || !validHour(row.entryMs)
        || !validHour(row.exitMs) || row.entryMs !== row.decisionMs + HOUR
        || row.exitMs !== row.entryMs + fixed.horizonHours * HOUR || !validHour(row.completedAtMs)
        || row.completedAtMs !== row.exitMs + HOUR || row.completedAtMs >= cutoffMs
        || row.horizonHours !== fixed.horizonHours || !validFeatures(row.features) || !Number.isFinite(row.grossBps))
        throw new Error("HOURLY_ADAPTIVE_INVALID_OR_FUTURE_TRAINING_ROW");
      if (row.decisionMs < this.windowStartMs) throw new Error("HOURLY_ADAPTIVE_OUT_OF_WINDOW_TRAINING_ROW");
      const key = `${row.symbol}:${row.decisionMs}`;
      if (seen.has(key)) throw new Error("HOURLY_ADAPTIVE_DUPLICATE_TRAINING_ROW");
      seen.add(key);
    }
    for (const symbol of SYMBOLS) {
      const own = rows.filter(row => row.symbol === symbol).sort((a, b) => a.decisionMs - b.decisionMs);
      this.fits.set(symbol, this.fit(symbol, own));
    }
  }

  private fit(symbol: HourlySymbol, rows: readonly HourlyTrainingRow[]): AdaptiveHourlyAssetFit {
    const canonicalRows = rows.map(row => ({ symbol: row.symbol, decisionMs: row.decisionMs, entryMs: row.entryMs,
      exitMs: row.exitMs, completedAtMs: row.completedAtMs, horizonHours: row.horizonHours,
      features: [...row.features], grossBps: row.grossBps }));
    const weights = rows.map(row => 2 ** ((row.completedAtMs - this.cutoffMs) / (HOURLY_ADAPTIVE_MODEL_SPEC.recencyHalfLifeDays * DAY)));
    const weightSum = weights.reduce((sum, value) => sum + value, 0);
    const weightSquaredSum = weights.reduce((sum, value) => sum + value * value, 0);
    const weightedESS = weightSquaredSum > 0 ? weightSum * weightSum / weightSquaredSum : 0;
    const summary = { symbol, samples: rows.length, weightSum, weightSquaredSum, weightedESS,
      firstDecisionMs: rows[0]?.decisionMs ?? null, lastDecisionMs: rows.at(-1)?.decisionMs ?? null,
      earliestCompletedMs: rows[0]?.completedAtMs ?? null, latestCompletedMs: rows.at(-1)?.completedAtMs ?? null,
      trainingRowsSha256: hash(canonicalRows), weightedRowsSha256: hash({ cutoffMs: this.cutoffMs, rows: canonicalRows, weights }) };
    if (!rows.length) return { ...summary, intercept: null, targetMeanGrossBps: null, targetStdGrossBps: null,
      centers: [], scales: [], coefficients: [], reason: "NO_TRAINING_ROWS" };
    const inputs = rows.map(row => hourlyCandidateFeatures(row.features, this.candidate.kind)), dimension = inputs[0]!.length;
    const intercept = rows.reduce((sum, row, i) => sum + weights[i]! * row.grossBps, 0) / weightSum;
    const targetStdGrossBps = Math.sqrt(rows.reduce((sum, row, i) => sum + weights[i]! * (row.grossBps - intercept) ** 2, 0) / weightSum);
    const centers = Array.from({ length: dimension }, (_, j) => inputs.reduce((sum, values, i) => sum + weights[i]! * values[j]!, 0) / weightSum);
    const scales = centers.map((center, j) => Math.max(HOURLY_ADAPTIVE_MODEL_SPEC.featureStandardDeviationFloor,
      Math.sqrt(inputs.reduce((sum, values, i) => sum + weights[i]! * (values[j]! - center) ** 2, 0) / weightSum)));
    const matrix = Array.from({ length: dimension }, (_, i) => Array.from({ length: dimension }, (_, j) =>
      i === j ? HOURLY_ADAPTIVE_MODEL_SPEC.ridgePenalty : 0));
    const target = Array<number>(dimension).fill(0);
    inputs.forEach((values, row) => {
      const normalized = values.map((value, j) => (value - centers[j]!) / scales[j]!), weight = weights[row]!;
      for (let i = 0; i < dimension; i++) {
        target[i]! += weight * normalized[i]! * (rows[row]!.grossBps - intercept);
        for (let j = 0; j <= i; j++) matrix[i]![j]! += weight * normalized[i]! * normalized[j]!;
      }
    });
    for (let i = 0; i < dimension; i++) for (let j = 0; j < i; j++) matrix[j]![i] = matrix[i]![j]!;
    const coefficients = solve(matrix, target);
    if (![weightSum, weightSquaredSum, weightedESS, intercept, targetStdGrossBps, ...centers, ...scales].every(Number.isFinite))
      throw new Error("HOURLY_ADAPTIVE_NONFINITE_FIT");
    const reason = rows.length < HOURLY_ADAPTIVE_MODEL_SPEC.minimumSamples ? "INSUFFICIENT_TRAINING_ROWS"
      : weightedESS < HOURLY_ADAPTIVE_MODEL_SPEC.minimumWeightedESS ? "INSUFFICIENT_WEIGHTED_ESS" : "READY";
    return { ...summary, intercept, targetMeanGrossBps: intercept, targetStdGrossBps, centers, scales, coefficients, reason };
  }

  public predict(symbol: HourlySymbol, baseFeatures: readonly number[], decisionMs: number): number | null {
    if (!validSymbol(symbol) || !validFeatures(baseFeatures) || !validHour(decisionMs)
      || decisionMs < this.cutoffMs || decisionMs >= this.nextRefitMs) return null;
    const fit = this.fits.get(symbol); if (!fit || fit.reason !== "READY") return null;
    const values = hourlyCandidateFeatures(baseFeatures, this.candidate.kind);
    const result = fit.intercept! + fit.coefficients.reduce((sum, coefficient, j) =>
      sum + coefficient * (values[j]! - fit.centers[j]!) / fit.scales[j]!, 0);
    return Number.isFinite(result) ? result : null;
  }

  public diagnostics() {
    return structuredClone({ version: HOURLY_ADAPTIVE_MODEL_SPEC.version, spec: HOURLY_ADAPTIVE_MODEL_SPEC,
      specSha256: hash(HOURLY_ADAPTIVE_MODEL_SPEC), candidate: this.candidate, cutoffMs: this.cutoffMs,
      windowStartMs: this.windowStartMs, nextRefitMs: this.nextRefitMs,
      featureNames: this.candidate.kind === "trend" ? [...HOURLY_MODEL_SPEC.baseFeatures]
        : [...HOURLY_MODEL_SPEC.baseFeatures, ...HOURLY_MODEL_SPEC.recoveryInteractions],
      fits: [...this.fits.values()] });
  }
}
